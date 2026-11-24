'use client';

import { formatEtb } from '@/lib/format';
import { TEXT } from '@/lib/text';
import { topUpState } from '@/lib/topup';

/**
 * The agent's top-up balance at the top of the desk and the Sell page (owner, 24 Nov 2026): how
 * much is left for tickets and deposits, and, when it runs low or out, that the cashier tells the
 * agent owner to top up at Nahubet HQ. Nothing at HQ's own shops.
 */
export function TopUpCard({
  balance,
  lowAt,
}: {
  balance: string | null;
  lowAt: string | null | undefined;
}) {
  const state = topUpState(balance, lowAt ?? null);
  if (state === null || balance === null) return null;
  return (
    <section
      className={`card topup topup-${state} no-print`}
      aria-labelledby="topup-title"
      data-testid="topup-card"
      data-state={state}
    >
      <div className="topup-head">
        <h2 id="topup-title">{TEXT.topUpTitle}</h2>
        <strong className="topup-amount" data-testid="topup-balance">
          {formatEtb(balance)}
        </strong>
      </div>
      {state === 'empty' ? (
        <p className="error" role="alert" data-testid="topup-empty">
          {TEXT.topUpEmpty}
        </p>
      ) : state === 'low' ? (
        <p className="topup-warning" role="status" data-testid="topup-low">
          {TEXT.topUpLow}
        </p>
      ) : (
        <p className="muted small">{TEXT.topUpNote}</p>
      )}
    </section>
  );
}
