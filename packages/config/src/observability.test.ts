import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOG_REDACTED, logRedactPaths, redactUrl, requestIdFrom } from './logging';
import { NOOP_TELEMETRY, otlpTracesUrl, startTelemetry } from './telemetry';

describe('request ids', () => {
  it('accepts a well-formed incoming id and replaces anything else', () => {
    for (const ok of [
      '3f2b8c1e-0a4d-4b7e-9f61-2c5d8e7a9b10',
      'abcdef12',
      'Root=1-67891233-abcdef012345678912345678',
      'lb.req_0001:42',
    ]) {
      expect(requestIdFrom(ok), ok).toBe(ok);
    }
    expect(requestIdFrom(['abcdef1234', 'other'])).toBe('abcdef1234');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const bad of [
      undefined,
      '',
      'short',
      'has space in it',
      'line\nbreak-injected',
      '-starts-with-dash',
      'x'.repeat(129),
      '{"json":true}',
      42,
    ]) {
      expect(requestIdFrom(bad), String(bad)).toMatch(uuid);
    }
    expect(requestIdFrom(undefined)).not.toBe(requestIdFrom(undefined));
  });
});

describe('log redaction', () => {
  it('covers headers and secret fields at several depths', () => {
    const paths = logRedactPaths();
    expect(paths).toContain('req.headers["authorization"]'.replace('req.', '*.'));
    expect(paths).toContain('*.body.code');
    expect(paths).toContain('*.*.password');
    expect(paths).not.toContain('*.code');
  });

  it('redacts secret query parameters only', () => {
    expect(redactUrl('/auth/password/reset?token=abc&lang=am')).toBe(
      `/auth/password/reset?token=${LOG_REDACTED}&lang=am`,
    );
    expect(redactUrl('/x?CODE=123456&Pin=1234&page=2')).toBe(
      `/x?CODE=${LOG_REDACTED}&Pin=${LOG_REDACTED}&page=2`,
    );
    expect(redactUrl('/events?sport=football')).toBe('/events?sport=football');
    expect(redactUrl('/health')).toBe('/health');
  });
});

describe('telemetry', () => {
  it('is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    const telemetry = await startTelemetry(
      { telemetry: { otlpEndpoint: undefined, serviceName: undefined } },
      'vamos-test',
    );
    expect(telemetry).toBe(NOOP_TELEMETRY);
    const span = telemetry.startSpan('GET /health', { kind: 'server' });
    span.setAttributes({ 'http.response.status_code': 200 });
    span.recordError(new Error('ignored'));
    span.end();
    expect(span.traceId).toBeNull();
    await telemetry.shutdown();
  });

  it('exports spans over OTLP/HTTP and joins an incoming trace', async () => {
    const received: Array<{ url: string | undefined; body: string }> = [];
    const server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(otlpTracesUrl(`http://127.0.0.1:${port}/`)).toBe(`http://127.0.0.1:${port}/v1/traces`);
      const telemetry = await startTelemetry(
        {
          telemetry: { otlpEndpoint: `http://127.0.0.1:${port}`, serviceName: 'vamos-test-svc' },
        },
        'vamos-default',
      );
      expect(telemetry.enabled).toBe(true);
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const span = telemetry.startSpan('GET /events', {
        kind: 'server',
        attributes: { 'http.request.method': 'GET', skipped: undefined },
        traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
      });
      expect(span.traceId).toBe(traceId);
      span.setAttributes({ 'http.response.status_code': 500 });
      span.recordError(new Error('boom'));
      span.end();
      span.end();
      await telemetry.shutdown();
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]?.url).toBe('/v1/traces');
      const body = received.map((r) => r.body).join('\n');
      expect(body).toContain('GET /events');
      expect(body).toContain('vamos-test-svc');
      expect(body).toContain('boom');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
