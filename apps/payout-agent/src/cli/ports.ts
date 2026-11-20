import { AtChannel, type BytePort } from '../at/chat';
import { openFailureHint, type ListedPort } from '../port/serial';

/**
 * "Which of these ports is the modem's command port?" A USB modem shows
 * several serial ports and only one or two of them answer AT commands; each
 * is opened in turn, sent `AT`, and closed again. Nothing is dialled.
 */

export interface PortCheck {
  path: string;
  description: string;
  /** true: answers commands; false: opened but silent; null: could not be opened. */
  answers: boolean | null;
  detail: string;
}

/** How long one port may take to open before it is skipped. */
export const PORT_OPEN_TIMEOUT_MS = 5_000;

class OpenTimeout extends Error {}

export async function checkPorts(
  list: () => Promise<ListedPort[]>,
  open: (path: string) => Promise<BytePort>,
  timeoutMs = 2_000,
  openTimeoutMs = PORT_OPEN_TIMEOUT_MS,
): Promise<PortCheck[]> {
  const checks: PortCheck[] = [];
  for (const port of await list()) {
    let opened: BytePort;
    // On Windows a Bluetooth serial port can take very long to open (it tries to reach the paired
    // device), or never: skip it after a while, and close it if it opens later.
    const opening = open(port.path);
    let timer: NodeJS.Timeout | undefined;
    try {
      opened = await Promise.race([
        opening,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OpenTimeout()), openTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof OpenTimeout) {
        opening.then((late) => late.close()).catch(() => undefined);
        checks.push({
          ...port,
          answers: null,
          detail: `did not open within ${openTimeoutMs / 1000} s (a Bluetooth port?): skipped`,
        });
      } else {
        checks.push({ ...port, answers: null, detail: `cannot open: ${openFailureHint(error)}` });
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
    const at = new AtChannel(opened, { commandTimeoutMs: timeoutMs });
    try {
      await at.command('AT');
      checks.push({ ...port, answers: true, detail: 'answers commands: use this one with --port' });
    } catch {
      checks.push({ ...port, answers: false, detail: 'no answer to AT (not the command port)' });
    } finally {
      await at.close().catch(() => undefined);
    }
  }
  return checks;
}

export function portCheckLines(checks: readonly PortCheck[]): string[] {
  if (checks.length === 0) {
    return [
      'No serial ports found. Plug the modem in and wait a few seconds; on Windows install the',
      "modem's driver (it usually comes on the modem itself, as a small drive) if it shows none.",
    ];
  }
  const lines = checks.map(
    (check) =>
      `${check.answers === true ? 'OK  ' : check.answers === false ? '--  ' : 'NO  '}${check.path}` +
      `${check.description === '' ? '' : ` (${check.description})`}: ${check.detail}`,
  );
  const usable = checks.filter((check) => check.answers === true);
  lines.push(
    '',
    usable.length === 0
      ? 'No port answered: try another USB socket, or the modem may only work as a network adapter.'
      : `Next: cli probe --port ${usable[0]?.path ?? ''}`,
  );
  return lines;
}
