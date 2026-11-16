import { describe, expect, it } from 'vitest';
import { AtChannel, AtError, AtTimeoutError, type BytePort } from '../src/at/chat';

/** A port whose answers the test writes by hand. */
function fakePort() {
  const written: string[] = [];
  let listener: (chunk: string) => void = () => undefined;
  const port: BytePort = {
    write: async (data) => {
      written.push(data);
    },
    onData: (l) => {
      listener = l;
    },
    close: async () => undefined,
  };
  return { port, written, feed: (chunk: string) => listener(chunk) };
}

/** Lets a queued command reach the port: a modem answers only what it was sent. */
const written = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AtChannel', () => {
  it('resolves a command with its information lines once the modem says OK', async () => {
    const { port, written: sent, feed } = fakePort();
    const at = new AtChannel(port);
    const answer = at.command('AT+CSQ');
    await written();
    expect(sent).toEqual(['AT+CSQ\r']);
    feed('\r\n+CSQ: 21,99\r\n\r\nOK\r\n');
    expect(await answer).toEqual(['+CSQ: 21,99']);
  });

  it('puts an answer together from any pieces, and skips the echo of the command', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port);
    const answer = at.command('AT+CSQ');
    await written();
    for (const piece of ['AT+C', 'SQ\r\r\n+CS', 'Q: 21,99\r', '\n\r\nO', 'K\r\n']) feed(piece);
    expect(await answer).toEqual(['+CSQ: 21,99']);
  });

  it('rejects with the result code on an error, without the text of a sensitive command', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port);
    const refused = at.command('AT+FOO');
    await written();
    feed('\r\n+CME ERROR: 100\r\n');
    await expect(refused).rejects.toMatchObject({ name: 'AtError', result: '+CME ERROR: 100' });

    const secret = at.command('AT+CUSD=1,"482913",15', { sensitive: true });
    await written();
    feed('\r\nERROR\r\n');
    const error = await secret.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtError);
    expect(String((error as AtError).message)).not.toContain('482913');
    expect((error as AtError).command).toBe('<hidden>');
  });

  it('times out when no result code comes, and drops the late answer', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port, { commandTimeoutMs: 20 });
    await expect(at.command('AT+SLOW')).rejects.toBeInstanceOf(AtTimeoutError);
    feed('\r\nOK\r\n'); // the late answer of AT+SLOW must not answer the next command
    const next = at.command('AT');
    await new Promise((resolve) => setTimeout(resolve, 5));
    feed('\r\nOK\r\n');
    expect(await next).toEqual([]);
  });

  it('gives an unsolicited line to whoever waits for it, also in the middle of a command', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port);
    const screen = at.waitForUnsolicited('+CUSD:', 200);
    const command = at.command('AT+CUSD=1,"002A",15');
    await written();
    feed('\r\n+CUSD: 1,"0031",72\r\n\r\nOK\r\n');
    expect(await command).toEqual([]);
    expect(await screen.promise).toBe('+CUSD: 1,"0031",72');
  });

  it('keeps unsolicited lines nobody waited for apart: a later wait does not get them', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port);
    feed('\r\n+CUSD: 0,"late",15\r\n\r\n+CMTI: "SM",3\r\n');
    const wait = at.waitForUnsolicited('+CUSD:', 20);
    await expect(wait.promise).rejects.toBeInstanceOf(AtTimeoutError);
    expect(at.drainUnsolicited('+CUSD:')).toEqual(['+CUSD: 0,"late",15']);
    expect(at.drainUnsolicited('+CUSD:')).toEqual([]);
    expect(at.drainUnsolicited('+CMTI:')).toEqual(['+CMTI: "SM",3']);
  });

  it('reads a plain-text screen with line breaks as one line', async () => {
    const { port, feed } = fakePort();
    const at = new AtChannel(port);
    const screen = at.waitForUnsolicited('+CUSD:', 200);
    feed('\r\n+CUSD: 1,"Welcome\r\n1. Send Money\r\n2. Buy Airtime",15\r\n');
    expect(await screen.promise).toBe('+CUSD: 1,"Welcome\n\n1. Send Money\n\n2. Buy Airtime",15');
  });

  it('runs commands one after another', async () => {
    const { port, written: sent, feed } = fakePort();
    const at = new AtChannel(port);
    const first = at.command('AT+ONE');
    const second = at.command('AT+TWO');
    await written();
    expect(sent).toEqual(['AT+ONE\r']);
    feed('\r\nOK\r\n');
    await first;
    await written();
    expect(sent).toEqual(['AT+ONE\r', 'AT+TWO\r']);
    feed('\r\nOK\r\n');
    await second;
  });

  it('traces every line except a sensitive command and its echo', async () => {
    const { port, feed } = fakePort();
    const trace: string[] = [];
    const at = new AtChannel(port, {
      onLine: (direction, line) => trace.push(`${direction} ${line}`),
    });
    const pin = at.command('AT+CUSD=1,"482913",15', { sensitive: true });
    await written();
    feed('AT+CUSD=1,"482913",15\r\r\nOK\r\n');
    await pin;
    expect(trace).toEqual(['out <hidden>', 'in OK']);
  });

  it('rejects what is in flight when the port is closed', async () => {
    const { port } = fakePort();
    const at = new AtChannel(port);
    const command = at.command('AT');
    const wait = at.waitForUnsolicited('+CUSD:', 1000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await at.close();
    await expect(command).rejects.toThrow('closed');
    await expect(wait.promise).rejects.toThrow('closed');
    await expect(at.command('AT')).rejects.toThrow('closed');
  });
});
