import type { AppConfig } from '@vamos/config';
import type { HealthResponse } from '@vamos/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AppError } from './lib/errors';

export const API_VERSION = '0.1.0';

export interface AppDeps {
  config: AppConfig;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(deps: AppDeps, options: BuildAppOptions = {}): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-vamos-mode', config.mode);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toBody());
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: (error as { code?: string }).code ?? 'bad_request',
          message: (error as Error).message,
        },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'vamos-api',
    mode: config.mode,
    version: API_VERSION,
    time: new Date().toISOString(),
  }));

  return app;
}
