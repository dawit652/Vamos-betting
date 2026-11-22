'use client';

import type { BookingCodeResponse, EventDetail } from '@vamos/contracts';
import { formatBookingCode, isBookingCode, normalizeCode } from '@vamos/core';
import { useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { bettingApi } from '@/lib/api/betting';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { formatDayMonth, formatTime } from '@/lib/format';
import { useBetslip } from '@/providers/BetslipProvider';
import { BOOKING_ERROR_KEYS, bookingCodeRequest, legsFromBooking } from './requests';

type Message = { tone: 'ok' | 'error'; text: string };

/**
 * Booking codes in the drawer: "Share" turns the slip into a short code
 * (POST /booking-codes) and "Load code" fills the slip from one
 * (GET /booking-codes/:code, then the event pages for the team names).
 */
export function BookingCodePanel() {
  const t = useT();
  const locale = useLocale();
  const slip = useBetslip();
  const [shared, setShared] = useState<{ selections: string; booking: BookingCodeResponse } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [loadOpen, setLoadOpen] = useState(slip.count === 0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'share' | 'load' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const selections = slip.legs.map((leg) => leg.selectionId).join(',');
  const current = shared !== null && shared.selections === selections ? shared.booking : null;

  async function share() {
    if (slip.count === 0) return;
    setBusy('share');
    setMessage(null);
    setCopied(false);
    try {
      const booking = await bettingApi.createBookingCode(bookingCodeRequest(slip.legs));
      setShared({ selections, booking });
    } catch (error) {
      setMessage({ tone: 'error', text: t(errorMessageKey(error)) });
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function load(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (!isBookingCode(normalized)) {
      setMessage({ tone: 'error', text: t('sportsbook.betslip.booking.notFound') });
      return;
    }
    setBusy('load');
    setMessage(null);
    try {
      const booking = await bettingApi.bookingCode(normalized);
      const eventIds = [
        ...new Set(
          booking.legs.flatMap((leg) =>
            leg.available && leg.eventId !== null ? [leg.eventId] : [],
          ),
        ),
      ];
      const events = new Map<string, EventDetail>();
      const results = await Promise.allSettled(eventIds.map((id) => bettingApi.event(id)));
      for (const result of results) {
        if (result.status === 'fulfilled') events.set(result.value.id, result.value);
      }
      const { legs, skipped } = legsFromBooking(booking, events);
      if (legs.length === 0) {
        setMessage({ tone: 'error', text: t('sportsbook.betslip.booking.noneAvailable') });
        return;
      }
      slip.replaceLegs(legs);
      setCode('');
      setLoadOpen(false);
      setMessage({
        tone: 'ok',
        text: [
          t('sportsbook.betslip.booking.loaded', { count: legs.length }),
          skipped > 0 ? t('sportsbook.betslip.booking.skipped', { count: skipped }) : '',
        ]
          .filter((part) => part !== '')
          .join(' '),
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: t(
          isApiClientError(error) && error.status === 404
            ? 'sportsbook.betslip.booking.notFound'
            : errorMessageKey(error, BOOKING_ERROR_KEYS),
        ),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex gap-2">
        {slip.count > 0 ? (
          <button
            type="button"
            className="btn btn-outline flex-1"
            disabled={busy !== null}
            onClick={() => void share()}
          >
            {t('sportsbook.betslip.booking.share')}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-outline flex-1"
          aria-expanded={loadOpen}
          onClick={() => {
            setLoadOpen((open) => !open);
            setMessage(null);
          }}
        >
          {t('sportsbook.betslip.booking.load')}
        </button>
      </div>

      {current !== null ? (
        <div className="card flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xxs text-muted">{t('sportsbook.betslip.booking.code')}</p>
            <p className="font-mono text-2xl font-bold tracking-widest" data-testid="booking-code">
              {formatBookingCode(current.code)}
            </p>
            <p className="text-xs font-semibold">{t('sportsbook.betslip.booking.tellCashier')}</p>
            <p className="text-xxs text-muted">
              {t('sportsbook.betslip.booking.validUntil', {
                time: `${formatDayMonth(current.expiresAt)} ${formatTime(current.expiresAt, locale)}`,
              })}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              void copy(
                t('sportsbook.betslip.booking.shareText', {
                  code: formatBookingCode(current.code),
                }),
              )
            }
          >
            {copied ? t('sportsbook.betslip.booking.copied') : t('sportsbook.betslip.booking.copy')}
          </button>
        </div>
      ) : null}

      {loadOpen ? (
        <form className="flex gap-2" onSubmit={(event) => void load(event)}>
          <input
            className="input min-w-0 font-mono uppercase"
            value={code}
            maxLength={16}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('sportsbook.betslip.booking.code')}
            placeholder={t('sportsbook.betslip.booking.placeholder')}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary flex-none whitespace-nowrap"
            disabled={busy !== null || code.trim() === ''}
          >
            {busy === 'load' ? t('common.actions.loading') : t('sportsbook.betslip.booking.load')}
          </button>
        </form>
      ) : null}

      {message !== null ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`px-1 text-xs font-semibold ${message.tone === 'error' ? 'text-down' : 'text-up'}`}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
