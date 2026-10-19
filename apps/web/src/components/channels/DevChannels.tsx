'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Field } from '@/components/account/ui';
import { PaymentDemoNotice, usePaymentOptions } from '@/components/payments/PaymentParts';
import { useT } from '@/i18n/client';
import { isApiClientError } from '@/lib/api/errors';
import { devChannelsApi } from '@/lib/api/channels';
import { useSession } from '@/providers/SessionProvider';
import {
  DEFAULT_USSD_SERVICE_CODE,
  SMS_MAX_CHARS,
  appendUssdInput,
  isServiceCodeDial,
  mergeThread,
  newDevId,
  parseUssdResponse,
  smsParts,
  type ThreadEntry,
  type UssdScreen,
} from './channels';

const INBOX_REFRESH_MS = 4_000;

type ErrorKey = 'unavailable' | 'failed';
const errorKey = (e: unknown): ErrorKey =>
  isApiClientError(e) && e.status === 404 ? 'unavailable' : 'failed';

function SmsComposer({ phone }: { phone: string }) {
  const t = useT();
  const [text, setText] = useState('');
  const [messageId, setMessageId] = useState(() => newDevId('sms'));
  const [sent, setSent] = useState<ThreadEntry[]>([]);
  const [inbox, setInbox] = useState<{ body: string; createdAt: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const since = useRef(new Date().toISOString());

  const load = useCallback(async () => {
    try {
      const res = await devChannelsApi.inbox(phone);
      setInbox(res.items);
    } catch {
      // The inbox is a convenience: a failed refresh keeps what is shown.
    }
  }, [phone]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (busy || body === '') return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await devChannelsApi.sendSms({ text: body, messageId });
      setSent((list) => [...list, { direction: 'out', body, at: new Date().toISOString() }]);
      setInfo(
        t('account.channelsDev.sms.outcome', {
          outcome: res.outcome,
          replayed: res.replayed ? t('account.channelsDev.sms.replayed') : '',
        }),
      );
      setText('');
      setMessageId(newDevId('sms'));
      void load();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  };

  const thread = mergeThread(sent, inbox, since.current);
  const parts = smsParts(text);

  return (
    <section className="space-y-3 rounded-2xl border-4 border-ink bg-page p-3">
      <h2 className="text-center text-base font-bold">{t('account.channelsDev.sms.title')}</h2>
      <p className="text-center text-muted">
        {t('account.channelsDev.from')}: <span className="font-bold tabular-nums">{phone}</span>
      </p>
      <ul className="min-h-24 space-y-2" aria-live="polite">
        {thread.length === 0 ? (
          <li className="text-center text-muted">{t('account.channelsDev.sms.empty')}</li>
        ) : null}
        {thread.map((entry, i) => (
          <li
            key={`${entry.at}-${i}`}
            className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 ${
              entry.direction === 'out' ? 'ml-auto bg-brand-soft' : 'mr-auto border border-line'
            }`}
          >
            {entry.body}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void send(e)} className="space-y-2">
        <Field
          id="dev-sms-text"
          label={t('account.channelsDev.sms.text')}
          hint={t('account.channelsDev.sms.hint')}
        >
          <textarea
            id="dev-sms-text"
            className="input"
            rows={2}
            maxLength={SMS_MAX_CHARS}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <p className="text-xxs text-muted">
          {t('account.channelsDev.sms.parts', { count: String(parts), chars: String(text.length) })}
        </p>
        {error ? <Alert>{t(`account.channelsDev.error.${error}`)}</Alert> : null}
        {info ? <Alert tone="info">{info}</Alert> : null}
        <button
          type="submit"
          className="btn btn-primary w-full"
          disabled={busy || text.trim() === ''}
        >
          {t('account.channelsDev.sms.send')}
        </button>
      </form>
    </section>
  );
}

function UssdEmulator() {
  const t = useT();
  const [dial, setDial] = useState(DEFAULT_USSD_SERVICE_CODE);
  const [reply, setReply] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState('');
  const [screen, setScreen] = useState<UssdScreen | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  const call = async (id: string, text: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await devChannelsApi.ussd({ sessionId: id, text });
      const parsed = parseUssdResponse(res.response);
      if (parsed === null) {
        setError('failed');
        return;
      }
      setSessionId(id);
      setHistory(text);
      setScreen(parsed);
      setReply('');
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  };

  const onDial = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!isServiceCodeDial(dial, DEFAULT_USSD_SERVICE_CODE)) {
      setScreen({ kind: 'END', body: t('account.channelsDev.ussd.badCode') });
      setSessionId(null);
      return;
    }
    void call(newDevId('ussd'), '');
  };

  const onReply = (event: FormEvent) => {
    event.preventDefault();
    if (busy || sessionId === null) return;
    const next = appendUssdInput(history, reply);
    if (next === history) return;
    void call(sessionId, next);
  };

  const open = screen?.kind === 'CON' && sessionId !== null;

  return (
    <section className="space-y-3 rounded-2xl border-4 border-ink bg-page p-3">
      <h2 className="text-center text-base font-bold">{t('account.channelsDev.ussd.title')}</h2>
      <form onSubmit={onDial} className="flex gap-2">
        <input
          className="input flex-1 text-center tabular-nums"
          aria-label={t('account.channelsDev.ussd.dial')}
          value={dial}
          onChange={(e) => setDial(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('account.channelsDev.ussd.call')}
        </button>
      </form>
      {screen ? (
        <div
          className="whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-mono text-sm"
          aria-live="polite"
        >
          {screen.body}
        </div>
      ) : (
        <p className="text-center text-muted">{t('account.channelsDev.ussd.idle')}</p>
      )}
      {error ? <Alert>{t(`account.channelsDev.error.${error}`)}</Alert> : null}
      {screen?.kind === 'END' ? (
        <p className="text-center text-xxs text-muted">{t('account.channelsDev.ussd.ended')}</p>
      ) : null}
      {open ? (
        <form onSubmit={onReply} className="flex gap-2">
          <input
            className="input flex-1"
            aria-label={t('account.channelsDev.ussd.reply')}
            inputMode="text"
            autoComplete="off"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || reply.trim() === ''}>
            {t('account.channelsDev.ussd.send')}
          </button>
        </form>
      ) : null}
      {sessionId !== null ? (
        <p className="break-all text-xxs text-muted">
          {t('account.channelsDev.ussd.session', { id: sessionId, text: history || '-' })}
        </p>
      ) : null}
    </section>
  );
}

/** The demo-only SMS composer and USSD emulator; only rendered when the API says it is a demo. */
export function DevChannelsPanel() {
  const t = useT();
  const { me } = useSession();
  const { state, reload } = usePaymentOptions();
  return (
    <div className="space-y-3 px-3">
      <PaymentDemoNotice />
      {state.status === 'error' ? (
        <div className="space-y-2">
          <Alert>{t('account.payments.unavailable')}</Alert>
          <button type="button" className="btn btn-outline w-full" onClick={reload}>
            {t('common.actions.retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && !state.options.demo ? (
        <Alert tone="info">{t('account.channelsDev.notDemo')}</Alert>
      ) : null}
      {state.status === 'ready' && state.options.demo ? (
        <>
          <p className="text-muted">{t('account.channelsDev.intro')}</p>
          {me ? (
            <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-2">
              <SmsComposer phone={me.phone} />
              <UssdEmulator />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
