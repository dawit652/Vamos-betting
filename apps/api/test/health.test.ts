import { loadConfig } from '@vamos/config';
import { HealthResponseSchema } from '@vamos/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

describe('GET /health', () => {
  const app = buildApp({ config: loadConfig({ LOG_LEVEL: 'silent' }) }, { logger: false });
  afterAll(() => app.close());

  it('reports ok and the operating mode', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(response.json());
    expect(body.mode).toBe('demo');
    expect(response.headers['x-vamos-mode']).toBe('demo');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('returns the API error shape for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
