import type { PayoutMenuScript } from '@vamos/core';

/**
 * A wallet and its USSD menu, INVENTED for tests: it has the shape the
 * institutions describe (choose "send money", type the number, the amount,
 * confirm, type the PIN) and none of their real wording. It keeps the books
 * a real wallet keeps, so a test can compare what the agent REPORTED with
 * what the wallet DID. Faults make it misbehave the ways a network does.
 */

export interface SimTransfer {
  /** Local number, `09…`. */
  to: string;
  amount: bigint;
  reference: string;
}

export interface SimWallet {
  balance: bigint;
  pin: string;
  /** Registered holders by local number. */
  holders: Map<string, string>;
  transfers: SimTransfer[];
  /** PINs typed into the menu, right or wrong. */
  pinsTyped: number;
  wrongPins: number;
}

export function simWallet(overrides: Partial<SimWallet> = {}): SimWallet {
  return {
    balance: 10_000_000n,
    pin: '482913',
    holders: new Map([
      ['0911234567', 'ABEBE KEBEDE'],
      ['0922334455', 'SARA HAILE'],
      ['0733445566', 'CHALTU TOLOSA'],
    ]),
    transfers: [],
    pinsTyped: 0,
    wrongPins: 0,
    ...overrides,
  };
}

/** What goes wrong, and at which exchange of the session (0 is the dial). */
export interface MenuFault {
  at: number;
  kind:
    /** Our message is lost: nothing happens and nothing comes back. */
    | 'silent'
    /** The menu acts on our message and its answer is lost. At the PIN step the money moves. */
    | 'silent_after_effect'
    /** An unexpected last word ("service unavailable"). */
    | 'garbage'
    /** The network ends the session without a screen. */
    | 'terminate'
    /** The modem refuses the command. */
    | 'modem_error';
}

/** A menu that takes other values than the ones typed (and would send those). */
export interface MenuQuirks {
  takesAmount?: (typed: bigint) => bigint;
  takesNumber?: (typed: string) => string;
}

export type MenuOutput =
  | { kind: 'screen'; text: string; open: boolean }
  | { kind: 'silent' }
  | { kind: 'ended' }
  | { kind: 'modem_error' };

const FEE = 115n;
export const SIM_DIAL = '*127#';

/** `1,500.00` */
function grouped(santim: bigint): string {
  const birr = (santim / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${birr}.${(santim % 100n).toString().padStart(2, '0')}`;
}

/** `1500.00` */
function plain(santim: bigint): string {
  return `${santim / 100n}.${(santim % 100n).toString().padStart(2, '0')}`;
}

type State = 'idle' | 'main' | 'number' | 'amount' | 'confirm' | 'pin';

export class SimWalletMenu {
  private state: State = 'idle';
  private exchanges = 0;
  private to = '';
  private amount = 0n;

  constructor(
    readonly wallet: SimWallet,
    private readonly fault: MenuFault | null = null,
    private readonly quirks: MenuQuirks = {},
  ) {}

  /** One message from the handset: the dial code when idle, an answer otherwise. */
  input(text: string): MenuOutput {
    if (this.state === 'idle') this.exchanges = 0;
    const index = this.exchanges;
    this.exchanges += 1;
    if (this.fault !== null && this.fault.at === index) {
      switch (this.fault.kind) {
        case 'silent':
          return { kind: 'silent' };
        case 'silent_after_effect':
          this.step(text);
          return { kind: 'silent' };
        case 'garbage':
          this.state = 'idle';
          return this.last('Service temporarily unavailable. Please try again later.');
        case 'terminate':
          this.state = 'idle';
          return { kind: 'ended' };
        case 'modem_error':
          return { kind: 'modem_error' };
      }
    }
    return this.step(text);
  }

  cancel(): void {
    this.state = 'idle';
  }

  private ask(text: string, next: State): MenuOutput {
    this.state = next;
    return { kind: 'screen', text, open: true };
  }

  private last(text: string): MenuOutput {
    this.state = 'idle';
    return { kind: 'screen', text, open: false };
  }

  private step(text: string): MenuOutput {
    const { wallet } = this;
    switch (this.state) {
      case 'idle':
        if (text !== SIM_DIAL) return this.last('Unknown service code');
        return this.ask(
          'Welcome to telebirr\n1. Send Money\n2. Buy Airtime\n3. My Account',
          'main',
        );
      case 'main':
        if (text !== '1') return this.last('Invalid choice');
        return this.ask('Enter mobile number', 'number');
      case 'number': {
        if (!/^0[79]\d{8}$/.test(text) || !wallet.holders.has(text)) {
          return this.last('The customer is not registered for telebirr');
        }
        this.to = this.quirks.takesNumber?.(text) ?? text;
        return this.ask('Enter amount', 'amount');
      }
      case 'amount': {
        if (!/^\d{1,9}$/.test(text) || BigInt(text) === 0n) return this.last('Invalid amount');
        const typed = BigInt(text) * 100n;
        this.amount = this.quirks.takesAmount?.(typed) ?? typed;
        const name = wallet.holders.get(this.to) ?? 'UNKNOWN CUSTOMER';
        return this.ask(
          `Send ${grouped(this.amount)} Birr to ${name} ${this.to}? Fee ${plain(FEE)} Birr.\n1. Confirm\n2. Cancel`,
          'confirm',
        );
      }
      case 'confirm':
        if (text === '1') return this.ask('Enter PIN', 'pin');
        return this.last(text === '2' ? 'Cancelled' : 'Invalid choice');
      case 'pin': {
        wallet.pinsTyped += 1;
        if (text !== wallet.pin) {
          wallet.wrongPins += 1;
          return this.last(`Incorrect PIN. ${Math.max(0, 3 - wallet.wrongPins)} attempts left`);
        }
        if (wallet.balance < this.amount + FEE) return this.last('Sorry, insufficient balance');
        wallet.balance -= this.amount + FEE;
        const reference = `SIM${String(wallet.transfers.length + 1).padStart(7, '0')}`;
        wallet.transfers.push({ to: this.to, amount: this.amount, reference });
        return this.last(
          `You have sent ${plain(this.amount)} Birr to ${this.to}. Transaction ${reference}. Balance ${grouped(wallet.balance)} Birr`,
        );
      }
    }
  }
}

/** The script for the invented menu above. A real script is recorded from the real SIM. */
export const SIM_WALLET_SCRIPT: PayoutMenuScript = {
  institution: 'telebirr',
  version: 1,
  dial: SIM_DIAL,
  numberFormat: 'local',
  amountFormat: 'whole_birr',
  steps: [
    {
      screen: 'Welcome to telebirr 1. Send Money 2. Buy Airtime 3. My Account',
      reply: { keys: '1' },
    },
    { screen: 'Enter mobile number', reply: { value: 'number' } },
    { screen: 'Enter amount', reply: { value: 'amount' } },
    {
      screen: 'Send {amount} Birr to {name} {number}? Fee {any} Birr. 1. Confirm 2. Cancel',
      reply: { keys: '1' },
    },
    { screen: 'Enter PIN', reply: { pin: true } },
  ],
  success: 'You have sent {amount} Birr to {number}. Transaction {reference}. Balance {any} Birr',
  failures: [
    { screen: 'Incorrect PIN{any}', code: 'wrong_pin' },
    { screen: 'Sorry, insufficient balance', code: 'insufficient_balance' },
  ],
};
