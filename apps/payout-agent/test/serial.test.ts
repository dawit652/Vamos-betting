import { SerialPortMock } from 'serialport';
import { afterEach, describe, expect, it } from 'vitest';
import { AtChannel, type BytePort } from '../src/at/chat';
import { checkPorts, portCheckLines } from '../src/cli/ports';
import { openFailureHint, openSerialPort, type SerialPortLike } from '../src/port/serial';
import { SimulatedModem } from '../src/sim/modem';
import { simWallet, SimWalletMenu } from '../src/sim/wallet-menu';

/** The parts of the library's mock binding the tests drive (its types live in a transitive package). */
interface MockBindingLike {
  createPort(path: string, options?: { echo?: boolean; record?: boolean }): void;
  reset(): void;
}
interface MockPortLike {
  recording: Buffer;
  emitData(data: Buffer | string): void;
}
const binding = SerialPortMock.binding as unknown as MockBindingLike;
const mockPortOf = (mock: SerialPortMock) => mock.port as unknown as MockPortLike | undefined;

/** Opens `path` on the library's mock binding and hands the mock back for the test to drive. */
async function mockPort(path: string) {
  binding.createPort(path, { echo: false, record: true });
  let mock: SerialPortMock | null = null;
  const port = await openSerialPort(path, {
    create: (options) => {
      mock = new SerialPortMock(options);
      return mock;
    },
  });
  if (mock === null) throw new Error('no mock port');
  const opened: SerialPortMock = mock;
  return { port, mock: opened, wire: () => mockPortOf(opened) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  binding.reset();
});

describe('openSerialPort', () => {
  it('writes commands to the port and hands back what the modem sends', async () => {
    const { port, mock, wire } = await mockPort('/dev/ttyUSB2');
    const received: string[] = [];
    port.onData((chunk) => received.push(chunk));
    await port.write('AT\r');
    expect(wire()?.recording.toString('latin1')).toBe('AT\r');
    wire()?.emitData(Buffer.from('\r\nOK\r\n', 'latin1'));
    await tick();
    expect(received.join('')).toBe('\r\nOK\r\n');
    await port.close();
    expect(mock.isOpen).toBe(false);
    await port.close(); // twice is harmless
  });

  it('carries an AT conversation, the UCS2 hex of a menu included', async () => {
    const { port, wire } = await mockPort('/dev/ttyUSB0');
    const at = new AtChannel(port, { commandTimeoutMs: 500 });
    const answer = at.command('AT+CSQ');
    await tick();
    expect(wire()?.recording.toString('latin1')).toBe('AT+CSQ\r');
    wire()?.emitData('\r\n+CSQ: 21,99\r\n\r\nOK\r\n');
    expect(await answer).toEqual(['+CSQ: 21,99']);
    await at.close();
  });

  it('refuses a port that does not exist, with a hint for the owner', async () => {
    await expect(
      openSerialPort('/dev/ttyNOPE', {
        create: (options) => new SerialPortMock(options) as unknown as SerialPortLike,
      }),
    ).rejects.toThrow();
    expect(
      openFailureHint(new Error('Error: Permission denied, cannot open /dev/ttyUSB2')),
    ).toMatch(/dialout/);
    expect(openFailureHint(new Error('Error: No such file or directory'))).toMatch(/cli ports/);
    expect(openFailureHint(new Error('Opening COM5: Access denied'))).toMatch(/Another program/);
  });
});

describe('checkPorts', () => {
  const silent: BytePort = {
    write: async () => undefined,
    onData: () => undefined,
    close: async () => undefined,
  };

  it('says which port answers commands, which is silent and which cannot be opened', async () => {
    const checks = await checkPorts(
      async () => [
        { path: '/dev/ttyUSB0', description: 'HUAWEI, USB 12d1:1506' },
        { path: '/dev/ttyUSB1', description: '' },
        { path: '/dev/ttyUSB2', description: '' },
      ],
      async (path) => {
        if (path === '/dev/ttyUSB0') return silent;
        if (path === '/dev/ttyUSB1') return new SimulatedModem(new SimWalletMenu(simWallet()));
        throw new Error('Error: Permission denied, cannot open /dev/ttyUSB2');
      },
      100,
    );
    expect(checks.map((c) => [c.path, c.answers])).toEqual([
      ['/dev/ttyUSB0', false],
      ['/dev/ttyUSB1', true],
      ['/dev/ttyUSB2', null],
    ]);
    const lines = portCheckLines(checks);
    expect(lines[0]).toBe(
      '--  /dev/ttyUSB0 (HUAWEI, USB 12d1:1506): no answer to AT (not the command port)',
    );
    expect(lines[1]).toMatch(/^OK {2}\/dev\/ttyUSB1: answers commands/);
    expect(lines[2]).toMatch(/^NO {2}\/dev\/ttyUSB2: cannot open: .*dialout/);
    expect(lines.at(-1)).toBe('Next: cli probe --port /dev/ttyUSB1');
  });

  it('explains an empty list', async () => {
    const lines = portCheckLines(
      await checkPorts(
        async () => [],
        async () => silent,
      ),
    );
    expect(lines[0]).toMatch(/No serial ports found/);
  });
});
