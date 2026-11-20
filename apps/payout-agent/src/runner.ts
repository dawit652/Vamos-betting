import {
  nextPayoutMenuAction,
  payoutMenuOutcomeAfterBreak,
  type PayoutMenuScript,
  type PayoutMenuTransfer,
} from '@vamos/core';
import { AtError, AtTimeoutError } from './at/chat';
import { UssdError, type UssdSession } from './ussd/session';

/**
 * Sends one payout through the wallet's menu, or rehearses it. The judgement
 * is core's `nextPayoutMenuAction` (docs/plans/payout-sender-design.md): this
 * file only types what it says, in the order it says, and reports how the
 * session ended. Three rules are this file's own:
 *
 * - an answer counts as typed BEFORE it is written to the modem, so a write
 *   that failed half-way is never reported as "nothing was sent";
 * - in a rehearsal the commit is never typed: the session is cancelled there;
 * - the PIN comes from memory at the moment it is typed and is never put in
 *   the transcript, a reason or an error.
 */

/** Where the PIN is while a shift holds it. */
export interface PinSource {
  /** The PIN, or null when no shift holds one. */
  get(): string | null;
}

export type RunMode = 'send' | 'rehearse';

export type TranscriptEntry =
  /** What was typed; the PIN is written as `<PIN>`. */
  | { kind: 'typed'; text: string; commit: boolean }
  | { kind: 'screen'; text: string; open: boolean };

export interface RunResult {
  /**
   * `sent`: the menu said so, for this number and amount. `not_sent`: the
   * commit was never typed, nothing left the wallet. `unknown`: the commit
   * was typed and the end is not clear: a person must look, no machine may
   * retry. `rehearsed`: the menu matched the script up to the commit, which
   * was not typed.
   */
  outcome: 'sent' | 'not_sent' | 'unknown' | 'rehearsed';
  reason: string | null;
  reference: string | null;
  transcript: TranscriptEntry[];
}

const PIN = /^\d{4,8}$/;
const PIN_MARK = '<PIN>';

/** A short code for what broke; never the error's own text. */
function breakCode(error: unknown): string {
  if (error instanceof AtTimeoutError) return 'timeout';
  if (error instanceof UssdError) return error.code;
  if (error instanceof AtError) return 'modem_error';
  return 'port_error';
}

export async function runTransfer(input: {
  session: UssdSession;
  script: PayoutMenuScript;
  transfer: PayoutMenuTransfer;
  mode: RunMode;
  pin: PinSource;
}): Promise<RunResult> {
  const { session, script, transfer, mode, pin } = input;
  const screens: string[] = [];
  const transcript: TranscriptEntry[] = [];
  /** Answers begun (counted before each write); the dial is not one. */
  let repliesStarted = 0;
  /** Whether the last screen left the session open for an answer. */
  let open = false;
  /** Whether the menu was dialled at all. */
  let dialled = false;

  const finish = async (
    outcome: RunResult['outcome'],
    reason: string | null,
    reference: string | null = null,
  ): Promise<RunResult> => {
    // Always hang up once the menu was dialled, also when the last screen said the session was
    // over: that screen may have been a late one from an earlier session, with ours still open.
    if (dialled) await session.cancel();
    return { outcome, reason, reference, transcript };
  };

  // One dial, one answer per step, one result: anything longer is not this script's session.
  // (A script that is not even a list of steps is refused by the judgement on the first turn.)
  const steps: unknown = (script as { steps?: unknown } | null)?.steps;
  const turns = (Array.isArray(steps) ? steps.length : 0) + 3;
  try {
    for (let turn = 0; turn < turns; turn += 1) {
      const action = nextPayoutMenuAction(script, transfer, screens);
      if (action.kind === 'finish') {
        return await finish(
          action.outcome,
          action.outcome === 'sent' ? null : action.reason,
          action.outcome === 'sent' ? action.reference : null,
        );
      }

      let screen;
      if (action.kind === 'dial') {
        transcript.push({ kind: 'typed', text: action.code, commit: false });
        dialled = true;
        screen = await session.dial(action.code);
      } else {
        if (action.commit && mode === 'rehearse') return await finish('rehearsed', null);
        // The network closed the session on a screen that still wanted an answer.
        if (!open) {
          const broke = payoutMenuOutcomeAfterBreak(script, repliesStarted);
          return await finish(broke.outcome, 'session_lost:closed_early');
        }
        if (action.kind === 'reply_pin') {
          const secret = pin.get();
          // Nothing was typed at this step, so the count is still right for "not sent".
          if (secret === null || !PIN.test(secret)) return await finish('not_sent', 'no_pin');
          repliesStarted += 1;
          transcript.push({ kind: 'typed', text: PIN_MARK, commit: action.commit });
          screen = await session.reply(secret, { sensitive: true });
        } else {
          repliesStarted += 1;
          transcript.push({ kind: 'typed', text: action.text, commit: action.commit });
          screen = await session.reply(action.text);
        }
      }
      open = screen.open;
      screens.push(screen.text);
      transcript.push({ kind: 'screen', text: screen.text, open: screen.open });
    }
    const broke = payoutMenuOutcomeAfterBreak(script, repliesStarted);
    return await finish(broke.outcome, 'session_lost:too_long');
  } catch (error) {
    // The session broke: what was typed decides whether money may have moved.
    const broke = payoutMenuOutcomeAfterBreak(script, repliesStarted);
    return await finish(broke.outcome, `session_lost:${breakCode(error)}`);
  }
}
