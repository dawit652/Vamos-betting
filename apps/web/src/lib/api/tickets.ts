import type { PublicTicketStatusResponse } from '@vamos/contracts';
import { api } from './client';

/** The public check of a shop ticket (no login): its state, amount and shop, never its code. */
export const ticketsApi = {
  status: (number: string) =>
    api.get<PublicTicketStatusResponse>(`/tickets/${encodeURIComponent(number)}`),
};
