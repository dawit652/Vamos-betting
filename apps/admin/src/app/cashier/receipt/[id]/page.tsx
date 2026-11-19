'use client';

import type { CashReceiptPrintResponse, CashReceiptResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { receiptClass, receiptTitle } from '@/lib/cashier';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

/**
 * The printable receipt. The original is printed once (the server records it): opening the page to
 * print asks the server, which answers whether this print is the original or a copy; every later
 * print, also with the Print button, is a copy that says COPY and is counted and audited.
 */
function Receipt() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const copy = search.get('copy') === '1';
  const print = copy || search.get('print') === '1';
  const [data, setData] = useState<CashReceiptResponse | null>(null);
  const [isCopy, setIsCopy] = useState(copy);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const printed = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice; a print must be counted once.
    if (started.current) return;
    started.current = true;
    if (copy) {
      api<CashReceiptResponse>(`/admin/cashier/receipts/${id}/reprint`, {
        method: 'POST',
        body: {},
      }).then(setData, (e: unknown) => setError(describeError(e)));
    } else if (print) {
      api<CashReceiptPrintResponse>(`/admin/cashier/receipts/${id}/print`, {
        method: 'POST',
        body: {},
      }).then(
        (res) => {
          setIsCopy(res.copy);
          setData({ receipt: res.receipt });
        },
        (e: unknown) => setError(describeError(e)),
      );
    } else {
      api<CashReceiptResponse>(`/admin/cashier/receipts/${id}`).then(
        (res) => {
          setIsCopy(res.receipt.operation.originalPrintedAt !== null);
          setData(res);
        },
        (e: unknown) => setError(describeError(e)),
      );
    }
  }, [id, copy, print]);

  // Once the original has been through the print dialog, anything printed again is a copy.
  useEffect(() => {
    const after = () => setIsCopy(true);
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  /** The Print button: the original if never printed, else a counted copy. */
  const printAgain = async () => {
    try {
      const res = await api<CashReceiptPrintResponse>(`/admin/cashier/receipts/${id}/print`, {
        method: 'POST',
        body: {},
      });
      setIsCopy(res.copy);
      setData({ receipt: res.receipt });
      setTimeout(() => window.print(), 100);
    } catch (e) {
      setError(describeError(e));
    }
  };

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
        <button type="button" className="primary" onClick={() => void printAgain()}>
          Print
        </button>{' '}
        <Link href="/cashier">Back to desk</Link>
      </div>
      <div className={receiptClass(shop.receiptWidthMm)} data-testid="receipt">
        <strong>{shop.name}</strong>
        <div>Shop {shop.label}</div>
        <div>{shop.address}</div>
        <hr />
        {isCopy && <div className="receipt-copy">COPY</div>}
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
