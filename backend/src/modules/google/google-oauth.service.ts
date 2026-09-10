/**
 * Google OAuth 2.0 mechanics — authorisation URL, signed `state`, code
 * exchange, refresh, revoke.
 *
 * The SPA authenticates with a bearer token in localStorage, so the OAuth
 * callback (which Google hits directly, with no Cailyx cookie) can't read the
 * session. The initiating request instead mints a signed `state` that carries
 * the userId, the target projectId and the service; the public callback
 * verifies the signature and trusts what's inside. State is single-use-ish via
 * a short expiry and a random nonce.
 *
 * No `googleapis` dependency — these are four plain HTTPS calls.
 *
 * @module google/google-oauth.service
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GOOGLE_SCOPES, type GoogleService, type GoogleTokenSet } from './google.types';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL_MS = 10 * 60_000;

interface StatePayload {
  u: string; // userId
  p: string | null; // projectId
  s: GoogleService;
  n: string; // nonce
  e: number; // expiry (epoch ms)
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(private readonly config: ConfigService) {}

  get clientId(): string {
    return (this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') ?? '').trim();
  }
  get clientSecret(): string {
    return (this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') ?? '').trim();
  }
  get redirectUri(): string {
    const port = this.config.get<string>('PORT') ?? '3002';
    return (
      this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI') ??
      `http://localhost:${port}/api/integrations/google/callback`
    );
  }
  get successRedirect(): string {
    return (
      this.config.get<string>('GOOGLE_OAUTH_SUCCESS_REDIRECT') ??
      `${this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000'}/v2`
    );
  }

  /** True once the operator has dropped in the client id + secret. */
  isConfigured(): boolean {
    return this.clientId.length > 0 && this.clientSecret.length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the backend env.',
      );
    }
  }

  /* ── signed state ────────────────────────────────────────────────────── */

  private stateSecret(): string {
    return this.config.getOrThrow<string>('JWT_SECRET');
  }

  signState(userId: string, projectId: string | null, service: GoogleService): string {
    const payload: StatePayload = {
      u: userId,
      p: projectId,
      s: service,
      n: randomBytes(9).toString('base64url'),
      e: Date.now() + STATE_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', this.stateSecret()).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verifyState(raw: string): { userId: string; projectId: string | null; service: GoogleService } {
    const [body, sig] = (raw || '').split('.');
    if (!body || !sig) throw new BadRequestException('Malformed OAuth state');

    const expected = createHmac('sha256', this.stateSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('OAuth state signature mismatch');
    }

    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Unreadable OAuth state');
    }
    if (!payload.e || payload.e < Date.now()) throw new BadRequestException('OAuth state expired — start the connect again');
    if (payload.s !== 'search-console' && payload.s !== 'analytics') throw new BadRequestException('Unknown service in state');

    return { userId: payload.u, projectId: payload.p, service: payload.s };
  }

  /* ── flow ────────────────────────────────────────────────────────────── */

  authUrl(state: string, service: GoogleService): string {
    this.assertConfigured();
    const scope = ['openid', 'email', ...GOOGLE_SCOPES[service]].join(' ');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      access_type: 'offline', // we want a refresh token
      include_granted_scopes: 'true',
      prompt: 'consent', // force the refresh token even on re-auth
      scope,
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleTokenSet> {
    this.assertConfigured();
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parseTokenResponse(res);
  }

  async refresh(refreshToken: string): Promise<GoogleTokenSet> {
    this.assertConfigured();
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return this.parseTokenResponse(res);
  }

  async revoke(token: string): Promise<void> {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn(`Token revoke failed (continuing): ${(err as Error).message}`);
    }
  }

  private async parseTokenResponse(res: Response): Promise<GoogleTokenSet> {
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* keep {} */
    }
    if (!res.ok) {
      const detail = String(json.error_description || json.error || text.slice(0, 200));
      throw new BadRequestException(`Google token endpoint ${res.status}: ${detail}`);
    }

    const accessToken = String(json.access_token || '');
    if (!accessToken) throw new BadRequestException('Google token response had no access_token');

    let email: string | undefined;
    const idToken = json.id_token;
    if (typeof idToken === 'string' && idToken.split('.').length === 3) {
      try {
        const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
        if (typeof claims.email === 'string') email = claims.email;
      } catch {
        /* ignore — email is a nicety */
      }
    }

    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expiresInSec: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      scope: typeof json.scope === 'string' ? json.scope : '',
      email,
    };
  }
}
