/**
 * DB token issuance/verification for the data service.
 *
 * The gateway signs POS session JWTs (GATEWAY_JWT_SECRET). For the database
 * connection the browser passes a DB access token obtained from
 * POST /auth/login (field `surrealToken`) — under SurrealDB this was a
 * SurrealDB-issued access token; the PostgreSQL data service replaces it with
 * an HS256 JWT carrying the user's identity so `$auth` works in DEFINE EVENT
 * handlers. `DB_TOKEN_SECRET` defaults to `GATEWAY_JWT_SECRET` so the gateway
 * and the data service share the secret in local deployments.
 */

import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(data).digest();
}

export function signDbToken(payload, secret, ttlSeconds = 12 * 60 * 60) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
    iss: 'restaurant-manager-dbproxy',
  };
  const claims = b64url(JSON.stringify(body));
  const sig = b64url(hmac(secret, `${header}.${claims}`));
  return `${header}.${claims}.${sig}`;
}

export function verifyDbToken(token, secret) {
  if (typeof token !== 'string') throw new Error('Missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, claims, sig] = parts;
  const expected = b64url(hmac(secret, `${header}.${claims}`));
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid token signature');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed token payload');
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

export class DbAuth {
  constructor(options = {}) {
    this.rootUser = options.rootUser ?? process.env.DB_ROOT_USER ?? process.env.SURREAL_USER;
    this.rootPass = options.rootPass ?? process.env.DB_ROOT_PASS ?? process.env.SURREAL_PASS;
    this.secret = options.secret ?? process.env.DB_TOKEN_SECRET ?? process.env.GATEWAY_JWT_SECRET;
    this.tokenTtl = Number(options.tokenTtl ?? process.env.DB_TOKEN_TTL ?? 12 * 60 * 60);
    if (!this.rootUser || !this.rootPass) {
      throw new Error('DB_ROOT_USER/DB_ROOT_PASS (or SURREAL_USER/SURREAL_PASS) are required and have no default');
    }
    if (!this.secret) {
      throw new Error('DB_TOKEN_SECRET (or GATEWAY_JWT_SECRET) is required and has no default');
    }
    if (this.rootUser === 'root' && this.rootPass === 'root') {
      this.logger?.warn?.('DB root credentials are root/root — allowed for an existing datastore; change them for new installs');
    }
  }

  /** signin RPC: root credentials → access token. */
  signin({ user, pass } = {}) {
    if (String(user ?? '') !== this.rootUser || String(pass ?? '') !== this.rootPass) {
      const err = new Error('Invalid root user or password');
      err.kind = 'NotAllowed';
      err.code = -32002;
      throw err;
    }
    return signDbToken({ sub: 'root', login: this.rootUser, roles: ['owner'], typ: 'db_root' }, this.secret, this.tokenTtl);
  }

  /** authenticate RPC: verify a DB access token and return its payload. */
  authenticate(token) {
    const payload = verifyDbToken(token, this.secret);
    return payload;
  }
}
