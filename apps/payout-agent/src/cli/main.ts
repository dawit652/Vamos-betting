import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { AtChannel, type BytePort } from '../at/chat';
import { loadScript } from '../script-file';
import { SimulatedModem } from '../sim/modem';
import { SIM_WALLET_SCRIPT, simWallet, SimWalletMenu } from '../sim/wallet-menu';
import { ModemUssdSession, prepareModem } from '../ussd/session';
import { recordCommand, rehearseCommand, type CliIo } from './commands';
import { probeModem, probeReportLines } from './probe';

/**
 * The payout agent's command line. Run from the repository root:
 *
 *   pnpm --filter @vamos/payout-agent cli probe --simulate
 *   pnpm --filter @vamos/payout-agent cli record --simulate --to 0911234567 --amount 15 --name "ABEBE KEBEDE"
 *   pnpm --filter @vamos/payout-agent cli rehearse --simulate --script scripts/telebirr.json --to 0922334455 --amount 40
 *
 * `--simulate` uses the invented wallet and modem of the tests (nothing real
 * is touched). A real modem (`--port COM5`, `--port /dev/ttyUSB0`) needs the
 * serial port library, which is not installed yet: see the README.
 */

const USAGE = `Usage: cli <probe | record | rehearse> (--simulate | --port <port>) [options]
  probe     [--ussd <code>]  check a modem; with --ussd, dial that code (a balance check) and hang up
  record    --to <number> --amount <birr> [--name <name as the menu shows it>]
            [--institution telebirr] [--dial *127#] [--number-format local|international]
            [--amount-format whole_birr|birr_and_santim] [--script scripts/<institution>.json]
            SENDS one real transfer and makes the menu script from it
  rehearse  --script <file> --to <number> --amount <birr> [--name <name>]
            walks the menu up to the step that sends, and hangs up there`;

function terminalIo(): CliIo & { close(): void } {
  let muted = false;
  // Echo goes through this stream: muted while the PIN is typed.
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return {
    print: (line) => {
      process.stdout.write(`${line}\n`);
    },
    ask: (question) => rl.question(question),
    askHidden: async (question) => {
      process.stdout.write(question);
      muted = true;
      try {
        return await rl.question('');
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
  };
}

async function openPort(options: {
  simulate: boolean;
  port: string | undefined;
}): Promise<BytePort> {
  if (options.simulate) {
    return new SimulatedModem(new SimWalletMenu(simWallet()));
  }
  if (options.port === undefined) throw new Error('say which modem: --port <port>, or --simulate');
  throw new Error(
    'talking to a real modem needs the serial port library, which is not installed yet (see apps/payout-agent/README.md)',
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      simulate: { type: 'boolean', default: false },
      port: { type: 'string' },
      ussd: { type: 'string' },
      to: { type: 'string' },
      amount: { type: 'string' },
      name: { type: 'string', default: '' },
      institution: { type: 'string', default: 'telebirr' },
      dial: { type: 'string', default: '*127#' },
      'number-format': { type: 'string', default: 'local' },
      'amount-format': { type: 'string', default: 'whole_birr' },
      script: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || command === undefined || !['probe', 'record', 'rehearse'].includes(command)) {
    console.error(USAGE);
    return command === undefined || values.help ? 0 : 2;
  }

  let port: BytePort;
  try {
    port = await openPort({ simulate: values.simulate, port: values.port });
  } catch (error) {
    console.error(`Cannot start: ${error instanceof Error ? error.message : String(error)}.`);
    return 2;
  }
  const io = terminalIo();
  const at = new AtChannel(port);
  const session = new ModemUssdSession(at);
  try {
    if (values.simulate) {
      io.print(
        'SIMULATED modem and wallet (invented, nothing real is touched). Its PIN is 482913.',
      );
    }
    if (command === 'probe') {
      const report = await probeModem(
        at,
        values.ussd === undefined ? {} : { ussd: values.ussd, session },
      );
      for (const line of probeReportLines(report)) io.print(line);
      return report.usable ? 0 : 1;
    }
    await prepareModem(at);
    if (command === 'record') {
      const numberFormat = values['number-format'] === 'international' ? 'international' : 'local';
      const amountFormat =
        values['amount-format'] === 'birr_and_santim' ? 'birr_and_santim' : 'whole_birr';
      const scriptPath = values.script ?? `scripts/${values.institution}.json`;
      return await recordCommand(io, session, {
        institution: values.institution,
        dial: values.dial,
        numberFormat,
        amountFormat,
        to: values.to ?? '',
        amount: values.amount ?? '',
        name: values.name,
        scriptPath,
        recordingPath: scriptPath.replace(/\.json$/, '') + '.recording.json',
      });
    }
    // rehearse
    let script = SIM_WALLET_SCRIPT;
    if (values.script !== undefined) {
      const loaded = await loadScript(values.script);
      if (!loaded.ok) {
        io.print(`The script cannot be used: ${loaded.problems.join('; ')}.`);
        return 2;
      }
      script = loaded.script;
    } else if (!values.simulate) {
      io.print('Say which script to rehearse: --script <file>.');
      return 2;
    }
    return await rehearseCommand(io, session, script, {
      to: values.to ?? '',
      amount: values.amount ?? '',
      name: values.name,
    });
  } finally {
    io.close();
    await at.close();
  }
}

// Run when started as a program (not when imported by a test).
if (
  process.argv[1]?.endsWith('main.ts') === true ||
  process.argv[1]?.endsWith('main.js') === true
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
