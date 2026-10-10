import { API_URL, WEB_URL } from './env';

/**
 * Start-up check: the API (demo mode, dev SMS inbox on) and the web app must
 * already be running. The e2e suite never starts them itself; see
 * e2e/README.md for the commands (fast simulator included).
 */
export async function assertStackUp(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = '';
  while (Date.now() < deadline) {
    lastProblem = await stackProblem();
    if (lastProblem === '') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `The e2e stack is not ready: ${lastProblem}\n` +
      `Start Postgres + Redis, then the API (${API_URL}), the worker with the fast simulator ` +
      `(SIM_SPEED=60 FEED_ROLLING_EVERY_MINUTES=1 FEED_ROLLING_HORIZON_MINUTES=10) and the web app ` +
      `(${WEB_URL}). See e2e/README.md.`,
  );
}

async function stackProblem(): Promise<string> {
  try {
    const health = await fetch(`${API_URL}/health`);
    if (!health.ok) return `GET ${API_URL}/health answered ${health.status}`;
    const body = (await health.json()) as { mode?: string };
    if (body.mode !== 'demo') return `the API runs in "${String(body.mode)}" mode, not demo`;
    // A valid number with no messages: 200 when the dev inbox is on, 404 when it is off.
    const inbox = await fetch(`${API_URL}/dev/sms?phone=%2B251900000000`);
    if (inbox.status === 404) {
      return 'the dev SMS inbox is off (it needs SMS_PROVIDER=mock and NODE_ENV other than production)';
    }
    const web = await fetch(`${WEB_URL}/`, { redirect: 'manual' });
    if (!web.ok) return `GET ${WEB_URL}/ answered ${web.status}`;
    return '';
  } catch (error) {
    return error instanceof Error
      ? `${error.message} (${String(error.cause ?? '')})`
      : String(error);
  }
}
