/** Server-Sent Events test client shared by the stream tests. */

export interface Frame {
  event?: string;
  data?: string;
  comments: string[];
  retry?: number;
}

export interface SseClient {
  status: number;
  headers: Headers;
  frames: Frame[];
  /** Resolves once the server has ended the stream. */
  ended: Promise<void>;
  waitFor(predicate: (frames: Frame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

export function parseFrame(raw: string): Frame {
  const frame: Frame = { comments: [] };
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) frame.comments.push(line.slice(1).trim());
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = line.slice(6);
    else if (line.startsWith('retry: ')) frame.retry = Number(line.slice(7));
  }
  return frame;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition: () => boolean, timeoutMs = 3_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Opens an SSE stream with fetch() and parses frames as they arrive. */
export async function openStream(
  baseUrl: string,
  path = '/live/stream',
  headers: Record<string, string> = {},
): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream', ...headers },
  });
  const frames: Frame[] = [];
  let ended: Promise<void> = Promise.resolve();
  if (response.body !== null && response.ok) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    ended = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            frames.push(parseFrame(buffer.slice(0, end)));
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
  }
  return {
    status: response.status,
    headers: response.headers,
    frames,
    ended,
    waitFor: (predicate, timeoutMs = 3_000) =>
      until(() => predicate(frames), timeoutMs, 'SSE frames'),
    close: () => controller.abort(),
  };
}
