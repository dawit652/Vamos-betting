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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clientAddressKey } from '../../lib/client-address';
import { parseInput } from '../../lib/errors';
import { warmUpPasswordHashing } from '../../lib/passwords';
import { randomToken } from '../../lib/crypto';
import {
  enforceLimit,
  loginPhoneLimitKey,
  restartLoginPhoneLimit,
} from '../../lib/rate-limits';
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
  type OtpDispatch,
  type RequestMeta,
} from './service';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The normalised phone of the request body, or null when it has none or it is invalid. */
function bodyPhone(request: FastifyRequest): string | null {
  const body = request.body as { phone?: unknown } | null | undefined;
  return typeof body?.phone === 'string' ? normalizeEthiopianMsisdn(body.phone) : null;
}

/**
 * Brute-force protection keyed by client address plus the normalised phone
 * in the body, so one number cannot be hammered from one address. Runs as a
 * preHandler because the body is not parsed yet at onRequest. `request.ip`
 * comes from X-Forwarded-For only for trusted proxies (BuildAppOptions.trustProxy).
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
        return `${clientAddressKey(request.ip)}|${phone}`;
      },
    },
  };
}

function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: userAgent ?? null, log: request.log };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { deps, authLimits } = app;
  await warmUpPasswordHashing();

  // Shared by every unauthenticated auth endpoint: one budget per client address.
  const perClient = app.createRateLimit({
    ...authLimits.perClient,
    keyGenerator: (request) => `auth-client|${clientAddressKey(request.ip)}`,
  });
  // Login attempts per phone number from any address.
  const loginPerPhone = app.createRateLimit({
    ...authLimits.loginPerPhone,
    keyGenerator: (request) => loginPhoneLimitKey(deps.redis, bodyPhone(request) ?? 'invalid'),
  });

  const clientLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
  };
  const loginLimits = async (request: FastifyRequest, reply: FastifyReply) => {
    await enforceLimit(perClient, request, reply);
    // A malformed number cannot match an account; it shares no budget with real ones.
    if (bodyPhone(request) !== null) await enforceLimit(loginPerPhone, request, reply);
  };

  /** Answers with the body and sends the SMS, if any, after the response. */
  const dispatch = ({ response, deliver }: OtpDispatch): OtpSentResponse => {
    if (deliver !== null) app.background.run('otp_sms', deliver);
    return response;
  };

  app.post(
    '/auth/register',
    { preHandler: clientLimit, config: phoneRateLimit(10, HOUR_MS) },
    async (request, reply) => {
      const input = parseInput(RegisterRequest, request.body);
      const { response } = await registerUser(deps, input, requestMeta(request));
      const body: RegisterResponse = response;
      return reply.status(201).send(body);
    },
  );

  app.post(
    '/auth/verify-otp',
    { preHandler: clientLimit, config: phoneRateLimit(10, 10 * MINUTE_MS) },
    async (request, reply): Promise<SessionResponse> => {
      const input = parseInput(VerifyOtpRequest, request.body);
      const { user, session } = await verifyRegistration(deps, input, requestMeta(request));
      setSessionCookies(reply, deps.config, session);
      return sessionResponseBody(user, session);
    },
  );

  app.post(
    '/auth/otp/resend',
    { preHandler: clientLimit, config: phoneRateLimit(5, 10 * MINUTE_MS) },
    async (request): Promise<OtpSentResponse> => {
      const input = parseInput(ResendOtpRequest, request.body);
      return dispatch(await resendOtp(deps, input, requestMeta(request)));
    },
  );

  app.post(
    '/auth/login',
    { preHandler: loginLimits, config: phoneRateLimit(10, 15 * MINUTE_MS) },
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
    { preHandler: clientLimit, config: phoneRateLimit(5, HOUR_MS) },
    async (request): Promise<OtpSentResponse> => {
      const input = parseInput(ForgotPasswordRequest, request.body);
      return dispatch(await requestPasswordReset(deps, input, requestMeta(request)));
    },
  );

  app.post(
    '/auth/password/reset',
    { preHandler: clientLimit, config: phoneRateLimit(10, HOUR_MS) },
    async (request, reply): Promise<OkResponse> => {
      const input = parseInput(ResetPasswordRequest, request.body);
      await resetPassword(deps, input, requestMeta(request));
      // Whoever holds the SMS code is the owner: lift the per-number login lock a
      // stranger may hold with wrong passwords, so the new password works at once.
      const phone = bodyPhone(request);
      if (phone !== null) {
        await restartLoginPhoneLimit(
          deps.redis,
          phone,
          authLimits.loginPerPhone,
          randomToken(deps.randomBytes, 9),
        );
      }
      // Every session of the account was revoked, including any on this device.
      clearSessionCookies(reply, deps.config);
      return { ok: true };
    },
  );
}
