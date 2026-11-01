import type { ScrapePricingSource } from '@vamos/core';
import { asc, eq, sql } from 'drizzle-orm';
import { domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { competitions } from '../schema/catalog';
import { scrapeCompetitionPolicy } from '../schema/scrape';
import { actorLabel, auditScrape, type ScrapeActor } from './common';

/** The flags of a competition policy (structurally CompetitionPolicy in @vamos/scraper). */
export interface CompetitionPolicy {
  competitionId: string;
  /** Kill switch (S4): off, the scraper creates, moves and applies nothing here; it only observes and raises items. */
  enabled: boolean;
  autoOpen: boolean;
  /** Apply agreed final scores without a person; ignored while `enabled` is off or `extraTime` is on. */
  autoResults: boolean;
  /** Knockout competition: a score is never applied automatically, a person confirms it. */
  extraTime: boolean;
  /** Where prices come from: the team-rating model (default) or a licensed bookmaker-odds feed first (rule O4). */
  pricingSource: ScrapePricingSource;
}

export type CompetitionPolicyFlags = Omit<CompetitionPolicy, 'competitionId'>;

export interface CompetitionPolicyRow extends CompetitionPolicy {
  /** false = no row yet (all flags off). */
  configured: boolean;
  slug: string;
  name: { en: string; am?: string; om?: string; ti?: string };
  sportId: string;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const OFF: CompetitionPolicyFlags = {
  enabled: false,
  autoOpen: false,
  autoResults: false,
  extraTime: false,
  pricingSource: 'model',
};

/** The stored text as a pricing source; anything but 'market' is the model (fail closed to the default). */
function pricingSourceOf(value: string | null | undefined): ScrapePricingSource {
  return value === 'market' ? 'market' : 'model';
}

/** The policy of a competition; a competition without a row is entirely off (fail closed). */
export async function getCompetitionPolicy(
  exec: DbExecutor,
  competitionId: string,
): Promise<CompetitionPolicy> {
  const [row] = await exec
    .select({
      enabled: scrapeCompetitionPolicy.enabled,
      autoOpen: scrapeCompetitionPolicy.autoOpen,
      autoResults: scrapeCompetitionPolicy.autoResults,
      extraTime: scrapeCompetitionPolicy.extraTime,
      pricingSource: scrapeCompetitionPolicy.pricingSource,
    })
    .from(scrapeCompetitionPolicy)
    .where(eq(scrapeCompetitionPolicy.competitionId, competitionId));
  return {
    competitionId,
    ...(row === undefined ? OFF : { ...row, pricingSource: pricingSourceOf(row.pricingSource) }),
  };
}

/** Every competition (of the scraper's sports if `sportId` is given) with its policy, for the back office. */
export async function listCompetitionPolicies(
  exec: DbExecutor,
  options: { sportId?: string } = {},
): Promise<CompetitionPolicyRow[]> {
  const rows = await exec
    .select({
      competitionId: competitions.id,
      slug: competitions.slug,
      name: competitions.name,
      sportId: competitions.sportId,
      policy: scrapeCompetitionPolicy,
    })
    .from(competitions)
    .leftJoin(scrapeCompetitionPolicy, eq(scrapeCompetitionPolicy.competitionId, competitions.id))
    .where(options.sportId === undefined ? undefined : eq(competitions.sportId, options.sportId))
    .orderBy(asc(competitions.sportId), asc(competitions.slug));
  return rows.map((row) => ({
    competitionId: row.competitionId,
    slug: row.slug,
    name: row.name,
    sportId: row.sportId,
    configured: row.policy !== null,
    enabled: row.policy?.enabled ?? false,
    autoOpen: row.policy?.autoOpen ?? false,
    autoResults: row.policy?.autoResults ?? false,
    extraTime: row.policy?.extraTime ?? false,
    pricingSource: pricingSourceOf(row.policy?.pricingSource),
    updatedAt: row.policy?.updatedAt ?? null,
    updatedBy: row.policy?.updatedBy ?? null,
  }));
}

/**
 * Changes some flags of a competition's policy (the others keep their value;
 * a missing row starts from all-off), audited with before and after. The row
 * is locked so concurrent edits do not lose each other's flags. A patch that
 * changes nothing writes nothing.
 */
export async function setCompetitionPolicy(
  tx: DbTransaction,
  competitionId: string,
  patch: Partial<CompetitionPolicyFlags>,
  actor: ScrapeActor,
): Promise<CompetitionPolicy> {
  const [competition] = await tx
    .select({ id: competitions.id })
    .from(competitions)
    .where(eq(competitions.id, competitionId));
  if (competition === undefined) throw domainNotFound('competition');
  await tx
    .insert(scrapeCompetitionPolicy)
    .values({ competitionId, updatedBy: actorLabel(actor) })
    .onConflictDoNothing();
  const [current] = await tx
    .select()
    .from(scrapeCompetitionPolicy)
    .where(eq(scrapeCompetitionPolicy.competitionId, competitionId))
    .for('update');
  const before: CompetitionPolicyFlags = {
    enabled: current!.enabled,
    autoOpen: current!.autoOpen,
    autoResults: current!.autoResults,
    extraTime: current!.extraTime,
    pricingSource: pricingSourceOf(current!.pricingSource),
  };
  const after: CompetitionPolicyFlags = {
    enabled: patch.enabled ?? before.enabled,
    autoOpen: patch.autoOpen ?? before.autoOpen,
    autoResults: patch.autoResults ?? before.autoResults,
    extraTime: patch.extraTime ?? before.extraTime,
    pricingSource: patch.pricingSource ?? before.pricingSource,
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await tx
      .update(scrapeCompetitionPolicy)
      .set({ ...after, updatedAt: sql`now()`, updatedBy: actorLabel(actor) })
      .where(eq(scrapeCompetitionPolicy.competitionId, competitionId));
    await auditScrape(tx, actor, {
      action: 'scrape.policy.updated',
      targetType: 'competition',
      targetId: competitionId,
      metadata: { before, after },
    });
  }
  return { competitionId, ...after };
}
