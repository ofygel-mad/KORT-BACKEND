import type { FastifyInstance } from 'fastify';
import {
  loginSchema,
  registerCompanySchema,
  setPasswordSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.schemas.js';
import * as authService from './auth.service.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { verifyFirstLoginToken } from '../../lib/jwt.js';

export async function authRoutes(app: FastifyInstance) {

  // ── POST /api/v1/auth/login ──────────────────────────────────────────────
  // Accepts { email, password } OR { phone, password }
  // Returns AuthSessionResponse OR FirstLoginResponse (for pending_first_login employees)
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await authService.login({
      email: body.email,
      phone: body.phone,
      password: body.password,
    });
    return reply.send(result);
  });

  // ── POST /api/v1/auth/set-password ───────────────────────────────────────
  // Used by employees on their first login to set a real password.
  // The temp_token from FirstLoginResponse is passed as Authorization: Bearer <token>.
  // No standard authenticate preHandler — we verify the first-login token manually.
  app.post('/set-password', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Требуется токен установки пароля.');
    }
    const tempToken = authHeader.slice(7);

    // Verify it's actually a first-login token (not a regular access token)
    try {
      verifyFirstLoginToken(tempToken);
    } catch {
      throw new UnauthorizedError(
        'Недействительный или просроченный токен установки пароля. Войдите заново.',
      );
    }

    const body = setPasswordSchema.parse(request.body);
    const result = await authService.setPassword(tempToken, body.new_password);
    return reply.send(result);
  });

  // ── POST /api/v1/auth/register/company ───────────────────────────────────
  app.post('/register/company', async (request, reply) => {
    const body = registerCompanySchema.parse(request.body);
    const result = await authService.registerCompany(body);
    return reply.status(201).send(result);
  });

  // ── POST /api/v1/auth/register/employee — DEPRECATED ────────────────────
  // Employees are now added exclusively via POST /api/v1/company/employees/
  // by an administrator. Self-registration is no longer supported.
  app.post('/register/employee', async (_request, reply) => {
    return reply.status(410).send({
      code: 'GONE',
      error: 'GONE',
      message:
        'Самостоятельная регистрация сотрудников отключена. ' +
        'Обратитесь к администратору компании — он добавит вас через раздел настроек.',
    });
  });

  // ── POST /api/v1/auth/forgot-password ───────────────────────────────────
  app.post('/forgot-password', async (request, reply) => {
    const { email } = forgotPasswordSchema.parse(request.body);
    await authService.requestPasswordReset(email);
    return reply.send({ ok: true });
  });

  // ── POST /api/v1/auth/reset-password ─────────────────────────────────────
  app.post('/reset-password', async (request, reply) => {
    const { token, new_password } = resetPasswordSchema.parse(request.body);
    const result = await authService.confirmPasswordReset(token, new_password);
    return reply.send(result);
  });

  // ── POST /api/v1/auth/token/refresh ─────────────────────────────────────
  app.post('/token/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await authService.refreshTokens(body.refresh);
    return reply.send(result);
  });

  // ── GET /api/v1/auth/bootstrap ───────────────────────────────────────────
  app.get('/bootstrap', { preHandler: [app.optionalAuth] }, async (request, reply) => {
    if (!request.userId) return reply.send(null);
    const xOrgId =
      typeof request.headers['x-org-id'] === 'string'
        ? request.headers['x-org-id']
        : undefined;
    return reply.send(await authService.bootstrap(request.userId, xOrgId));
  });

  // ── GET /api/v1/auth/me ──────────────────────────────────────────────────
  app.get('/me', { preHandler: [app.optionalAuth] }, async (request, reply) => {
    if (!request.userId) return reply.send(null);
    const xOrgId =
      typeof request.headers['x-org-id'] === 'string'
        ? request.headers['x-org-id']
        : undefined;
    return reply.send(await authService.bootstrap(request.userId, xOrgId));
  });
}
