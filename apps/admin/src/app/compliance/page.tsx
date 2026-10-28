import { redirect } from 'next/navigation';

/** The compliance section starts at the reconciliation runs. */
export default function CompliancePage(): never {
  redirect('/compliance/reconciliation');
}
