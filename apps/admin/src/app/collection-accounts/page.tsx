'use client';

import type {
  CollectionAccountListResponse,
  CollectionInstitutionView,
  StaffCollectionAccountView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

interface Feedback {
  message: string | null;
  error: string | null;
  /** Runs an API call and reports its outcome in the shared message / error lines. */
  run: (call: () => Promise<unknown>, done: string) => Promise<boolean>;
}

function AddForm({
  data,
  feedback,
  reload,
}: {
  data: CollectionAccountListResponse;
  feedback: Feedback;
  reload: () => void;
}) {
  const [institution, setInstitution] = useState('');
  const [number, setNumber] = useState('');
  // In licensed mode the holder must be the operator's legal name, so offer it.
  const [name, setName] = useState(data.requiredName ?? '');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const wallets = data.institutions.filter((i) => i.kind === 'wallet');
  const banks = data.institutions.filter((i) => i.kind === 'bank');
  const option = (i: CollectionInstitutionView) => (
    <option key={i.id} value={i.id}>
      {i.name}
    </option>
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await feedback.run(
      () =>
        api('/admin/collection-accounts', {
          method: 'POST',
          body: {
            institution,
            account: number.trim(),
            name: name.trim(),
            ...(hint.trim() === '' ? {} : { hint: hint.trim() }),
          },
        }),
      'Added: waiting for a second person’s approval.',
    );
    setBusy(false);
    if (ok) {
      setNumber('');
      setHint('');
      reload();
    }
  };
  return (
    <form
      className="card"
      autoComplete="off"
      aria-label="Add an account"
      data-testid="ca-add-form"
      onSubmit={(event) => void submit(event)}
    >
      <h2>Add account</h2>
      <div className="row">
        <Field label="Institution">
          <select
            data-testid="ca-institution"
            value={institution}
            required
            onChange={(e) => setInstitution(e.target.value)}
          >
            <option value="">Choose…</option>
            <optgroup label="Wallets">{wallets.map(option)}</optgroup>
            <optgroup label="Banks">{banks.map(option)}</optgroup>
          </select>
        </Field>
        <Field label="Account number">
          <input
            data-testid="ca-number"
            value={number}
            required
            inputMode="numeric"
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field label="Holder name">
          <input
            data-testid="ca-name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Hint (optional)">
          <input
            data-testid="ca-hint"
            value={hint}
            maxLength={120}
            onChange={(e) => setHint(e.target.value)}
          />
        </Field>
      </div>
      <p className="muted small">
        The holder name must be the operator’s legal name
        {data.requiredName === null ? '' : ` (${data.requiredName})`}. A second person approves the
        account before players see it.
      </p>
      <button
        type="submit"
        className="primary"
        data-testid="ca-add-submit"
        disabled={busy || institution === '' || number.trim() === '' || name.trim() === ''}
      >
        Add account
      </button>
    </form>
  );
}

function Who({ name, at }: { name: string | null; at: string | null }) {
  if (name === null && at === null) return <>–</>;
  return (
    <>
      {name ?? 'setting'}
      {at !== null && <div className="muted small">{formatDateTime(at)}</div>}
    </>
  );
}

function PendingRow({
  account,
  feedback,
  reload,
}: {
  account: StaffCollectionAccountView;
  feedback: Feedback;
  reload: () => void;
}) {
  const { can } = useSession();
  const decide = async (verb: 'approve' | 'reject') => {
    const ok = await feedback.run(
      () => api(`/admin/collection-accounts/${account.id}/${verb}`, { method: 'POST' }),
      verb === 'approve' ? 'Approved: players can now be shown it.' : 'Rejected.',
    );
    if (ok) reload();
  };
  return (
    <tr data-testid="ca-pending-row">
      <td>{account.institutionName}</td>
      <td>{account.account}</td>
      <td>{account.name}</td>
      <td>{account.hint ?? '–'}</td>
      <td>
        <Who name={account.createdByName} at={account.createdAt} />
      </td>
      <td>
        {can('withdrawals.approve') && (
          <div className="actions">
            <button
              type="button"
              className="primary"
              data-testid="ca-approve"
              onClick={() => void decide('approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              data-testid="ca-reject"
              onClick={() => void decide('reject')}
            >
              Reject
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function ActiveRow({
  account,
  isLast,
  feedback,
  reload,
}: {
  account: StaffCollectionAccountView;
  isLast: boolean;
  feedback: Feedback;
  reload: () => void;
}) {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [hint, setHint] = useState(account.hint ?? '');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await feedback.run(
      () =>
        api(`/admin/collection-accounts/${account.id}`, {
          method: 'PATCH',
          body: { name: name.trim(), hint: hint.trim() === '' ? null : hint.trim() },
        }),
      'Saved.',
    );
    if (ok) {
      setEditing(false);
      reload();
    }
  };
  const remove = async () => {
    const warning = isLast
      ? ' This is the last active account: SMS deposits will pause until another is approved.'
      : '';
    if (
      !window.confirm(
        `Delete ${account.institutionName} ${account.account}? Players will no longer be shown the account; money already sent to it is still credited.${warning}`,
      )
    ) {
      return;
    }
    const ok = await feedback.run(
      () => api(`/admin/collection-accounts/${account.id}`, { method: 'DELETE' }),
      'Deleted.',
    );
    if (ok) reload();
  };
  return (
    <tr data-testid="ca-active-row">
      <td>{account.institutionName}</td>
      <td>{account.account}</td>
      <td>
        {editing ? (
          <form className="inline-form" onSubmit={(event) => void save(event)}>
            <input
              aria-label="Holder name"
              data-testid="ca-edit-name"
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
            />
            <input
              aria-label="Hint"
              data-testid="ca-edit-hint"
              placeholder="Hint"
              value={hint}
              maxLength={120}
              onChange={(e) => setHint(e.target.value)}
            />
            <button type="submit" className="primary" data-testid="ca-edit-save">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            {account.name}
            <div className="muted small">{account.hint ?? ''}</div>
          </>
        )}
      </td>
      <td>
        <code className="small">{account.accountId}</code>
      </td>
      <td>
        <Who name={account.createdByName} at={account.createdAt} />
      </td>
      <td>
        <Who name={account.decidedByName} at={account.decidedAt} />
      </td>
      <td>
        {can('settings.edit') && !editing && (
          <div className="actions">
            <button type="button" data-testid="ca-edit" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="danger"
              data-testid="ca-delete"
              onClick={() => void remove()}
            >
              Delete
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * The bank and wallet accounts players send SMS-rail deposits to. A new account needs a second
 * person's approval before players see it; institution and number never change (add a new one
 * and delete the old).
 */
export default function CollectionAccountsPage() {
  const { can } = useSession();
  const { data, error, loading, reload } = useFetch<CollectionAccountListResponse>(
    '/admin/collection-accounts',
  );
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const feedback: Feedback = {
    message,
    error: actionError,
    run: async (call, done) => {
      setMessage(null);
      setActionError(null);
      try {
        await call();
        setMessage(done);
        return true;
      } catch (e) {
        setActionError(describeError(e));
        return false;
      }
    },
  };
  const of = (status: string) => data?.accounts.filter((a) => a.status === status) ?? [];
  const pending = of('pending');
  const active = of('active');
  const closed = data?.accounts.filter((a) => a.status === 'deleted' || a.status === 'rejected');
  return (
    <div data-testid="collection-accounts-page">
      <PageHeader title="Deposit accounts">
        <Link href="/sms">SMS rail</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {message !== null && (
        <div data-testid="ca-message">
          <Notice kind="ok">{message}</Notice>
        </div>
      )}
      {actionError !== null && (
        <div data-testid="ca-error">
          <Notice>{actionError}</Notice>
        </div>
      )}
      {data !== null && (
        <>
          {data.operatingMode === 'licensed' ? (
            <Notice kind="info">
              <span data-testid="ca-licensed">
                Licensed mode: players send real money to these accounts. Each one must be in the
                company’s legal name; personal accounts are not allowed.
                {data.requiredName === null &&
                  ' OPERATOR_LEGAL_NAME is not set on the server, so holder names are not checked automatically: check each one before approving it.'}
              </span>
            </Notice>
          ) : (
            <Notice kind="info">Demo mode: play money only.</Notice>
          )}
          {!data.railEnabled && (
            <Notice kind="info">
              The SMS rail is off (PAYMENT_PROVIDERS has no sms), so players are shown no account.
            </Notice>
          )}
          <h2>Waiting for approval</h2>
          <p className="muted small">
            A second person must approve a new account before players see it.
          </p>
          {pending.length === 0 ? (
            <p className="muted">Nothing waiting.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Number</th>
                    <th>Holder</th>
                    <th>Hint</th>
                    <th>Added by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pending.map((a) => (
                    <PendingRow key={a.id} account={a} feedback={feedback} reload={reload} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>Active accounts</h2>
          <p className="muted small">
            The rail id is what the collection handset’s SMS forwarder must name its account by.
          </p>
          {active.length === 0 ? (
            <p className="muted">No active account: SMS deposits are paused.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Number</th>
                    <th>Holder</th>
                    <th>Rail id</th>
                    <th>Added by</th>
                    <th>Approved by</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {active.map((a) => (
                    <ActiveRow
                      key={`${a.id}-${a.updatedAt}`}
                      account={a}
                      isLast={active.length === 1}
                      feedback={feedback}
                      reload={reload}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {can('settings.edit') && <AddForm data={data} feedback={feedback} reload={reload} />}

          <details>
            <summary>Deleted and rejected ({closed?.length ?? 0})</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Institution</th>
                    <th>Number</th>
                    <th>Holder</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {closed?.map((a) => (
                    <tr key={a.id}>
                      <td>{a.institutionName}</td>
                      <td>{a.account}</td>
                      <td>{a.name}</td>
                      <td>
                        <Badge value={a.status} />
                      </td>
                      <td>
                        {a.status === 'deleted' ? (
                          <Who name={null} at={a.deletedAt} />
                        ) : (
                          <Who name={a.decidedByName} at={a.decidedAt} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
