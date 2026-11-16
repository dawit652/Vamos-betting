import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validatePayoutMenuScript, type MenuRecording, type PayoutMenuScript } from '@vamos/core';

/**
 * The files the agent keeps on its machine: the menu script (what to type, no
 * secret in it) and the recording it was made from (the screens of one real
 * transfer: the receiver's number and name, the balance; kept private, mode
 * 600). The PIN is in neither: a recording only says where it was typed.
 */

export async function saveScript(path: string, script: PayoutMenuScript): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(script, null, 2)}\n`, { mode: 0o644 });
}

export type LoadedScript =
  { ok: true; script: PayoutMenuScript } | { ok: false; problems: string[] };

export async function loadScript(path: string): Promise<LoadedScript> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { ok: false, problems: [`cannot read a script from ${path}`] };
  }
  const script = parsed as PayoutMenuScript;
  const problems = validatePayoutMenuScript(script);
  return problems.length === 0 ? { ok: true, script } : { ok: false, problems };
}

/** The recording as JSON: the amount in santim as a decimal string. */
export async function saveRecording(path: string, recording: MenuRecording): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const json = JSON.stringify({ ...recording, amount: recording.amount.toString() }, null, 2);
  await writeFile(path, `${json}\n`, { mode: 0o600 });
}

export async function loadRecording(path: string): Promise<MenuRecording> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Omit<MenuRecording, 'amount'> & {
    amount: string;
  };
  if (!/^\d+$/.test(parsed.amount)) throw new Error('the recording has no amount in santim');
  return { ...parsed, amount: BigInt(parsed.amount) };
}
