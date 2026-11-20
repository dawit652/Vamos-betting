import type { AtChannel } from '../at/chat';
import { encodeModemString, parseCusd, type ModemCharset } from '../at/codec';

/** One screen of a USSD menu. */
export interface UssdScreen {
  text: string;
  /** The network waits for an answer. False: this was its last word, the session is over. */
  open: boolean;
}

/**
 * A USSD session as the transfer runner needs it: open the menu, answer a
 * screen, hang up. Implemented on a modem below and by nothing else; the
 * tests drive the same implementation against the simulated modem.
 */
export interface UssdSession {
  dial(code: string): Promise<UssdScreen>;
  /** `sensitive`: the text is the PIN and must not reach any trace. */
  reply(text: string, options?: { sensitive?: boolean }): Promise<UssdScreen>;
  /** Ends the session. Never throws. */
  cancel(): Promise<void>;
}

/** The network or the modem ended or refused the session without a screen. */
export class UssdError extends Error {
  constructor(
    readonly code:
      'unreadable' | 'not_supported' | 'network_timeout' | 'ended_by_network' | 'empty_screen',
  ) {
    super(`ussd: ${code}`);
    this.name = 'UssdError';
  }
}

export interface ModemUssdOptions {
  /** Default UCS2 (see at/codec.ts). */
  charset?: ModemCharset;
  /** How long to wait for the screen after an answer was accepted (default 45 s). */
  stepTimeoutMs?: number;
  /** How long the modem may take to accept a command (default 10 s). */
  commandTimeoutMs?: number;
}

/**
 * Sets the modem up for this agent: no echo, numeric errors, the character
 * set. `extra` are commands a particular modem needs (for example a vendor
 * command that switches USSD to text mode); they must all succeed.
 */
export async function prepareModem(
  at: AtChannel,
  options: { charset?: ModemCharset; extra?: readonly string[] } = {},
): Promise<void> {
  const charset = options.charset ?? 'UCS2';
  await at.command('ATE0');
  // Not every modem knows +CMEE; errors are then just "ERROR".
  await at.command('AT+CMEE=1').catch(() => undefined);
  await at.command(`AT+CSCS="${charset}"`);
  for (const command of options.extra ?? []) await at.command(command);
}

export class ModemUssdSession implements UssdSession {
  private readonly charset: ModemCharset;
  private readonly stepTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly at: AtChannel,
    options: ModemUssdOptions = {},
  ) {
    this.charset = options.charset ?? 'UCS2';
    this.stepTimeoutMs = options.stepTimeoutMs ?? 45_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  }

  dial(code: string): Promise<UssdScreen> {
    // A late screen of an earlier session must not be read as this session's first one.
    this.at.drainUnsolicited('+CUSD:');
    return this.exchange(code, false);
  }

  reply(text: string, options: { sensitive?: boolean } = {}): Promise<UssdScreen> {
    return this.exchange(text, options.sensitive === true);
  }

  async cancel(): Promise<void> {
    await this.at.command('AT+CUSD=2', { timeoutMs: this.commandTimeoutMs }).catch(() => undefined);
    this.at.drainUnsolicited('+CUSD:');
  }

  private async exchange(text: string, sensitive: boolean): Promise<UssdScreen> {
    // Armed before the command: some modems send the screen before their OK.
    const wait = this.at.waitForUnsolicited('+CUSD:', this.stepTimeoutMs);
    // Awaited below; this only keeps a timeout during the command from being an unhandled rejection.
    wait.promise.catch(() => undefined);
    try {
      await this.at.command(`AT+CUSD=1,"${encodeModemString(text, this.charset)}",15`, {
        sensitive,
        timeoutMs: this.commandTimeoutMs,
      });
    } catch (error) {
      wait.cancel();
      throw error;
    }
    const event = parseCusd(await wait.promise, this.charset);
    if (event === null) throw new UssdError('unreadable');
    if (event.status === 4) throw new UssdError('not_supported');
    if (event.status === 5) throw new UssdError('network_timeout');
    if (event.text === null) {
      throw new UssdError(event.status === 1 ? 'empty_screen' : 'ended_by_network');
    }
    return { text: event.text, open: event.status === 1 };
  }
}
