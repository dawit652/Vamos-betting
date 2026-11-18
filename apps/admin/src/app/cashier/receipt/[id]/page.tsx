'use client';

import type { CashReceiptResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { receiptClass, receiptTitle } from '@/lib/cashier';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

/** The printable receipt (or a copy of it, which is audited and counted). */
function Receipt() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const copy = search.get('copy') === '1';
  const print = copy || search.get('print') === '1';
  const [data, setData] = useState<CashReceiptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const printed = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice; a copy must be counted once.
    if (started.current) return;
    started.current = true;
    api<CashReceiptResponse>(
      `/admin/cashier/receipts/${id}${copy ? '/reprint' : ''}`,
      copy ? { method: 'POST', body: {} } : {},
    ).then(setData, (e: unknown) => setError(describeError(e)));
  }, [id, copy]);

  useEffect(() => {
    if (data === null || !print || printed.current) return;
    printed.current = true;
    // After the paint, so the dialog shows the receipt.
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [data, print]);

  if (data === null) return <Loading loading={error === null} error={error} />;
  const { operation, shop } = data.receipt;
  const deposit = operation.kind === 'deposit';
  return (
    <>
      <div className="no-print">
        <button type="button" className="primary" onClick={() => window.print()}>
          Print
        </button>{' '}
        <Link href="/cashier">Back to desk</Link>
      </div>
      <div className={receiptClass(shop.receiptWidthMm)} data-testid="receipt">
        <strong>{shop.name}</strong>
        <div>{shop.address}</div>
        <hr />
        {(copy || operation.reprints > 0) && <div className="receipt-copy">COPY</div>}
        <div>
          <strong>{receiptTitle(operation.kind)}</strong>
        </div>
        <div>Receipt {operation.reference}</div>
        <div>{formatDateTime(operation.createdAt)}</div>
        <div>Cashier: {data.receipt.staffName}</div>
        <div>
          Player: {data.receipt.playerName !== null ? `${data.receipt.playerName}, ` : ''}
          {data.receipt.playerPhone}
        </div>
        <div className="receipt-amount">{formatEtb(operation.amount)}</div>
        {deposit ? (
          <div>
            Credited to the player&apos;s account. Reference in their history: {operation.reference}
            .
          </div>
        ) : (
          <div>Player signature: ________</div>
        )}
      </div>
    </>
  );
}

export default function ReceiptPage() {
  return (
    <Suspense fallback={null}>
      <Receipt />
    </Suspense>
  );
}
