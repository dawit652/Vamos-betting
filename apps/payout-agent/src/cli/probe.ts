import type { AtChannel } from '../at/chat';
import { prepareModem, type UssdSession } from '../ussd/session';

/**
 * "Does this USB modem work for the payout sender?" asked of the modem
 * itself: does it answer commands, is its SIM ready (and not locked with its
 * own SIM PIN), is there a network and enough signal, does it say it can run
 * USSD menus, can it carry text in any script (UCS2) and read SMS (PDU mode).
 * Optionally it dials one code the owner chooses (a balance check) and shows
 * the first screen, then hangs up. Nothing here sends money or types a PIN.
 */

export interface ProbeCheck {
  name: string;
  /** true: fine; false: this stops the sender; null: the modem did not say (not fatal). */
  ok: boolean | null;
  detail: string;
}

export interface ProbeReport {
  usable: boolean;
  checks: ProbeCheck[];
}

const QUESTION_TIMEOUT_MS = 3_000;

/** Signal (`+CSQ` rssi, 0 to 31; 99 unknown) in words. */
export function signalInWords(rssi: number): { ok: boolean | null; detail: string } {
  if (rssi === 99 || !Number.isInteger(rssi) || rssi < 0 || rssi > 31) {
    return { ok: null, detail: 'the modem does not know the signal strength yet' };
  }
  if (rssi < 5)
    return { ok: false, detail: `${rssi} of 31: too weak, move the modem or the computer` };
  if (rssi < 10) return { ok: true, detail: `${rssi} of 31: weak, menus may time out` };
  if (rssi < 15) return { ok: true, detail: `${rssi} of 31: fair` };
  if (rssi < 20) return { ok: true, detail: `${rssi} of 31: good` };
  return { ok: true, detail: `${rssi} of 31: excellent` };
}

export async function probeModem(
  at: AtChannel,
  options: { ussd?: string; session?: UssdSession } = {},
): Promise<ProbeReport> {
  const checks: ProbeCheck[] = [];
  const ask = async (command: string): Promise<string[] | null> => {
    try {
      return await at.command(command, { timeoutMs: QUESTION_TIMEOUT_MS });
    } catch {
      return null;
    }
  };
  const valueOf = (lines: string[] | null, prefix: string): string | null => {
    const line = lines?.find((l) => l.startsWith(prefix));
    return line === undefined ? null : line.slice(prefix.length).trim();
  };

  const alive = await ask('AT');
  if (alive === null) {
    checks.push({
      name: 'Modem',
      ok: false,
      detail: 'no answer on this port: try the next port of the modem, or another modem',
    });
    return { usable: false, checks };
  }
  await ask('ATE0');
  const identity = (await ask('ATI'))?.filter((l) => l.trim() !== '') ?? [];
  const named =
    identity.length > 0
      ? identity.join(', ')
      : [valueOf(await ask('AT+CGMI'), ''), valueOf(await ask('AT+CGMM'), '')]
          .filter((v) => v !== null && v !== '')
          .join(' ');
  checks.push({ name: 'Modem', ok: true, detail: `answers commands${named ? ` (${named})` : ''}` });

  const cpin = valueOf(await ask('AT+CPIN?'), '+CPIN:');
  if (cpin === null) {
    checks.push({ name: 'SIM', ok: false, detail: 'no SIM card, or the modem cannot read it' });
  } else if (cpin.toUpperCase() === 'READY') {
    checks.push({ name: 'SIM', ok: true, detail: 'ready' });
  } else {
    checks.push({
      name: 'SIM',
      ok: false,
      detail: `the SIM asks for "${cpin}": switch the SIM's own PIN off in a phone first (this is not the wallet PIN)`,
    });
  }

  const csq = valueOf(await ask('AT+CSQ'), '+CSQ:');
  const rssi = csq === null ? Number.NaN : Number.parseInt(csq.split(',')[0] ?? '', 10);
  const signal = signalInWords(rssi);
  checks.push({ name: 'Signal', ...signal });

  const cops = valueOf(await ask('AT+COPS?'), '+COPS:');
  const operator = cops === null ? null : (/"([^"]*)"/.exec(cops)?.[1] ?? null);
  checks.push(
    operator === null || operator === ''
      ? { name: 'Network', ok: false, detail: 'not registered on a network' }
      : { name: 'Network', ok: true, detail: operator },
  );

  const ussd = await ask('AT+CUSD=?');
  checks.push(
    ussd === null
      ? {
          name: 'USSD menus',
          ok: null,
          detail:
            'the modem does not say; dial a code to find out (--ussd, for example a balance check)',
        }
      : { name: 'USSD menus', ok: true, detail: 'supported' },
  );

  const charsets = valueOf(await ask('AT+CSCS=?'), '+CSCS:');
  checks.push(
    charsets === null
      ? { name: 'Text in any script (UCS2)', ok: null, detail: 'the modem does not say' }
      : charsets.toUpperCase().includes('"UCS2"')
        ? { name: 'Text in any script (UCS2)', ok: true, detail: 'supported' }
        : {
            name: 'Text in any script (UCS2)',
            ok: null,
            detail: 'not offered: menus will be read as plain text (GSM)',
          },
  );

  const cmgf = valueOf(await ask('AT+CMGF=?'), '+CMGF:');
  checks.push(
    cmgf !== null && cmgf.includes('0')
      ? { name: 'Reading SMS (PDU mode)', ok: true, detail: 'supported' }
      : { name: 'Reading SMS (PDU mode)', ok: null, detail: 'the modem does not say' },
  );

  if (options.ussd !== undefined && options.session !== undefined) {
    try {
      await prepareModem(at);
      const screen = await options.session.dial(options.ussd);
      checks.push({
        name: `Dialled ${options.ussd}`,
        ok: true,
        detail: `the menu answered: "${screen.text.replace(/\s+/g, ' ').trim()}"`,
      });
    } catch {
      checks.push({
        name: `Dialled ${options.ussd}`,
        ok: false,
        detail: 'no menu came back: this modem may not run USSD menus',
      });
    } finally {
      await options.session.cancel();
    }
  }

  const usable = checks.every((check) => check.ok !== false);
  return { usable, checks };
}

/** The report as lines for the owner. */
export function probeReportLines(report: ProbeReport): string[] {
  const mark = (ok: boolean | null) => (ok === true ? 'OK  ' : ok === false ? 'NO  ' : '??  ');
  return [
    ...report.checks.map((check) => `${mark(check.ok)}${check.name}: ${check.detail}`),
    '',
    report.usable
      ? 'This modem looks usable for the payout sender. Next: record one transfer (see the README).'
      : 'This modem cannot be used as it is: see the lines marked NO.',
  ];
}
