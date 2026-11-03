import {
  FeedResultActionRequest,
  FeedReviewListResponse,
  FeedStatusResponse,
  ResultEventResponse,
  UpdateFeedLeagueRequest,
  UpdateFeedLeagueResponse,
} from '@vamos/contracts';
import {
  FEED_PROVIDER,
  feedCreditsSpent,
  latestFeedQuota,
  listFeedLeagues,
  listFeedReviewQueue,
  staffAcceptFeedResult,
  staffUpdateFeedLeague,
  staffVoidFeedResult,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { inTx, parseUuid, publishLive, wire } from './common';

const DAY_MS = 86_400_000;

/**
 * The real-odds feed (trading.view / feed.manage / trading.result): provider
 * credits and leagues, and the review queue of results staff confirm. Every
 * change is audited with the staff actor in its transaction; results go
 * through the audited trading service, so the worker settles the bets.
 */
export default async function adminFeedRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/feed', { config: { staff: 'trading.view' } }, async () => {
    const now = deps.clock();
    const [quota, creditsLast24h, creditsLast30d, leagues] = await Promise.all([
      latestFeedQuota(deps.db, FEED_PROVIDER),
      feedCreditsSpent(deps.db, FEED_PROVIDER, new Date(now.getTime() - DAY_MS)),
      feedCreditsSpent(deps.db, FEED_PROVIDER, new Date(now.getTime() - 30 * DAY_MS)),
      listFeedLeagues(deps.db, FEED_PROVIDER),
    ]);
    return wire(FeedStatusResponse, {
      provider: FEED_PROVIDER,
      quota,
      creditsLast24h,
      creditsLast30d,
      leagues,
    });
  });

  app.patch<{ Params: { sportKey: string } }>(
    '/admin/feed/leagues/:sportKey',
    { config: { staff: 'feed.manage' } },
    async (request) => {
      const input = parseInput(UpdateFeedLeagueRequest, request.body);
      const actor = staffActor(request);
      const league = await inTx(deps, (tx) =>
        staffUpdateFeedLeague(tx, {
          sportKey: request.params.sportKey,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.marginBps === undefined ? {} : { marginBps: input.marginBps }),
          actor,
        }),
      );
      if (league === null) throw notFound('League');
      return wire(UpdateFeedLeagueResponse, { league });
    },
  );

  app.get('/admin/feed/results', { config: { staff: 'trading.view' } }, async () =>
    wire(FeedReviewListResponse, { items: await listFeedReviewQueue(deps.db, FEED_PROVIDER) }),
  );

  for (const [path, decide] of [
    ['accept', staffAcceptFeedResult],
    ['void', staffVoidFeedResult],
  ] as const) {
    app.post<{ Params: { eventId: string } }>(
      `/admin/feed/results/:eventId/${path}`,
      { config: { staff: 'trading.result' } },
      async (request) => {
        const eventId = parseUuid(request.params.eventId, 'Feed result');
        const input = parseInput(FeedResultActionRequest, request.body ?? {});
        const actor = staffActor(request);
        const now = deps.clock();
        const outcome = await inTx(deps, (tx) =>
          decide(tx, {
            eventId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            actor,
            now,
          }),
        );
        await publishLive(app, outcome.messages);
        return wire(ResultEventResponse, outcome);
      },
    );
  }
}
