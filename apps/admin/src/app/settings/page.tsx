'use client';

import type { GameSettingsView, StaffSettingsResponse } from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Field, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import {
  buildSettingValue,
  formFromSetting,
  parseJsonValue,
  SETTING_SPECS,
  type FormValues,
  type SettingSpec,
} from '@/lib/forms';
import { formatDateTime } from '@/lib/format';

type Saved = (changes: StaffSettingsResponse) => void;

/** What the market families setting holds (plan task 2.5). */
const MARKET_FAMILIES_HELP =
  'Margins of the factory markets in basis points (600 = 6%) per class (main, derivative, long) ' +
  'and per market type (typeMarginBps, e.g. "htft": 1400); the factory selections\' share of the ' +
  'selection liability cap (2500 = a quarter); and the weekly stakes (santim) a family needs ' +
  'before the weekly job judges its margin. Margins apply at the next re-price, the share at the next bet.';

function pick(settings: GameSettingsView, path: string): unknown {
  return (settings as unknown as Record<string, unknown>)[path];
}

function SettingForm({
  spec,
  current,
  canEdit,
  onSaved,
}: {
  spec: SettingSpec;
  current: unknown;
  canEdit: boolean;
  onSaved: Saved;
}) {
  const [form, setForm] = useState<FormValues>(() => formFromSetting(spec, current));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const built = buildSettingValue(spec, form);
    if (!built.ok) {
      setErrors(built.errors);
      setMessage(null);
      return;
    }
    setErrors({});
    try {
      const res = await api<StaffSettingsResponse>(`/admin/settings/${spec.key}`, {
        method: 'PUT',
        body: { value: built.value },
      });
      onSaved(res);
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    }
  }

  return (
    <form className="panel" onSubmit={save} aria-label={spec.title} style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0 }}>{spec.title}</h2>
      <div className="row">
        {spec.fields.map((f) => (
          <Field key={f.name} label={f.label}>
            {f.kind === 'bool' ? (
              <input
                type="checkbox"
                checked={form[f.name] === true}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.checked })}
              />
            ) : f.kind === 'select' ? (
              <select
                value={String(form[f.name])}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
              >
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={String(form[f.name])}
                disabled={!canEdit}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
              />
            )}
            {errors[f.name] !== undefined && <span className="notice error">{errors[f.name]}</span>}
          </Field>
        ))}
      </div>
      {canEdit && (
        <p>
          <button type="submit" className="primary">
            Save {spec.title.toLowerCase()}
          </button>
        </p>
      )}
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
    </form>
  );
}

/**
 * The multi-bonus ladder, the jackpot templates and the market families are nested: edited as
 * JSON, checked by the API.
 */
function JsonForm({
  title,
  settingKey,
  current,
  canEdit,
  onSaved,
  help,
}: {
  title: string;
  settingKey: 'multi_bonus' | 'jackpot_template' | 'market_families';
  current: unknown;
  /** One line under the title saying what the value means. */
  help?: string;
  canEdit: boolean;
  onSaved: Saved;
}) {
  const [text, setText] = useState(() => JSON.stringify(current, null, 2));
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = parseJsonValue(text);
    if (!parsed.ok) {
      setMessage({ kind: 'error', text: parsed.error });
      return;
    }
    try {
      const res = await api<StaffSettingsResponse>(`/admin/settings/${settingKey}`, {
        method: 'PUT',
        body: { value: parsed.value },
      });
      onSaved(res);
      setMessage({ kind: 'ok', text: 'Saved.' });
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    }
  }

  return (
    <form className="panel" onSubmit={save} aria-label={title} style={{ marginBottom: 12 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {help !== undefined && <p className="small">{help}</p>}
      <textarea
        value={text}
        readOnly={!canEdit}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${title} (JSON)`}
      />
      {canEdit && (
        <p>
          <button type="submit" className="primary">
            Save {title.toLowerCase()}
          </button>
        </p>
      )}
      {message !== null && <Notice kind={message.kind}>{message.text}</Notice>}
    </form>
  );
}

export default function SettingsPage() {
  const { can } = useSession();
  const canEdit = can('settings.edit');
  const { data, error, loading } = useFetch<StaffSettingsResponse>('/admin/settings');
  const [saved, setSaved] = useState<StaffSettingsResponse | null>(null);
  const current = saved ?? data;
  // A fresh key remounts the forms with the values the API stored.
  const version = saved === null ? 0 : saved.changes.map((c) => c.updatedAt).join('|');

  return (
    <>
      <PageHeader title="Settings" />
      {!canEdit && (
        <Notice kind="info">Your role can view the settings but not change them.</Notice>
      )}
      <Loading loading={loading && data === null} error={error} />
      {current !== null && (
        <div key={String(version)}>
          {SETTING_SPECS.map((spec) => (
            <SettingForm
              key={spec.key}
              spec={spec}
              current={pick(current.settings, spec.path)}
              canEdit={canEdit}
              onSaved={setSaved}
            />
          ))}
          <JsonForm
            title="Multi-bonus ladder"
            settingKey="multi_bonus"
            current={current.settings.multiBonus}
            canEdit={canEdit}
            onSaved={setSaved}
          />
          <JsonForm
            title="Market families"
            settingKey="market_families"
            current={current.settings.marketFamilies}
            canEdit={canEdit}
            onSaved={setSaved}
            help={MARKET_FAMILIES_HELP}
          />
          <JsonForm
            title="Jackpot template: daily 9"
            settingKey="jackpot_template"
            current={current.settings.jackpots.daily9}
            canEdit={canEdit}
            onSaved={setSaved}
          />
          <JsonForm
            title="Jackpot template: weekly 13"
            settingKey="jackpot_template"
            current={current.settings.jackpots.weekly13}
            canEdit={canEdit}
            onSaved={setSaved}
          />
          <h2>Last changes</h2>
          <ul className="small">
            {current.changes.map((c) => (
              <li key={c.key}>
                {c.key}: {formatDateTime(c.updatedAt)} by {c.updatedBy ?? 'system'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
