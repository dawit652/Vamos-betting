import 'server-only';
import type {
  JackpotListResponse,
  JackpotTemplateCode,
  PromotionsResponse,
} from '@vamos/contracts';
import { serverGet } from './server';

/** Public jackpot data for server components (the jackpot page). */

export function getJackpots(template: JackpotTemplateCode): Promise<JackpotListResponse> {
  return serverGet<JackpotListResponse>('/jackpots', { query: { template, limit: 5 } });
}

export function getPromotions(): Promise<PromotionsResponse> {
  return serverGet<PromotionsResponse>('/promotions');
}
