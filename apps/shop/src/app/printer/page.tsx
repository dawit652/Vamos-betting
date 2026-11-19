'use client';

import { useSession } from '@/components/session';
import { receiptClass } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';
import { paperWidthLabel, TEXT } from '@/lib/text';

/**
 * The receipt printer guide and a test print: the receipt layout at the shop's paper width,
 * marked as a test. It writes nothing (no receipt, no ledger entry), so it can be printed as
 * often as needed.
 */
export default function PrinterPage() {
  const { session } = useSession();
  if (session === null) return null;
  const { shop } = session;
  const width = shop.receiptWidthMm;
  return (
    <>
      <div className="card no-print">
        <h1>{TEXT.printerTitle}</h1>
        <ol>
          {TEXT.printerGuide.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <p>
          {TEXT.printerWidth}: <strong>{width} mm</strong>
        </p>
        <button type="button" className="primary" onClick={() => window.print()}>
          {TEXT.printTest}
        </button>
        <p className="muted small">{TEXT.testPrintNote}</p>
      </div>
      <div className={receiptClass(width)} data-testid="test-receipt">
        <div className="receipt-copy">{TEXT.testReceiptTitle}</div>
        <strong>
          {shop.label} · {shop.name}
        </strong>
        <div>{shop.address}</div>
        <hr />
        <div>{formatDateTime(new Date().toISOString())}</div>
        <div>{paperWidthLabel(width)}</div>
        <div>{TEXT.testReceiptChars}</div>
        <div>{TEXT.testReceiptAmharic}</div>
        <hr />
        <div>{TEXT.testReceiptFooter}</div>
      </div>
    </>
  );
}
