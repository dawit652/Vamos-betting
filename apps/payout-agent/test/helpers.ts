import type { PayoutMenuTransfer } from '@vamos/core';
import { AtChannel } from '../src/at/chat';
import type { ModemCharset } from '../src/at/codec';
import type { PinSource } from '../src/runner';
import { SimulatedModem, type SimModemOptions } from '../src/sim/modem';
import {
  simWallet,
  SimWalletMenu,
  type MenuFault,
  type MenuQuirks,
  type SimWallet,
} from '../src/sim/wallet-menu';
import { ModemUssdSession, prepareModem } from '../src/ussd/session';

export const TRANSFER: PayoutMenuTransfer = {
  number: '+251911234567',
  amount: 150_000n, // ETB 1,500
  name: 'Abebe Kebede Tesfaye',
};

export const pinOf = (wallet: SimWallet): PinSource => ({ get: () => wallet.pin });
export const NO_PIN: PinSource = { get: () => null };

export interface RigOptions {
  fault?: MenuFault | null;
  quirks?: MenuQuirks;
  wallet?: Partial<SimWallet>;
  modem?: SimModemOptions;
  charset?: ModemCharset;
  stepTimeoutMs?: number;
}

/** A simulated wallet behind a simulated modem, with the agent's own channel and session on it. */
export async function rig(options: RigOptions = {}) {
  const wallet = simWallet(options.wallet);
  const menu = new SimWalletMenu(wallet, options.fault ?? null, options.quirks ?? {});
  const modem = new SimulatedModem(menu, options.modem);
  const trace: string[] = [];
  const at = new AtChannel(modem, {
    commandTimeoutMs: 300,
    onLine: (direction, line) => trace.push(`${direction} ${line}`),
  });
  const charset = options.charset ?? 'UCS2';
  await prepareModem(at, { charset });
  const session = new ModemUssdSession(at, {
    charset,
    stepTimeoutMs: options.stepTimeoutMs ?? 40,
    commandTimeoutMs: 300,
  });
  return { wallet, menu, modem, at, session, trace };
}
