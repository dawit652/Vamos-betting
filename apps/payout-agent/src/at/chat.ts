/**
 * One conversation with a modem over its AT command port: a command is
 * written, the lines until its final result code are its answer, and lines
 * the modem sends on its own (`+CUSD:` for a USSD screen, `+CMTI:` for a new
 * SMS) are unsolicited and go to whoever waits for them. One command at a
 * time. Nothing here knows about money.
 */

/** The byte stream to the modem: a serial port, or the simulated modem in tests. */
export interface BytePort {
  write(data: string): Promise<void>;
  onData(listener: (chunk: string) => void): void;
  close(): Promise<void>;
}

/** The modem answered a command with an error result code. */
export class AtError extends Error {
  constructor(
    /** The command, or `<hidden>` for one that carried the PIN. */
    readonly command: string,
    readonly result: string,
  ) {
    super(`modem answered ${result} to ${command}`);
    this.name = 'AtError';
  }
}

/** No final result code, or no unsolicited line, in time. */
export class AtTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what}: nothing from the modem in ${ms} ms`);
    this.name = 'AtTimeoutError';
  }
}

export interface AtChannelOptions {
  /** Time limit of one command's final result code (default 10 s). */
  commandTimeoutMs?: number;
  /**
   * Called with every line written and read, for a trace. A command sent
   * with `sensitive` is given as `<hidden>`: the PIN must never reach a log.
   */
  onLine?: (direction: 'out' | 'in', line: string) => void;
}

export interface CommandOptions {
  timeoutMs?: number;
  /** The command carries the PIN: never traced, never in an error message. */
  sensitive?: boolean;
}

const FINAL_ERROR =
  /^(ERROR|NO CARRIER|BUSY|NO ANSWER|NO DIALTONE|COMMAND NOT SUPPORT|\+CME ERROR:.*|\+CMS ERROR:.*)$/;
/** Lines a modem sends on its own, whatever command is in flight. */
const UNSOLICITED = /^(\+CUSD:|\+CMTI:|\+CMT:|\+CDS|RING|\+CRING:|\+CREG:|\+CGREG:|\+CEREG:|\^)/;
const BACKLOG_LIMIT = 50;
/** A `+CUSD:` text with a line break in it is put together again from at most this many lines. */
const MULTILINE_LIMIT = 30;

interface Pending {
  command: string;
  shown: string;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  prefix: string;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface UnsolicitedWait {
  promise: Promise<string>;
  /** Stops waiting (the promise then never settles). */
  cancel(): void;
}

export class AtChannel {
  private buffer = '';
  /** A `+CUSD:` line whose quoted text is not closed yet (plain-text mode with line breaks). */
  private partial: string[] | null = null;
  private pending: Pending | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private waiters: Waiter[] = [];
  private backlog: string[] = [];
  private closed = false;

  constructor(
    private readonly port: BytePort,
    private readonly options: AtChannelOptions = {},
  ) {
    port.onData((chunk) => this.receive(chunk));
  }

  /**
   * Sends one command and resolves with its information lines once the modem
   * says OK. Rejects with AtError on an error result code and with
   * AtTimeoutError when no result code comes. Commands queue up.
   */
  command(command: string, options: CommandOptions = {}): Promise<string[]> {
    const run = () => this.send(command, options);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /**
   * Waits for the next unsolicited line that starts with `prefix`. Arm it
   * BEFORE sending the command that causes the line: some modems send the
   * line before their OK. Lines that came while nobody waited are not given
   * (see drainUnsolicited): a late line of an earlier exchange must not be
   * taken for the answer to this one.
   */
  waitForUnsolicited(prefix: string, timeoutMs: number): UnsolicitedWait {
    let waiter: Waiter | null = null;
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new AtTimeoutError(`waiting for ${prefix}`, timeoutMs));
      }, timeoutMs);
      waiter = { prefix, resolve, reject, timer };
      this.waiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (waiter === null) return;
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      },
    };
  }

  /** Forgets, and returns, the unsolicited lines with `prefix` that nobody waited for. */
  drainUnsolicited(prefix: string): string[] {
    const drained = this.backlog.filter((line) => line.startsWith(prefix));
    this.backlog = this.backlog.filter((line) => !line.startsWith(prefix));
    return drained;
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error('the modem port was closed');
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
    await this.port.close();
  }

  private send(command: string, options: CommandOptions): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error('the modem port is closed'));
    const shown = options.sensitive === true ? '<hidden>' : command;
    const timeoutMs = options.timeoutMs ?? this.options.commandTimeoutMs ?? 10_000;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        reject(new AtTimeoutError(shown, timeoutMs));
      }, timeoutMs);
      this.pending = { command, shown, lines: [], resolve, reject, timer };
      this.options.onLine?.('out', shown);
      this.port.write(`${command}\r`).catch((error: unknown) => {
        if (this.pending?.timer !== timer) return;
        clearTimeout(timer);
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.search(/[\r\n]/);
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.assemble(line);
    }
  }

  /** Puts a `+CUSD:` text that holds line breaks back into one line; passes every other line on. */
  private assemble(raw: string): void {
    if (this.partial !== null) {
      this.partial.push(raw);
      const joined = this.partial.join('\n');
      if (quotesClosed(joined) || this.partial.length >= MULTILINE_LIMIT) {
        this.partial = null;
        this.handle(joined.trim());
      }
      return;
    }
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('+CUSD:') && !quotesClosed(line)) {
      this.partial = [line];
      return;
    }
    this.handle(line);
  }

  private handle(line: string): void {
    const pending = this.pending;
    // The modem's echo of the command itself (before ATE0 took effect): never traced, it may be the PIN's.
    if (pending !== null && line === pending.command) return;
    this.options.onLine?.('in', line);
    if (UNSOLICITED.test(line)) {
      const index = this.waiters.findIndex((waiter) => line.startsWith(waiter.prefix));
      const waiter = index < 0 ? undefined : this.waiters[index];
      if (waiter === undefined) {
        this.backlog.push(line);
        if (this.backlog.length > BACKLOG_LIMIT) this.backlog.shift();
        return;
      }
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      return;
    }
    // A result code or an information line with no command in flight: a late answer, dropped.
    if (pending === null) return;
    if (line === 'OK') {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(pending.lines);
    } else if (FINAL_ERROR.test(line)) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(new AtError(pending.shown, line));
    } else {
      pending.lines.push(line);
    }
  }
}

/** Whether every quote opened in `text` is closed (an even number of them). */
function quotesClosed(text: string): boolean {
  let quotes = 0;
  for (const ch of text) if (ch === '"') quotes += 1;
  return quotes % 2 === 0;
}
