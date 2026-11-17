import type { EventSummary, LocalizedNameValue } from '@vamos/contracts';
import { formatOdds } from '@vamos/core';
import type { InlineButton, ReplyMarkup } from './client';

/**
 * What the Telegram bot says (pure: no I/O, unit tested). Plain text only. English and Amharic,
 * by the language of the player's Telegram app; the Amharic wording waits for a native speaker's
 * review like the rest of the Amharic texts.
 */

export type BotLocale = 'en' | 'am';

/** The bot's language for a Telegram language_code ("am", "am-ET"…): Amharic or English. */
export function botLocale(languageCode: string | undefined): BotLocale {
  return languageCode?.toLowerCase().startsWith('am') === true ? 'am' : 'en';
}

const TEXT = {
  en: {
    welcome:
      'Welcome to Nahubet. See today’s matches, live matches and the top leagues here, then bet on the website.',
    alertsOnly: 'This bot sends alerts only.',
    menuToday: 'Today',
    menuLive: 'Live',
    menuTop: 'Top matches',
    menuLeagues: 'Top leagues',
    titleToday: 'Today’s matches',
    titleLive: 'Live now',
    titleTop: 'Top matches',
    titleLeague: 'Matches',
    chooseLeague: 'Choose a league:',
    noMatches: 'No matches to show right now.',
    unavailable: 'Matches are not available right now. Try again in a minute.',
    open: 'Open',
    more: 'more options',
    footer: '21+ only. Bet responsibly.',
    demo: 'DEMO: play money only.',
    help: 'Commands: /today, /live, /top, /leagues, /id',
    chatId: 'This chat’s id:',
    live: 'LIVE',
    statusTitle: 'Nahubet status',
    statusLastSms: 'Last SMS from the handset',
    statusReview: 'SMS waiting for staff',
    statusPayouts: 'Manual payouts open',
    statusNever: 'never',
    statusUnavailable: 'Status is not available right now.',
    menuReset: 'Forgot PIN',
    resetAsk:
      'To get a code for a new PIN, share your phone number with the button below. It must be the number of your Nahubet account.',
    resetButton: 'Share my phone number',
    resetNotOwn: 'Please share your own number with the button below.',
    resetNoAccount: 'No Nahubet account uses this number. You can register on the website.',
    resetLimited: 'Too many codes were asked for this number. Try again in an hour.',
    resetUnavailable: 'The code cannot be sent right now. Try again in a minute.',
    resetCode:
      'Your Nahubet code: {code}\nIt is valid for 5 minutes. Never share it with anyone, not even Nahubet staff.\nOn the website, enter it with your phone number and choose a new PIN.',
    resetOpen: 'Choose a new PIN',
  },
  am: {
    welcome:
      'ወደ ናሁቤት እንኳን ደህና መጡ። የዛሬ ጨዋታዎችን፣ የቀጥታ ጨዋታዎችን እና ምርጥ ሊጎችን እዚህ ይመልከቱ፣ ከዚያ በድረ-ገጹ ላይ ይወራረዱ።',
    alertsOnly: 'ይህ ቦት ማሳወቂያዎችን ብቻ ይልካል።',
    menuToday: 'ዛሬ',
    menuLive: 'ቀጥታ',
    menuTop: 'ምርጥ ጨዋታዎች',
    menuLeagues: 'ምርጥ ሊጎች',
    titleToday: 'የዛሬ ጨዋታዎች',
    titleLive: 'አሁን በቀጥታ',
    titleTop: 'ምርጥ ጨዋታዎች',
    titleLeague: 'ጨዋታዎች',
    chooseLeague: 'ሊግ ይምረጡ፦',
    noMatches: 'አሁን የሚታይ ጨዋታ የለም።',
    unavailable: 'ጨዋታዎች አሁን አይገኙም። ከአንድ ደቂቃ በኋላ እንደገና ይሞክሩ።',
    open: 'ክፈት',
    more: 'ተጨማሪ አማራጮች',
    footer: 'ዕድሜ 21+ ብቻ። በኃላፊነት ይወራረዱ።',
    demo: 'ማሳያ፦ የጨዋታ ገንዘብ ብቻ።',
    help: 'ትዕዛዞች፦ /today, /live, /top, /leagues, /id',
    chatId: 'የዚህ ውይይት መለያ፦',
    live: 'ቀጥታ',
    statusTitle: 'የናሁቤት ሁኔታ',
    statusLastSms: 'ከስልኩ የመጣ የመጨረሻ ኤስኤምኤስ',
    statusReview: 'ሰራተኛ የሚጠብቁ ኤስኤምኤሶች',
    statusPayouts: 'ክፍት የእጅ ክፍያዎች',
    statusNever: 'በጭራሽ',
    statusUnavailable: 'ሁኔታው አሁን አይገኝም።',
    menuReset: 'ፒን ረሳሁ',
    resetAsk: 'አዲስ ፒን ለማዘጋጀት ኮድ ለማግኘት፣ ከታች ባለው ቁልፍ ስልክ ቁጥርዎን ያጋሩ። የናሁቤት መለያዎ ቁጥር መሆን አለበት።',
    resetButton: 'ስልክ ቁጥሬን አጋራ',
    resetNotOwn: 'እባክዎ ከታች ባለው ቁልፍ የራስዎን ቁጥር ያጋሩ።',
    resetNoAccount: 'በዚህ ቁጥር የናሁቤት መለያ የለም። በድረ-ገጹ ላይ መመዝገብ ይችላሉ።',
    resetLimited: 'ለዚህ ቁጥር ብዙ ኮዶች ተጠይቀዋል። ከአንድ ሰዓት በኋላ እንደገና ይሞክሩ።',
    resetUnavailable: 'ኮዱ አሁን ሊላክ አይችልም። ከአንድ ደቂቃ በኋላ እንደገና ይሞክሩ።',
    resetCode:
      'የናሁቤት ኮድዎ፦ {code}\nለ5 ደቂቃ ያገለግላል። ለማንም አያጋሩ፣ ለናሁቤት ሰራተኞችም ቢሆን።\nበድረ-ገጹ ላይ ከስልክ ቁጥርዎ ጋር ያስገቡትና አዲስ ፒን ይምረጡ።',
    resetOpen: 'አዲስ ፒን ይምረጡ',
  },
} as const;

export type BotText = Record<keyof (typeof TEXT)['en'], string>;

export function textOf(locale: BotLocale): BotText {
  return TEXT[locale];
}

function name(value: LocalizedNameValue, locale: BotLocale): string {
  return (locale === 'am' ? value.am : undefined) ?? value.en;
}

/** HH:MM in Addis Ababa (UTC+3, no daylight saving), the time players read. */
export function addisTime(iso: string): string {
  const t = new Date(Date.parse(iso) + 3 * 60 * 60_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** One match: time (or live minute and score), teams, the main market's prices, more options. */
export function matchLine(event: EventSummary, locale: BotLocale): string {
  const t = textOf(locale);
  const when =
    event.status === 'live'
      ? `${t.live}${event.liveMinute === null ? '' : ` ${event.liveMinute}'`}${
          event.score === null ? '' : ` ${event.score.home}-${event.score.away}`
        }`
      : addisTime(event.startTime);
  const teams = `${name(event.home.name, locale)} v ${name(event.away.name, locale)}`;
  const market = event.mainMarket;
  const prices =
    market === null || market.status !== 'open'
      ? ''
      : market.selections
          .filter((selection) => selection.open)
          .map((selection) => `${selection.code.toUpperCase()} ${formatOdds(selection.oddsMilli)}`)
          .join(' · ');
  const options = event.optionCount ?? 0;
  const more = options > 0 ? ` (+${options} ${t.more})` : '';
  return `${when}  ${teams}${prices === '' ? '' : `\n   ${prices}`}${more}`;
}

/** At most this many matches per message (a message holds 4096 characters). */
export const MAX_MATCHES_PER_MESSAGE = 10;

export interface BotMessage {
  text: string;
  replyMarkup?: ReplyMarkup;
}

/** The website's page of an event. */
export function eventUrl(webUrl: string, eventId: string): string {
  return `${webUrl.replace(/\/$/, '')}/event/${encodeURIComponent(eventId)}`;
}

/**
 * A list of matches, with a button per match that opens it on the website (bets are placed
 * there, never in the chat).
 */
export function matchListMessage(input: {
  title: string;
  events: readonly EventSummary[];
  locale: BotLocale;
  webUrl: string;
  demo: boolean;
}): BotMessage {
  const t = textOf(input.locale);
  const events = input.events.slice(0, MAX_MATCHES_PER_MESSAGE);
  const lines = [
    ...(input.demo ? [t.demo] : []),
    input.title,
    '',
    ...(events.length === 0 ? [t.noMatches] : events.map((e) => matchLine(e, input.locale))),
    '',
    t.footer,
  ];
  const buttons: InlineButton[][] = events.map((event) => [
    {
      text: `${t.open}: ${name(event.home.name, input.locale)} v ${name(event.away.name, input.locale)}`.slice(
        0,
        64,
      ),
      url: eventUrl(input.webUrl, event.id),
    },
  ]);
  return {
    text: lines.join('\n'),
    ...(buttons.length === 0 ? {} : { replyMarkup: { inline_keyboard: buttons } }),
  };
}

/** The main menu: today, live, top matches, top leagues, and "Forgot PIN" when the reset is on. */
export function menuMessage(locale: BotLocale, demo: boolean, reset = false): BotMessage {
  const t = textOf(locale);
  return {
    text: [...(demo ? [t.demo] : []), t.welcome, '', t.help, '', t.footer].join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: t.menuToday, callback_data: 'm:today' },
          { text: t.menuLive, callback_data: 'm:live' },
        ],
        [
          { text: t.menuTop, callback_data: 'm:top' },
          { text: t.menuLeagues, callback_data: 'm:leagues' },
        ],
        ...(reset ? [[{ text: t.menuReset, callback_data: 'm:reset' }]] : []),
      ],
    },
  };
}

/** Callback data is at most 64 bytes: a league whose slug does not fit is left out. */
const CALLBACK_MAX_BYTES = 64;

/** The top leagues as buttons (two per row). */
export function leaguesMessage(
  leagues: readonly { slug: string; name: LocalizedNameValue; flag: string; eventCount: number }[],
  locale: BotLocale,
): BotMessage {
  const t = textOf(locale);
  const fitting = leagues.filter(
    (league) => Buffer.byteLength(`lg:${league.slug}`, 'utf8') <= CALLBACK_MAX_BYTES,
  );
  if (fitting.length === 0) return { text: t.noMatches };
  const rows: InlineButton[][] = [];
  for (let i = 0; i < fitting.length; i += 2) {
    rows.push(
      fitting.slice(i, i + 2).map((league) => ({
        text: `${league.flag} ${name(league.name, locale)} (${league.eventCount})`.slice(0, 64),
        callback_data: `lg:${league.slug}`,
      })),
    );
  }
  return { text: t.chooseLeague, replyMarkup: { inline_keyboard: rows } };
}

/** How long ago, in plain words ("3 min ago"; "never"). */
function ago(at: Date | null, now: Date, locale: BotLocale): string {
  if (at === null) return textOf(locale).statusNever;
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** The owner's /status: the SMS rail at a glance. */
export function statusMessage(
  health: { lastGatewaySmsAt: Date | null; reviewQueue: number; manualPayoutsOpen: number },
  now: Date,
  locale: BotLocale,
): string {
  const t = textOf(locale);
  return [
    t.statusTitle,
    `${t.statusLastSms}: ${ago(health.lastGatewaySmsAt, now, locale)}`,
    `${t.statusReview}: ${health.reviewQueue}`,
    `${t.statusPayouts}: ${health.manualPayoutsOpen}`,
  ].join('\n');
}

/** A command from a message text: "/today@NahubetBot extra" → "today". Null for no command. */
export function parseCommand(text: string | undefined): string | null {
  if (text === undefined) return null;
  const match = /^\/([A-Za-z_]{1,32})(?:@\w+)?(?:\s|$)/.exec(text.trim());
  return match === null ? null : match[1]!.toLowerCase();
}

/** Asks for the person's own number, with Telegram's one-tap "share my number" button. */
export function resetAskMessage(locale: BotLocale): BotMessage {
  const t = textOf(locale);
  return {
    text: t.resetAsk,
    replyMarkup: {
      keyboard: [[{ text: t.resetButton, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

/** The reset code, with a button to the website's reset page. */
export function resetCodeMessage(code: string, locale: BotLocale, webUrl: string): BotMessage {
  const t = textOf(locale);
  return {
    text: t.resetCode.replace('{code}', code),
    replyMarkup: {
      inline_keyboard: [
        [{ text: t.resetOpen, url: `${webUrl.replace(/\/$/, '')}/reset-password` }],
      ],
    },
  };
}

/** "/start reset" (the website's Telegram link): the payload after /start, or null. */
export function startPayload(text: string | undefined): string | null {
  const match = /^\/start(?:@\w+)?\s+(\S+)/.exec(text?.trim() ?? '');
  return match === null ? null : match[1]!;
}
