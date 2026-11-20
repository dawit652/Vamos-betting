'use client';

import type { CashierDeskResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useFetch } from '@/components/hooks';
import { Loading } from '@/components/ui';
import { receiptClass } from '@/lib/cashier';
import { formatDateTime } from '@/lib/format';

/**
 * A test page for the receipt printer: the receipt layout at the shop's paper width, marked as a
 * test. It writes nothing (no receipt, no ledger entry), so it can be printed as often as needed.
 */
export default function TestPrintPage() {
  const { data, error, loading } = useFetch<CashierDeskResponse>('/admin/cashier/desk');
  if (data === null) return <Loading loading={loading} error={error} />;
  const shop = data.shops.find((s) => s.id === data.shift?.shopId) ?? data.shops[0];
  const width = shop?.receiptWidthMm ?? 80;
  return (
    <>
      <div className="no-print">
        <button type="button" className="primary" onClick={() => window.print()}>
          Print test receipt
        </button>{' '}
        <Link href="/cashier">Back to desk</Link>
        <p className="muted small">
          Paper {width} mm. In the print dialog choose the receipt printer, paper size or roll{' '}
          {width} mm, margins None, and scale 100%. Nothing is saved by this test.
        </p>
      </div>
      <div className={receiptClass(width)} data-testid="test-receipt">
        <strong>{shop?.name ?? 'Nahubet'}</strong>
        <div>{shop?.address ?? ''}</div>
        <hr />
        <div className="receipt-copy">TEST PRINT</div>
        <div>Not a receipt. No money moved.</div>
        <div>{formatDateTime(new Date().toISOString())}</div>
        <div>Paper width {width} mm</div>
        <div>0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ</div>
        <hr />
        <div>If every line above is complete, the printer is ready.</div>
      </div>
    </>
  );
}
