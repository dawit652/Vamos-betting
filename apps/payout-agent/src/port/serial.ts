import { readdir } from 'node:fs/promises';
import { SerialPort } from 'serialport';
import type { BytePort } from '../at/chat';

/**
 * The USB modem's command port, through the `serialport` library (prebuilt
 * for Windows, Linux and macOS; the owner approved it on 16 Nov 2026). This
 * is the only file that touches the hardware: everything above it speaks to
 * the `BytePort` interface, which the tests serve with a simulated modem.
 */

/** USB modems take any speed on their virtual port; 115200 is what they report. */
export const DEFAULT_BAUD_RATE = 115_200;

/** What the adapter needs of a serial port (the real one, or the library's mock in tests). */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(
    data: string,
    encoding: BufferEncoding,
    callback: (error: Error | null | undefined) => void,
  ): boolean;
  drain(callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  on(event: 'error' | 'close', listener: (error?: Error) => void): unknown;
}

export type SerialPortFactory = (options: {
  path: string;
  baudRate: number;
  autoOpen: false;
}) => SerialPortLike;

const realPort: SerialPortFactory = (options) => new SerialPort(options);

/** Opens `path` (`COM5`, `/dev/ttyUSB2`) and gives it as a `BytePort`. */
export async function openSerialPort(
  path: string,
  options: { baudRate?: number; create?: SerialPortFactory } = {},
): Promise<BytePort> {
  const port = (options.create ?? realPort)({
    path,
    baudRate: options.baudRate ?? DEFAULT_BAUD_RATE,
    autoOpen: false,
  });
  await new Promise<void>((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });
  const listeners: ((chunk: string) => void)[] = [];
  // AT traffic is ASCII (UCS2 travels as hex), so latin1 maps every byte to one character.
  port.on('data', (data: Buffer) => {
    const text = data.toString('latin1');
    for (const listener of listeners) listener(text);
  });
  // The modem pulled out or a driver error: never an uncaught crash. Commands in flight then
  // time out, and a session that breaks is reported by the runner from what was typed.
  port.on('error', () => undefined);
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        port.write(data, 'latin1', (error) => {
          if (error) {
            reject(error);
            return;
          }
          port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
        });
      }),
    onData: (listener) => {
      listeners.push(listener);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!port.isOpen) {
          resolve();
          return;
        }
        port.close(() => resolve());
      }),
  };
}

export interface ListedPort {
  path: string;
  /** Maker and USB ids when the system knows them. */
  description: string;
}

/** The fields of the library's port list that are used (its own type lives in a transitive package). */
interface PortInfoLike {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

/**
 * The serial ports of this computer. Where the system list is unavailable on Linux (no udev, as in
 * a container) the device names USB modems get (`/dev/ttyUSB*`, `/dev/ttyACM*`) are listed instead.
 * Anywhere else a failure to list is NOT turned into "no ports": it is thrown, so a serial library
 * that did not load is told apart from a modem that is not plugged in.
 */
export async function listSerialPorts(
  options: {
    list?: () => Promise<PortInfoLike[]>;
    platform?: string;
    devices?: () => Promise<string[]>;
  } = {},
): Promise<ListedPort[]> {
  const list = options.list ?? (async () => (await SerialPort.list()) as PortInfoLike[]);
  try {
    const ports = await list();
    return ports.map((port) => ({
      path: port.path,
      description: [
        port.manufacturer,
        port.vendorId !== undefined && port.productId !== undefined
          ? `USB ${port.vendorId}:${port.productId}`
          : undefined,
      ]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(', '),
    }));
  } catch (error) {
    if ((options.platform ?? process.platform) !== 'linux') throw error;
    const names = await (options.devices ?? (() => readdir('/dev')))().catch(() => [] as string[]);
    return names
      .filter((name) => /^tty(USB|ACM)\d+$/.test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => ({ path: `/dev/${name}`, description: '' }));
  }
}

/** What to tell the owner when a port does not open. */
export function openFailureHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied|EACCES/i.test(message)) {
    return `${message}. On Linux add yourself to the "dialout" group (sudo usermod -aG dialout $USER), then sign out and in again`;
  }
  if (/no such file|ENOENT|cannot find|not found/i.test(message)) {
    return `${message}. The modem is not plugged in, or the port has another name: run "cli ports"`;
  }
  if (/busy|access denied|EBUSY/i.test(message)) {
    return `${message}. Another program holds the port (the modem's own dashboard?): close it`;
  }
  return message;
}
