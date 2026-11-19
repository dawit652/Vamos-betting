'use client';

import type {
  AgentCommissionKind,
  AgentDetailResponse,
  AgentOwnerAccountView,
  AgentView,
  CashierShopView,
  CreateAgentOwnerResponse,
  ShopDeviceView,
  UpdateAgentRequest,
} from '@vamos/contracts';
import { formatBpsPercent, parsePercentBps } from '@vamos/core';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { StaffSecret } from '@/components/staff-secret';
import { Badge, DefList, Field, Loading, Notice, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import {
  COMMISSION_KIND_LABELS,
  PERCENT_HINT,
  commissionText,
  localPhone,
  sortShops,
} from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, parseEtbToSantim } from '@/lib/format';

function StatusBadge({ agent }: { agent: AgentView }) {
  return agent.status === 'active' ? (
    <Badge value="Active" tone="good" />
  ) : (
    <Badge value="Blocked" tone="bad" />
  );
}

function EditAgent({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const [name, setName] = useState(agent.name);
  const [ownerName, setOwnerName] = useState(agent.ownerName);
  const [ownerPhone, setOwnerPhone] = useState(agent.ownerPhone);
  const [kind, setKind] = useState<AgentCommissionKind>(agent.commissionKind);
  const [percent, setPercent] = useState(formatBpsPercent(agent.commissionBps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Only what changed goes to the API; HQ only ever sends its name.
    const body: UpdateAgentRequest = {};
    if (name.trim() !== agent.name) body.name = name.trim();
    if (!agent.isHouse) {
      if (ownerName.trim() !== agent.ownerName) body.ownerName = ownerName.trim();
      if (ownerPhone.trim() !== agent.ownerPhone) body.ownerPhone = ownerPhone.trim();
      if (kind !== agent.commissionKind) body.commissionKind = kind;
      const bps = parsePercentBps(percent);
      if (bps === null) return setError(PERCENT_HINT);
      if (bps !== agent.commissionBps) body.commissionBps = bps;
    }
    if (Object.keys(body).length === 0) return setError('Nothing was changed.');
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/admin/agents/${agent.id}`, { method: 'PATCH', body });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" autoComplete="off" aria-label="Edit agent" onSubmit={submit}>
      <h2>Edit agent</h2>
      <div className="row">
        <Field label="Agent name">
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!agent.isHouse && (
          <>
            <Field label="Owner's full name">
              <input
                required
                maxLength={100}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
              />
            </Field>
            <Field label="Owner's phone">
              <input
                required
                type="tel"
                placeholder="09… or 07…"
                maxLength={32}
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
              />
            </Field>
            <Field label="Commission based on">
              <select value={kind} onChange={(e) => setKind(e.target.value as AgentCommissionKind)}>
                <option value="ggr">{COMMISSION_KIND_LABELS.ggr}</option>
                <option value="stake">{COMMISSION_KIND_LABELS.stake}</option>
              </select>
            </Field>
            <Field label="Commission percent">
              <input
                required
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
      {saved && <Notice kind="ok">Saved.</Notice>}
      {error !== null && <Notice>{error}</Notice>}
      <p>
        <button type="submit" disabled={busy}>
          Save changes
        </button>
      </p>
    </form>
  );
}

function AddShop({ agentId, onAdded }: { agentId: string; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [width, setWidth] = useState<58 | 80>(80);
  const [threshold, setThreshold] = useState('10000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const approvalThreshold = parseEtbToSantim(threshold);
    if (approvalThreshold === null || approvalThreshold === '0') {
      return setError('Enter the supervisor limit in ETB, above zero.');
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/agents/${agentId}/shops`, {
        method: 'POST',
        body: {
          name: name.trim(),
          address: address.trim(),
          receiptWidthMm: width,
          approvalThreshold,
        },
      });
      setName('');
      setAddress('');
      onAdded();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" autoComplete="off" aria-label="Add a shop" onSubmit={submit}>
      <h2>Add a shop</h2>
      <div className="row">
        <Field label="Shop name">
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Address">
          <input maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Paper width">
          <select value={width} onChange={(e) => setWidth(e.target.value === '58' ? 58 : 80)}>
            <option value={80}>80 mm</option>
            <option value={58}>58 mm</option>
          </select>
        </Field>
        <Field label="Needs a supervisor above (ETB)">
          <input
            required
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>
      </div>
      {error !== null && <Notice>{error}</Notice>}
      <p>
        <button type="submit" className="primary" disabled={busy}>
          Add shop
        </button>
      </p>
    </form>
  );
}

function ToggleShop({ shop, onDone }: { shop: CashierShopView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    const question = shop.active
      ? `Close shop ${shop.label} ${shop.name}? Its cashiers cannot open a shift.`
      : `Reopen shop ${shop.label} ${shop.name}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/cashier/shops/${shop.id}`, {
        method: 'PUT',
        body: {
          name: shop.name,
          address: shop.address,
          receiptWidthMm: shop.receiptWidthMm,
          approvalThreshold: shop.approvalThreshold,
          active: !shop.active,
        },
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void toggle()}>
        {shop.active ? 'Close shop' : 'Reopen shop'}
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </>
  );
}

/**
 * The agent owner's account (one per agent). An owner works in the shop app only; the password
 * made here is shown once and stops working after 72 hours unless it is replaced at first sign-in.
 */
function OwnerAccount({
  agent,
  owner,
  manage,
  onChanged,
}: {
  agent: AgentView;
  owner: AgentOwnerAccountView | null;
  manage: boolean;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateAgentOwnerResponse | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api<CreateAgentOwnerResponse>(
        `/admin/agents/${agent.id}/owner-account`,
        { method: 'POST', body: { email: email.trim() } },
      );
      setEmail('');
      setCreated(response);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Owner account</h2>
      {created !== null && (
        <StaffSecret
          name={created.user.displayName}
          generatedPassword={created.generatedPassword}
          totp={created.totp}
          onDone={() => setCreated(null)}
        />
      )}
      {agent.isHouse ? (
        <p className="muted">Nahubet HQ has no owner account.</p>
      ) : owner !== null ? (
        <section className="panel">
          <DefList
            rows={[
              ['Email', owner.email],
              ['Name', owner.displayName],
              [
                'Password',
                owner.passwordChangeRequired ? 'Must change the generated password' : 'Changed',
              ],
              ['Last sign-in', formatDateTime(owner.lastLoginAt)],
            ]}
          />
          {owner.disabled && (
            <p>
              <Badge value="Disabled" tone="bad" />
            </p>
          )}
        </section>
      ) : (
        manage && (
          <form
            className="card"
            autoComplete="off"
            aria-label="Make the owner's account"
            onSubmit={submit}
          >
            <h3>Make the owner's account</h3>
            <div className="row">
              <Field label="Owner's email">
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            </div>
            {error !== null && <Notice>{error}</Notice>}
            <p>
              <button type="submit" className="primary" disabled={busy}>
                Make account
              </button>
            </p>
          </form>
        )
      )}
      {!agent.isHouse && (
        <p className="muted small">
          The owner signs in to the shop app with this email, the password and the authenticator
          code. The password stops working after 72 hours unless it is changed at the first sign-in.
        </p>
      )}
    </>
  );
}

const DEVICE_TONES = { pending: 'warn', approved: 'good', revoked: 'bad' } as const;

/**
 * The agent's shop devices (phase 1b): a cashier's computer or POS terminal asks once; an admin
 * approves it or revokes it with a reason. The shop app signs cashiers in only on approved devices.
 */
function Devices({
  devices,
  manage,
  onChanged,
}: {
  devices: ShopDeviceView[];
  manage: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const approve = async (device: ShopDeviceView) => {
    if (!window.confirm(`Approve "${device.label}" for shop ${device.shopLabel}?`)) return;
    setError(null);
    try {
      await api(`/admin/shop-devices/${device.id}/approve`, { method: 'POST', body: {} });
      onChanged();
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <>
      <h2>Devices ({devices.length})</h2>
      <p className="muted small">
        The shop app works only on devices approved here. Approve a device only when the shop told
        you its name; revoke a lost or replaced one at once.
      </p>
      {error !== null && <Notice>{error}</Notice>}
      <div className="table-wrap">
        <table data-testid="agent-devices">
          <thead>
            <tr>
              <th>Device</th>
              <th>Shop</th>
              <th>Asked by</th>
              <th>Asked</th>
              <th>Status</th>
              <th>Last used</th>
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.label}
                  <div className="muted small">{d.userAgent}</div>
                </td>
                <td>{`${d.shopLabel} ${d.shopName}`}</td>
                <td>{d.requestedByName}</td>
                <td>{formatDateTime(d.requestedAt)}</td>
                <td>
                  <Badge value={d.status} tone={DEVICE_TONES[d.status]} />
                  {d.revokedReason !== null && <div className="muted small">{d.revokedReason}</div>}
                </td>
                <td>{formatDateTime(d.lastSeenAt)}</td>
                {manage && (
                  <td>
                    {d.status === 'pending' && (
                      <button type="button" onClick={() => void approve(d)}>
                        Approve
                      </button>
                    )}{' '}
                    {d.status !== 'revoked' && (
                      <ReasonAction
                        label="Revoke"
                        danger
                        onSubmit={async (reason) => {
                          await api(`/admin/shop-devices/${d.id}/revoke`, {
                            method: 'POST',
                            body: { reason },
                          });
                          onChanged();
                        }}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={manage ? 7 : 6} className="muted">
                  No device has asked yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useFetch<AgentDetailResponse>(`/admin/agents/${id}`);
  const { can } = useSession();
  const manage = can('agents.manage');

  const setStatus = async (action: 'block' | 'unblock', reason: string) => {
    await api(`/admin/agents/${id}/${action}`, { method: 'POST', body: { reason } });
    reload();
  };

  const agent = data?.agent ?? null;
  const shops = data === null ? [] : sortShops(data.shops);
  const openShops = shops.filter((s) => s.active);
  return (
    <>
      <PageHeader title={agent === null ? 'Agent' : `Agent ${agent.number} – ${agent.name}`}>
        {agent !== null && <StatusBadge agent={agent} />} <Link href="/agents">Back to agents</Link>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && agent !== null && (
        <>
          <section className="panel">
            <DefList
              rows={[
                ['Number', String(agent.number)],
                ['Name', agent.name],
                ['Owner', agent.isHouse ? '—' : agent.ownerName],
                ['Owner phone', localPhone(agent.ownerPhone)],
                ['Commission', commissionText(agent)],
                [
                  'Status',
                  agent.status === 'active'
                    ? 'Active'
                    : `Blocked ${formatDateTime(agent.blockedAt)}: ${agent.blockedReason ?? ''}`,
                ],
                [
                  'Player cash at shops',
                  agent.playerCashEnabled ? 'On' : 'Off — starts with the agent balance (phase 2)',
                ],
                ['Created', formatDateTime(agent.createdAt)],
              ]}
            />
            {manage && !agent.isHouse && (
              <div className="actions">
                {agent.status === 'active' ? (
                  <ReasonAction
                    label="Block agent"
                    submitLabel="Block"
                    danger
                    onSubmit={(reason) => setStatus('block', reason)}
                  />
                ) : (
                  <ReasonAction
                    label="Unblock agent"
                    submitLabel="Unblock"
                    onSubmit={(reason) => setStatus('unblock', reason)}
                  />
                )}
              </div>
            )}
          </section>

          <OwnerAccount agent={agent} owner={data.owner} manage={manage} onChanged={reload} />
          {manage && <EditAgent key={agent.updatedAt} agent={agent} onSaved={reload} />}
          {manage && <AddShop agentId={agent.id} onAdded={reload} />}

          <h2>Shops ({shops.length})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Paper</th>
                  <th>Supervisor above</th>
                  <th>Status</th>
                  <th>Cashiers</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {shops.map((shop) => (
                  <tr key={shop.id}>
                    <td>{shop.label}</td>
                    <td>{shop.name}</td>
                    <td>{shop.address}</td>
                    <td>{shop.receiptWidthMm} mm</td>
                    <td>{formatEtb(shop.approvalThreshold)}</td>
                    <td>
                      {shop.active ? (
                        <Badge value="Open" tone="good" />
                      ) : (
                        <Badge value="Closed" tone="bad" />
                      )}
                    </td>
                    <td>{data.cashiers.filter((c) => c.shopId === shop.id).length}</td>
                    {manage && (
                      <td>
                        <ToggleShop shop={shop} onDone={reload} />
                      </td>
                    )}
                  </tr>
                ))}
                {shops.length === 0 && (
                  <tr>
                    <td colSpan={manage ? 8 : 7} className="muted">
                      No shops yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h2>Cashiers ({data.cashiers.length})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Shop</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {data.cashiers.map((c) => (
                  <tr key={c.staffId}>
                    <td>
                      <Link href={`/staff/${c.staffId}`}>{c.displayName}</Link>
                    </td>
                    <td>{localPhone(c.phone)}</td>
                    <td>{c.email}</td>
                    <td>{`${c.shopLabel} ${c.shopName}`}</td>
                    <td>
                      {c.disabledAt === null ? (
                        <Badge value="Active" tone="good" />
                      ) : (
                        <Badge value="Disabled" tone="bad" />
                      )}
                    </td>
                    <td>{formatDateTime(c.lastLoginAt)}</td>
                  </tr>
                ))}
                {data.cashiers.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No cashiers yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {manage && openShops.length > 0 && (
            <p>
              {openShops.map((shop) => (
                <span key={shop.id}>
                  <Link href={`/staff?role=cashier&shopId=${shop.id}`}>
                    Add a cashier{openShops.length > 1 ? ` to ${shop.label}` : ''}
                  </Link>{' '}
                </span>
              ))}
            </p>
          )}
          <Devices devices={data.devices} manage={manage} onChanged={reload} />
        </>
      )}
    </>
  );
}
