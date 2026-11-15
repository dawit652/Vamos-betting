'use client';

import type { RatingRow, RatingsResponse, SetRatingsResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  backfillCommand,
  confirmRatingsText,
  ratingsQuery,
  ratingsText,
  validateRatingsForm,
} from '@/lib/ratings';

function EditForm({
  row,
  band,
  onDone,
}: {
  row: RatingRow;
  band: { min: number; max: number };
  onDone: () => void;
}) {
  const [attack, setAttack] = useState(row.attack?.toString() ?? '1');
  const [defence, setDefence] = useState(row.defence?.toString() ?? '1');
  const [matches, setMatches] = useState('');
  const [confirming, setConfirming] = useState<ReturnType<typeof validateRatingsForm> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = () => {
    const result = validateRatingsForm({ attack, defence, matches }, band);
    if (!result.ok) {
      setError(result.error);
      setConfirming(null);
      return;
    }
    setError(null);
    setConfirming(result);
  };
  return (
    <div className="card">
      <h3>Set {row.team} by hand</h3>
      <p className="muted small">
        Now: {ratingsText(row)}
        {row.manual ? ' (manual)' : ''}. Values between {band.min} and {band.max}; 1 is the league
        average.
      </p>
      <div className="row">
        <Field label="Attack">
          <input value={attack} onChange={(e) => setAttack(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Defence">
          <input value={defence} onChange={(e) => setDefence(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Matches (optional)">
          <input
            value={matches}
            onChange={(e) => setMatches(e.target.value)}
            inputMode="numeric"
            placeholder="keep"
          />
        </Field>
      </div>
      {error !== null && <Notice>{error}</Notice>}
      {confirming !== null && confirming.ok ? (
        <div>
          <Notice kind="info">{confirmRatingsText(row, confirming.body)}</Notice>
          <ActionButton
            primary
            label="Confirm and save"
            onAction={async () => {
              await api<SetRatingsResponse>(`/admin/feed/ratings/${row.teamId}`, {
                method: 'PUT',
                body: confirming.body,
              });
              onDone();
            }}
          />
          <button type="button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="primary" onClick={check}>
          Review change
        </button>
      )}
    </div>
  );
}

export default function RatingsPage() {
  const { can } = useSession();
  const [team, setTeam] = useState('');
  const [unrated, setUnrated] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [saved, setSaved] = useState(false);
  const list = useFetch<RatingsResponse>('/admin/feed/ratings', ratingsQuery(team, unrated));
  const data = list.data;
  const canEdit = can('trading.odds');
  const editRow = data?.teams.find((t) => t.teamId === editing) ?? null;

  return (
    <>
      <PageHeader title="Team ratings">
        <Link href="/feed">Back to feed</Link>
      </PageHeader>
      <p className="muted small">
        Football teams the prices are learned from. A team with fewer than {data?.minMatches ?? 8}{' '}
        learned matches keeps its matches closed unless a trader sets it by hand.
      </p>
      <div className="row">
        <Field label="Team">
          <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="name" />
        </Field>
        <label>
          <input type="checkbox" checked={unrated} onChange={(e) => setUnrated(e.target.checked)} />{' '}
          Unrated only (teams of upcoming matches)
        </label>
      </div>
      {saved && <Notice kind="ok">Saved.</Notice>}
      <Loading loading={list.loading && data === null} error={list.error} />
      {editRow !== null && data !== null && canEdit && (
        <EditForm
          key={editRow.teamId}
          row={editRow}
          band={data}
          onDone={() => {
            setEditing(null);
            setSaved(true);
            list.reload();
          }}
        />
      )}
      {data !== null && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Attack</th>
                  <th>Defence</th>
                  <th>Matches</th>
                  <th>Status</th>
                  {unrated && <th>Upcoming</th>}
                  {unrated && <th>Next kickoff</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.teams.map((t) => (
                  <tr key={t.teamId}>
                    <td>{t.team}</td>
                    <td>{t.attack?.toFixed(3) ?? '–'}</td>
                    <td>{t.defence?.toFixed(3) ?? '–'}</td>
                    <td>{t.matches}</td>
                    <td>
                      {t.manual ? (
                        <Badge value="manual" tone="good" />
                      ) : t.matches >= data.minMatches ? (
                        <Badge value="learned" tone="good" />
                      ) : (
                        <Badge value="uncalibrated" tone="warn" />
                      )}
                    </td>
                    {unrated && <td>{t.upcoming ?? '–'}</td>}
                    {unrated && (
                      <td>{t.nextKickoff === null ? '–' : formatDateTime(t.nextKickoff)}</td>
                    )}
                    <td>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => {
                            setSaved(false);
                            setEditing(t.teamId);
                          }}
                        >
                          Set by hand
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.teams.length === 0 && <p className="muted">No teams.</p>}
          {data.truncated && (
            <p className="muted small">Showing the first {data.teams.length}; narrow the filter.</p>
          )}
        </>
      )}
      <h2>Backfill from results</h2>
      <p className="muted small">
        Backfilling learns ratings from a file of finished matches. It runs on the server, not from
        this page: put <code>results.json</code> in the current directory and run the command below.
        It prints before and after and writes nothing with <code>--dry-run</code>; drop that flag to
        apply. It refuses teams set by hand.
      </p>
      <Field label="Competition slug">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="costa-rica-primera-division"
        />
      </Field>
      <pre>
        <code>{backfillCommand(slug)}</code>
      </pre>
    </>
  );
}
