import { JackpotTemplateCodeSchema, type JackpotRoundView } from '@vamos/contracts';
import {
  createJackpotRound,
  listJackpotCandidateEvents,
  loadGameSettings,
  shrinkJackpotTemplate,
  withTxRetry,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { conflict, parseInput } from '../../lib/errors';
import { jackpotRoundView } from './views';

/**
 * Dev-only body of POST /dev/jackpots/rounds (no public contract):
 * - template: whose price and prizes the round copies (default daily9);
 * - games: how many games (default 3; the template's prize tiers keep their
 *   distance from "every game correct", see shrinkJackpotTemplate);
 * - leadSeconds: only events kicking off more than this after now (default
 *   30 s, time to place an entry before the round closes).
 */
export const DevJackpotRoundRequest = z.object({
  template: JackpotTemplateCodeSchema.default('daily9'),
  games: z.number().int().min(1).max(13).default(3),
  leadSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600)
    .default(30),
});
export type DevJackpotRoundRequest = z.infer<typeof DevJackpotRoundRequest>;

/**
 * The dev jackpot tools exist only for local development, tests and e2e:
 * demo mode (play money) and NODE_ENV other than production, like the
 * other /dev routes. A public deployment (production) never has them, and
 * licensed mode never does.
 */
export function devJackpotsEnabled(deps: Pick<AppDeps, 'config'>): boolean {
  return deps.config.mode === 'demo' && deps.config.nodeEnv !== 'production';
}

/**
 * DEV ONLY – not part of the product.
 *
 * POST /dev/jackpots/rounds opens a small jackpot round right away on the
 * next scheduled football events (soonest kick-off first, with an open 1X2
 * market, not used by another unsettled round of the template), so e2e
 * tests and local demos get a round that closes and settles within
 * minutes on the fast simulator. The round copies the template's price and
 * prizes on fewer games and freezes the winnings tax in force, like a
 * worker round; entries, closing and settlement are the real ones. 201
 * with the JackpotRoundView; 409 `not_enough_events` when there are too
 * few upcoming events (details { available, needed }).
 */
export default async function devJackpotRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!devJackpotsEnabled(deps)) return;

  app.post('/dev/jackpots/rounds', async (request, reply): Promise<JackpotRoundView> => {
    const input = parseInput(DevJackpotRoundRequest, request.body ?? {});
    const now = deps.clock();
    const round = await withTxRetry(deps.db, async (tx) => {
      const settings = await loadGameSettings(tx);
      const base = settings.jackpots[input.template];
      const games = Math.min(input.games, base.gameCount);
      const template = { ...shrinkJackpotTemplate(base, games), enabled: true };
      const candidates = await listJackpotCandidateEvents(tx, {
        templateCode: template.code,
        now,
        leadMs: input.leadSeconds * 1000,
        limit: games,
      });
      if (candidates.length < games) {
        throw conflict('not_enough_events', 'Not enough upcoming football events for a round.', {
          available: candidates.length,
          needed: games,
        });
      }
      return createJackpotRound(tx, {
        template,
        tax: settings.tax,
        eventIds: candidates.map((candidate) => candidate.eventId),
        now,
      });
    });
    void reply.status(201);
    return jackpotRoundView(round);
  });
}
