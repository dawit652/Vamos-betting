'use client';

import type { CashierDeskResponse, CashierShiftDetailResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ShiftReport } from '@/components/shift-report';
import { Loading, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { ApiClientError, describeError } from '@/lib/errors';

/**
 * The printable shift report (X while open, Z once closed). Staff without cashier.reports can
 * only read their own open shift, which the desk answer carries.
 */
export default function ShiftReportPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CashierShiftDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const printed = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const load = async () => {
      try {
        setData(await api<CashierShiftDetailResponse>(`/admin/cashier/shifts/${id}`));
      } catch (e) {
        if (!(e instanceof ApiClientError) || e.status !== 403) return setError(describeError(e));
        const desk = await api<CashierDeskResponse>('/admin/cashier/desk');
        if (desk.shift?.id === id) {
          setData({ shift: desk.shift, operations: desk.operations, variancePosting: null });
        } else setError('You can only print the report of your own open shift.');
      }
    };
    load().catch((e: unknown) => setError(describeError(e)));
  }, [id]);

  useEffect(() => {
    if (data === null || printed.current) return;
    printed.current = true;
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [data]);

  if (error !== null) return <Notice>{error}</Notice>;
  if (data === null) return <Loading loading error={null} />;
  return (
    <>
      <div className="no-print">
        <button type="button" className="primary" onClick={() => window.print()}>
          Print
        </button>{' '}
        <Link href="/cashier">Back to desk</Link>
      </div>
      <ShiftReport shift={data.shift} operations={data.operations} />
    </>
  );
}
