'use client';

import type { CashReceiptPrintResponse, CashReceiptResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { receiptClass, receiptTitle } from '@/lib/forms';
import { TEXT } from '@/lib/text';

/**
 * The printable receipt. The original is printed once (the server records it): opening the page to
 * print asks the server whether this print is the original or a copy; every later print, also with
 * the Print button, is a counted copy that says COPY.
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
    const base = `/shop/desk/receipts/${id}`;
    if (copy) {
      api<CashReceiptResponse>(`${base}/reprint`, { method: 'POST', body: {} }).then(
        setData,
        (e: unknown) => setError(describeError(e)),
      );
    } else if (print) {
      api<CashReceiptPrintResponse>(`${base}/print`, { method: 'POST', body: {} }).then(
        (res) => {
          setIsCopy(res.copy);
          setData({ receipt: res.receipt });
        },
        (e: unknown) => setError(describeError(e)),
      );
    } else {
      api<CashReceiptResponse>(base).then(
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
  async function printAgain() {
    try {
      const res = await api<CashReceiptPrintResponse>(`/shop/desk/receipts/${id}/print`, {
        method: 'POST',
        body: {},
      });
      setIsCopy(res.copy);
      setData({ receipt: res.receipt });
      setTimeout(() => window.print(), 100);
    } catch (e) {
      setError(describeError(e));
    }
  }

  useEffect(() => {
    if (data === null || !print || printed.current) return;
    printed.current = true;
    // After the paint, so the dialog shows the receipt.
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [data, print]);

  if (data === null) {
    return (
      <div className="card">
        {error === null ? (
          <p className="muted" role="status">
            {TEXT.loading}
          </p>
        ) : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  const { operation, shop } = data.receipt;
  return (
    <div data-testid="receipt-page">
      <div className="no-print">
        <button
          type="button"
          className="primary"
          data-testid="receipt-print"
          onClick={() => void printAgain()}
        >
          {TEXT.receiptPrint}
        </button>{' '}
        <Link href="/">{TEXT.receiptBack}</Link>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={receiptClass(shop.receiptWidthMm)} data-testid="receipt">
        <strong>{shop.name}</strong>
        <div>
          {TEXT.receiptShop} {shop.label}
        </div>
        <div>{shop.address}</div>
        <hr />
        {isCopy && (
          <div className="receipt-copy" data-testid="receipt-copy-badge">
            {TEXT.receiptCopy}
          </div>
        )}
        <div>
          <strong>{receiptTitle(operation.kind)}</strong>
        </div>
        <div>
          {TEXT.receiptNo} {operation.reference}
        </div>
        <div>{formatDateTime(operation.createdAt)}</div>
        <div>
          {TEXT.receiptCashier}: {data.receipt.staffName}
        </div>
        <div>
          {TEXT.receiptPlayer}:{' '}
          {data.receipt.playerName !== null ? `${data.receipt.playerName}, ` : ''}
          {data.receipt.playerPhone}
        </div>
        <div className="receipt-amount">{formatEtb(operation.amount)}</div>
        {operation.kind === 'deposit' ? (
          <div>
            {TEXT.receiptCredited} {operation.reference}.
          </div>
        ) : (
          <div>{TEXT.receiptSignature}</div>
        )}
      </div>
    </div>
  );
}

export default function ReceiptPage() {
  return (
    <Suspense fallback={null}>
      <Receipt />
    </Suspense>
  );
}
