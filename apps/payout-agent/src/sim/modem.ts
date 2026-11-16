import type { BytePort } from '../at/chat';
import { decodeUcs2Hex, encodeUcs2Hex, type ModemCharset } from '../at/codec';
import type { SimWalletMenu } from './wallet-menu';

/**
 * A modem for tests: it speaks the AT commands the agent uses (and answers
 * ERROR to the rest), with the simulated wallet menu behind its USSD. It
 * starts the way a modem does: echo on, the GSM character set.
 */

export interface SimModemOptions {
  /** Cuts what the modem sends into pieces, as a serial port does (default: one piece). */
  fragment?: (text: string) => string[];
  /** Sends a USSD screen before the OK of its command, as some modems do. */
  screenBeforeOk?: boolean;
}

export class SimulatedModem implements BytePort {
  /** Every command line received, in order (tests look for the PIN here, and nowhere else). */
  readonly commands: string[] = [];
  charset: ModemCharset = 'GSM';
  private echo = true;
  private inbox = '';
  private listeners: ((chunk: string) => void)[] = [];
  private outbox: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly menu: SimWalletMenu,
    private readonly options: SimModemOptions = {},
  ) {}

  async write(data: string): Promise<void> {
    if (this.closed) throw new Error('port closed');
    this.inbox += data;
    for (;;) {
      const end = this.inbox.indexOf('\r');
      if (end < 0) return;
      const line = this.inbox.slice(0, end);
      this.inbox = this.inbox.slice(end + 1);
      this.handle(line);
    }
  }

  onData(listener: (chunk: string) => void): void {
    this.listeners.push(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** A line the modem sends on its own, such as a late screen of an earlier session. */
  unsolicited(line: string): void {
    this.emit(`\r\n${line}\r\n`);
  }

  /** A `+CUSD:` line for `text`, in the modem's current character set. */
  cusdLine(status: number, text: string): string {
    return this.charset === 'UCS2'
      ? `+CUSD: ${status},"${encodeUcs2Hex(text)}",72`
      : `+CUSD: ${status},"${text}",15`;
  }

  private emit(text: string): void {
    const pieces = this.options.fragment?.(text) ?? [text];
    this.outbox = this.outbox.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!this.closed) for (const piece of pieces) for (const l of this.listeners) l(piece);
            resolve();
          }, 0);
        }),
    );
  }

  private ok(): void {
    this.emit('\r\nOK\r\n');
  }

  private handle(line: string): void {
    this.commands.push(line);
    if (this.echo) this.emit(`${line}\r`);
    if (/^ATE0$/i.test(line)) {
      this.echo = false;
      this.ok();
      return;
    }
    if (/^AT$/i.test(line) || /^AT\+CMEE=\d$/i.test(line)) {
      this.ok();
      return;
    }
    const charset = /^AT\+CSCS="(UCS2|GSM)"$/i.exec(line);
    if (charset !== null) {
      this.charset = charset[1]?.toUpperCase() === 'UCS2' ? 'UCS2' : 'GSM';
      this.ok();
      return;
    }
    if (/^AT\+CUSD=2$/i.test(line)) {
      this.menu.cancel();
      this.ok();
      return;
    }
    const ussd = /^AT\+CUSD=1,"(.*)",15$/i.exec(line);
    if (ussd !== null) {
      const raw = ussd[1] ?? '';
      const text = this.charset === 'UCS2' ? decodeUcs2Hex(raw) : raw;
      if (text === null) {
        this.emit('\r\n+CME ERROR: 50\r\n');
        return;
      }
      const output = this.menu.input(text);
      if (output.kind === 'modem_error') {
        this.emit('\r\n+CME ERROR: 100\r\n');
      } else if (output.kind === 'silent') {
        this.ok();
      } else if (output.kind === 'ended') {
        this.ok();
        this.unsolicited('+CUSD: 2');
      } else {
        const screen = this.cusdLine(output.open ? 1 : 0, output.text);
        if (this.options.screenBeforeOk === true) {
          this.unsolicited(screen);
          this.ok();
        } else {
          this.ok();
          this.unsolicited(screen);
        }
      }
      return;
    }
    this.emit('\r\nERROR\r\n');
  }
}
