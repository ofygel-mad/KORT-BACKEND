import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';

// ─── Payload types ────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string;    // userId
  email: string;  // may be empty string for phone-only employees
  type?: never;   // standard access tokens do NOT have a type field
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;    // refresh token id (for revocation)
}

/**
 * Short-lived token issued when an employee does phone+phone login.
 * Used exclusively on POST /auth/set-password/.
 * The `type: 'first_login'` discriminator prevents it from being used
 * as a regular access token.
 */
export interface FirstLoginTokenPayload {
  sub: string;   // userId
  type: 'first_login';
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL as SignOptions['expiresIn'],
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL as SignOptions['expiresIn'],
  });
}

/**
 * Signs a first-login temp token with a short TTL (30 min).
 * Signed with JWT_ACCESS_SECRET so it can be verified with verifyAccessToken,
 * but the `type` field distinguishes it.
 */
export function signFirstLoginToken(userId: string): string {
  const payload: FirstLoginTokenPayload = { sub: userId, type: 'first_login' };
  return jwt.sign(payload, config.JWT_ACCESS_SECRET, { expiresIn: '30m' });
}

// ─── Verification ─────────────────────────────────────────────────────────────

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessTokenPayload & { type?: string };

  // Block first_login tokens from being used as regular access tokens
  if (payload.type === 'first_login') {
    throw new Error('First-login token cannot be used as an access token');
  }

  return payload as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

export function verifyFirstLoginToken(token: string): FirstLoginTokenPayload {
  const payload = jwt.verify(token, config.JWT_ACCESS_SECRET) as FirstLoginTokenPayload;

  if (payload.type !== 'first_login') {
    throw new Error('Not a first-login token');
  }

  return payload;
}
