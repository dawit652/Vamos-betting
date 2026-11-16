import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseAmount,
  parseReceiver,
  parseRecordAnswer,
  pinBeforeCommit,
  recordCommand,
  rehearseCommand,
  type CliIo,
} from '../src/cli/commands';
import { probeModem, probeReportLines, signalInWords } from '../src/cli/probe';
import { loadRecording, loadScript } from '../src/script-file';
import { SIM_WALLET_SCRIPT } from '../src/sim/wallet-menu';
import { rig, type RigOptions } from './helpers';

/** A person at the terminal: answers in order, and remembers everything shown. */
function scriptedIo(answers: string[], hidden: string[] = []) {
  const shown: string[] = [];
  const asked: string[] = [];
  const io: CliIo = {
    print: (line) => {
      shown.push(line);
    },
    ask: async (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no answer left for "${question}"`);
      return answer;
    },
    askHidden: async (question) => {
      asked.push(question);
      const answer = hidden.shift();
      if (answer === undefined) throw new Error(`no hidden answer left for "${question}"`);
      return answer;
    },
  };
  return { io, shown, asked, text: () => shown.join('\n') };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'payout-agent-cli-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('probe', () => {
  const probe = async (options: RigOptions, ussd?: string) => {
    const r = await rig(options);
    const report = await probeModem(r.at, ussd === undefined ? {} : { ussd, session: r.session });
    return { ...r, report, lines: probeReportLines(report) };
  };

  it('says a healthy modem is usable, in words', async () => {
    const { report, lines } = await probe({});
    expect(report.usable).toBe(true);
    expect(lines.join('\n')).toContain('OK  SIM: ready');
    expect(lines.join('\n')).toContain('OK  Signal: 18 of 31: good');
    expect(lines.join('\n')).toContain('OK  Network: ethio telecom');
    expect(lines.at(-1)).toMatch(/looks usable/);
  });

  it('names what stops a modem: no SIM, a SIM locked with its own PIN, no network', async () => {
    const noSim = await probe({ modem: { info: { cpin: null } } });
    expect(noSim.report.usable).toBe(false);
    expect(noSim.lines.join('\n')).toContain('NO  SIM: no SIM card');
    const locked = await probe({ modem: { info: { cpin: 'SIM PIN' } } });
    expect(locked.lines.join('\n')).toMatch(
      /NO {2}SIM: the SIM asks for "SIM PIN".*not the wallet PIN/,
    );
    const noNetwork = await probe({ modem: { info: { cops: '0' } } });
    expect(noNetwork.lines.join('\n')).toContain('NO  Network: not registered');
  });

  it('does not fail a modem for what it does not say, and dials a code only when asked', async () => {
    const quiet = await probe({ modem: { info: { ussdTest: false, charsets: null, cmgf: null } } });
    expect(quiet.report.usable).toBe(true);
    expect(quiet.lines.join('\n')).toContain('??  USSD menus');
    expect(quiet.modem.commands.some((c) => c.startsWith('AT+CUSD=1'))).toBe(false);

    const dialled = await probe({}, '*127#');
    expect(dialled.lines.join('\n')).toMatch(
      /OK {2}Dialled \*127#: the menu answered: "Welcome to telebirr/,
    );
    expect(dialled.modem.commands.at(-1)).toBe('AT+CUSD=2');
    expect(dialled.wallet.transfers).toEqual([]);
  });

  it('reads the signal strength in words', () => {
    expect(signalInWords(99).ok).toBeNull();
    expect(signalInWords(3)).toMatchObject({ ok: false });
    expect(signalInWords(7).detail).toMatch(/weak/);
    expect(signalInWords(25).detail).toMatch(/excellent/);
  });
});

describe("the owner's inputs", () => {
  it('reads numbers, amounts and answers', () => {
    expect(parseReceiver('0911 234 567')).toEqual({ ok: true, value: '+251911234567' });
    expect(parseReceiver('12345').ok).toBe(false);
    expect(parseAmount('15')).toEqual({ ok: true, value: 1_500n });
    expect(parseAmount('15.5')).toEqual({ ok: true, value: 1_550n });
    expect(parseAmount('0').ok).toBe(false);
    expect(parseAmount('ten').ok).toBe(false);
    expect(parseRecordAnswer(' n ')).toEqual({ kind: 'number' });
    expect(parseRecordAnswer('A')).toEqual({ kind: 'amount' });
    expect(parseRecordAnswer('p')).toBe('pin');
    expect(parseRecordAnswer('q')).toEqual({ kind: 'abort' });
    expect(parseRecordAnswer('*1#')).toEqual({ kind: 'keys', text: '*1#' });
    expect(parseRecordAnswer('yes')).toBeNull();
    expect(parseRecordAnswer('482913x')).toBeNull();
  });

  it('knows which menus ask the PIN before the step that sends', () => {
    expect(pinBeforeCommit(SIM_WALLET_SCRIPT)).toBe(false);
    const pinFirst = {
      ...SIM_WALLET_SCRIPT,
      steps: [SIM_WALLET_SCRIPT.steps[4]!, ...SIM_WALLET_SCRIPT.steps.slice(0, 4)],
    };
    expect(pinBeforeCommit(pinFirst)).toBe(true);
  });
});

describe('record', () => {
  it('sends the one transfer, saves a script that works, and never shows or stores the PIN', async () => {
    const r = await rig();
    const scriptPath = join(dir, 'telebirr.json');
    const recordingPath = join(dir, 'telebirr.recording.json');
    // SEND, then one answer per screen; one wrong answer is asked again.
    const person = scriptedIo(['SEND', '1', 'N', 'A', 'maybe', '1', 'P'], [r.wallet.pin]);
    const code = await recordCommand(person.io, r.session, {
      institution: 'telebirr',
      dial: '*127#',
      numberFormat: 'local',
      amountFormat: 'whole_birr',
      to: '0911234567',
      amount: '15',
      name: 'ABEBE KEBEDE',
      scriptPath,
      recordingPath,
    });
    expect(code).toBe(0);
    expect(r.wallet.transfers).toEqual([
      { to: '0911234567', amount: 1_500n, reference: 'SIM0000001' },
    ]);
    expect(person.text()).toContain('Type the keys you would press');

    const loaded = await loadScript(scriptPath);
    if (!loaded.ok) throw new Error(loaded.problems.join('; '));
    expect(loaded.script.steps).toEqual(SIM_WALLET_SCRIPT.steps);
    const recording = await loadRecording(recordingPath);
    expect(recording.amount).toBe(1_500n);
    expect((await stat(recordingPath)).mode & 0o777).toBe(0o600);

    for (const text of [
      person.text(),
      await readFile(scriptPath, 'utf8'),
      await readFile(recordingPath, 'utf8'),
    ]) {
      expect(text).not.toContain(r.wallet.pin);
    }
  });

  it('starts nothing without SEND, a valid number or enough birr', async () => {
    for (const [to, amount, answers] of [
      ['0911234567', '15', ['no']],
      ['12345', '15', []],
      ['0911234567', '5', []],
    ] as const) {
      const r = await rig();
      const person = scriptedIo([...answers]);
      const code = await recordCommand(person.io, r.session, {
        institution: 'telebirr',
        dial: '*127#',
        numberFormat: 'local',
        amountFormat: 'whole_birr',
        to,
        amount,
        name: '',
        scriptPath: join(dir, 'unused.json'),
        recordingPath: join(dir, 'unused.recording.json'),
      });
      expect(code).toBeGreaterThan(0);
      expect(r.modem.commands.some((c) => c.startsWith('AT+CUSD=1'))).toBe(false);
      expect(r.wallet.transfers).toEqual([]);
    }
  });

  it('gives up on Q with nothing sent and nothing saved', async () => {
    const r = await rig();
    const person = scriptedIo(['SEND', '1', 'Q']);
    const scriptPath = join(dir, 'given-up.json');
    const code = await recordCommand(person.io, r.session, {
      institution: 'telebirr',
      dial: '*127#',
      numberFormat: 'local',
      amountFormat: 'whole_birr',
      to: '0911234567',
      amount: '15',
      name: '',
      scriptPath,
      recordingPath: join(dir, 'given-up.recording.json'),
    });
    expect(code).toBe(1);
    expect(r.wallet.transfers).toEqual([]);
    expect(person.text()).toContain('Nothing recorded: given up.');
    await expect(stat(scriptPath)).rejects.toThrow();
  });
});

describe('rehearse', () => {
  it('walks another payout to the step that sends, asks no PIN, sends nothing', async () => {
    const r = await rig();
    const person = scriptedIo([]);
    const code = await rehearseCommand(person.io, r.session, SIM_WALLET_SCRIPT, {
      to: '0922334455',
      amount: '40',
      name: 'Sara Haile',
    });
    expect(code).toBe(0);
    expect(person.asked).toEqual([]);
    expect(r.wallet.transfers).toEqual([]);
    expect(r.wallet.pinsTyped).toBe(0);
    expect(person.text()).toMatch(/Rehearsed: the menu matched the script/);
    expect(person.text()).toContain('> 0922334455');
  });

  it('stops and says nothing was sent when the menu shows another name', async () => {
    const r = await rig();
    const person = scriptedIo([]);
    const code = await rehearseCommand(person.io, r.session, SIM_WALLET_SCRIPT, {
      to: '0922334455',
      amount: '40',
      name: 'Abebe Kebede',
    });
    expect(code).toBe(1);
    expect(person.text()).toMatch(/The rehearsal stopped: name_differs\. Nothing was sent\./);
  });
});
