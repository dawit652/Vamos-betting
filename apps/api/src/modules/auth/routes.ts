import { normalizeEthiopianMsisdn } from '@vamos/core';
import {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResendOtpRequest,
  ResetPasswordRequest,
  VerifyOtpRequest,
  type OkResponse,
  type OtpSentResponse,
  type RegisterResponse,
  type SessionResponse,
} from '@vamos/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseInput } from '../../lib/errors';
import { warmUpPasswordHashing } from '../../lib/passwords';
import {
  clearSessionCookies,
  requireUser,
  sessionResponseBody,
  setSessionCookies,
} from '../../plugins/session';
import {
  login,
  logout,
  registerUser,
  requestPasswordReset,
  resendOtp,
  resetPassword,
  verifyRegistration,
  type RequestMeta,
} from './service';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Brute-force protection keyed by client IP plus the normalised phone in the
 * body, so one number cannot be hammered from one address. Runs as a
 * preHandler because the body is not parsed yet at onRequest.
 */
function phoneRateLimit(max: number, timeWindow: number) {
  return {
    rateLimit: {
      max,
      timeWindow,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => {
        const body = request.body as { phone?: unknown } | null | undefined;
        const raw = typeof body?.phone === 'string' ? body.phone : '';
        const phone = normalizeEthiopianMsisdn(raw) ?? (raw === '' ? 'none' : 'invalid');
        return `${request.ip}|${phone}`;
      },
    },
  };
}

function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: userAgent ?? null, log: request.log };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  await warmUpPasswordHashing();

  app.post('/auth/register', { config: phoneRateLimit(10, HOUR_MS) }, async (request, reply) => {
    const input = parseInput(RegisterRequest, request.body);
    const { userId, response } = await registerUser(deps, input, requestMeta(request));
    const body: RegisterResponse = { userId, ...response };
    return reply.status(201).send(body);
  });

  app.post(
    '/auth/verify-otp',
    { config: phoneRateLimit(10, 10 * MINUTE_MS) },
    async (request, reply): Promise<SessionResponse> => {
      const input = parseInput(VerifyOtpRequest, request.body);
      const { user, session } = await verifyRegistration(deps, input, requestMeta(request));
      setSessionCookies(reply, deps.config, session);
      return sessionResponseBody(user, session);
    },
  );

  app.post(
    '/auth/otp/resend',
    { config: phoneRateLimit(5, 10 * MINUTE_MS) },
    async (request): Promise<OtpSentResponse> => {
      const input = parseInput(ResendOtpRequest, request.body);
      return resendOtp(deps, input, requestMeta(request));
    },
  );

  app.post(
    '/auth/login',
    { config: phoneRateLimit(10, 15 * MINUTE_MS) },
    async (request, reply): Promise<SessionResponse> => {
      const input = parseInput(LoginRequest, request.body);
      const { user, session } = await login(deps, input, requestMeta(request));
      setSessionCookies(reply, deps.config, session);
      return sessionResponseBody(user, session);
    },
  );

  app.post(
    '/auth/logout',
    { preHandler: app.requireAuth },
    async (request, reply): Promise<OkResponse> => {
      await logout(deps, requireUser(request), requestMeta(request));
      clearSessionCookies(reply, deps.config);
      return { ok: true };
    },
  );

  app.post(
    '/auth/password/forgot',
    { config: phoneRateLimit(5, HOUR_MS) },
    async (request): Promise<OtpSentResponse> => {
      const input = parseInput(ForgotPasswordRequest, request.body);
      return requestPasswordReset(deps, input, requestMeta(request));
    },
  );

  app.post(
    '/auth/password/reset',
    { config: phoneRateLimit(10, HOUR_MS) },
    async (request, reply): Promise<OkResponse> => {
      const input = parseInput(ResetPasswordRequest, request.body);
      await resetPassword(deps, input, requestMeta(request));
      // Every session of the account was revoked, including any on this device.
      clearSessionCookies(reply, deps.config);
      return { ok: true };
    },
  );
}
