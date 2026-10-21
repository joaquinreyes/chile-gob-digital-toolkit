import { randomBytes, timingSafeEqual } from "node:crypto";
import { computeDv, InvalidRunError, type Run } from "./run.js";

/**
 * Endpoints from the official guide "Guía técnica de integración a ClaveÚnica"
 * (Secretaría de Gobierno Digital, wikiguias.digital.gob.cl).
 * The trailing slash is part of the documented URLs.
 */
export const CLAVEUNICA_ENDPOINTS = {
  authorize: "https://accounts.claveunica.gob.cl/openid/authorize/",
  token: "https://accounts.claveunica.gob.cl/openid/token/",
  userinfo: "https://accounts.claveunica.gob.cl/openid/userinfo/",
  logout: "https://accounts.claveunica.gob.cl/api/v1/accounts/app/logout",
} as const;

export interface ClaveUnicaEndpoints {
  authorize: string;
  token: string;
  userinfo: string;
  logout: string;
}

/** Same paths on another host, e.g. a local mock provider. */
export function claveUnicaEndpoints(baseUrl: string): ClaveUnicaEndpoints {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    authorize: `${base}/openid/authorize/`,
    token: `${base}/openid/token/`,
    userinfo: `${base}/openid/userinfo/`,
    logout: `${base}/api/v1/accounts/app/logout`,
  };
}

/** The guide requires exactly this scope for production certification. */
export const CLAVEUNICA_DEFAULT_SCOPE = "openid run name";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClaveUnicaConfig {
  clientId: string;
  clientSecret: string;
  /** Must match a Redirect URI registered with ClaveÚnica (no query string, no localhost). */
  redirectUri: string;
  /** Defaults to "openid run name". */
  scope?: string;
  /** Override endpoints, e.g. to point at a local mock provider in tests. */
  endpoints?: Partial<ClaveUnicaEndpoints>;
  fetch?: FetchLike;
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  id_token?: string;
  [key: string]: unknown;
}

/** Raw userinfo body as documented by ClaveÚnica. */
export interface ClaveUnicaUserInfoRaw {
  sub: string;
  RolUnico: { numero: number; DV: string; tipo: string };
  name: { nombres: string[]; apellidos: string[] };
  email?: string;
  [key: string]: unknown;
}

export interface ClaveUnicaProfile {
  /** The person identifier. The guide says to key records on RolUnico.numero, not sub. */
  run: Run;
  tipo: string;
  nombres: string[];
  apellidos: string[];
  nombreCompleto: string;
  sub: string;
  email?: string;
  raw: ClaveUnicaUserInfoRaw;
}

export class ClaveUnicaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ClaveUnicaError";
  }
}

/** 32 random bytes, base64url. Use one per login attempt and store it in the session. */
export function createRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison of the state stored in the session and the one received. */
export function statesMatch(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decodes the payload of a JWT without verifying the signature.
 * Use only for informational claims; ClaveÚnica identity comes from userinfo.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new ClaveUnicaError("id_token no tiene formato JWT");
  }
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

export class ClaveUnicaClient {
  private readonly endpoints: ClaveUnicaEndpoints;
  private readonly fetchFn: FetchLike;
  private readonly scope: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ClaveUnicaConfig) {
    for (const key of ["clientId", "clientSecret", "redirectUri"] as const) {
      if (!config[key]) throw new ClaveUnicaError(`Falta configuración: ${key}`);
    }
    const redirect = new URL(config.redirectUri);
    if (redirect.search) {
      throw new ClaveUnicaError("redirectUri no puede tener query string (regla de ClaveÚnica)");
    }
    this.endpoints = { ...CLAVEUNICA_ENDPOINTS, ...config.endpoints };
    this.fetchFn = config.fetch ?? ((input, init) => fetch(input, init));
    this.scope = config.scope ?? CLAVEUNICA_DEFAULT_SCOPE;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Step 2 of the guide: URL of the ClaveÚnica login form.
   * `nonce` is optional standard OIDC; the guide only requires `state`.
   */
  authorizationUrl(params: { state: string; nonce?: string }): string {
    if (!params.state) throw new ClaveUnicaError("state es obligatorio");
    const url = new URL(this.endpoints.authorize);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", params.state);
    if (params.nonce) url.searchParams.set("nonce", params.nonce);
    return url.toString();
  }

  /**
   * Steps 3-4: validates the callback and exchanges the code (valid 5 minutes) for tokens.
   * Throws when the provider returned an error or the state does not match.
   */
  async handleCallback(
    query: Record<string, unknown>,
    expected: { state: string; nonce?: string },
  ): Promise<TokenResponse> {
    if (typeof query.error === "string") {
      const desc = typeof query.error_description === "string" ? `: ${query.error_description}` : "";
      throw new ClaveUnicaError(`ClaveÚnica devolvió error "${query.error}"${desc}`);
    }
    const state = typeof query.state === "string" ? query.state : undefined;
    const code = typeof query.code === "string" ? query.code : undefined;
    if (!statesMatch(expected.state, state)) {
      throw new ClaveUnicaError("state no coincide (posible CSRF)");
    }
    if (!code) throw new ClaveUnicaError("Falta el parámetro code");
    const tokens = await this.exchangeCode({ code, state: expected.state });
    if (expected.nonce && tokens.id_token) {
      const claims = decodeJwtPayload(tokens.id_token);
      if (claims.nonce !== undefined && claims.nonce !== expected.nonce) {
        throw new ClaveUnicaError("nonce del id_token no coincide");
      }
    }
    return tokens;
  }

  /** Step 4: POST application/x-www-form-urlencoded to the token endpoint. */
  async exchangeCode(params: { code: string; state: string }): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      code: params.code,
      state: params.state,
    });
    const json = await this.request(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
    });
    if (!isRecord(json) || typeof json.access_token !== "string" || !json.access_token) {
      throw new ClaveUnicaError("Respuesta de token sin access_token", undefined, json);
    }
    return json as TokenResponse;
  }

  /** Step 6: POST with Bearer token to userinfo, returns the raw body. */
  async userInfoRaw(accessToken: string): Promise<ClaveUnicaUserInfoRaw> {
    const json = await this.request(this.endpoints.userinfo, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return json as ClaveUnicaUserInfoRaw;
  }

  /** Step 6 plus validation of RolUnico (number and check digit). */
  async userInfo(accessToken: string): Promise<ClaveUnicaProfile> {
    return parseUserInfo(await this.userInfoRaw(accessToken));
  }

  /**
   * Step 7: ClaveÚnica logout URL. Open it with a full-page redirect (not a popup or iframe).
   * `redirect` must be registered as a Logout URI, otherwise ClaveÚnica does not redirect.
   */
  logoutUrl(redirect?: string): string {
    const url = new URL(this.endpoints.logout);
    if (redirect) url.searchParams.set("redirect", redirect);
    return url.toString();
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ClaveUnicaError(`Error de red llamando a ${url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text body
    }
    if (!res.ok) {
      throw new ClaveUnicaError(`HTTP ${res.status} desde ${url}`, res.status, body);
    }
    if (typeof body === "string") {
      throw new ClaveUnicaError(`Respuesta no JSON desde ${url}`, res.status, body);
    }
    return body;
  }
}

export function parseUserInfo(raw: unknown): ClaveUnicaProfile {
  if (!isRecord(raw) || !isRecord(raw.RolUnico)) {
    throw new ClaveUnicaError("userinfo sin RolUnico", undefined, raw);
  }
  const rol = raw.RolUnico;
  const numero = typeof rol.numero === "string" ? Number(rol.numero) : rol.numero;
  const dv = String(rol.DV ?? "").toUpperCase();
  if (typeof numero !== "number" || !Number.isInteger(numero)) {
    throw new ClaveUnicaError("RolUnico.numero inválido", undefined, raw);
  }
  try {
    if (computeDv(numero) !== dv) {
      throw new ClaveUnicaError("RolUnico.DV no corresponde al número", undefined, raw);
    }
  } catch (err) {
    if (err instanceof InvalidRunError) throw new ClaveUnicaError(err.message, undefined, raw);
    throw err;
  }
  const name = isRecord(raw.name) ? raw.name : {};
  const nombres = toStringArray(name.nombres);
  const apellidos = toStringArray(name.apellidos);
  return {
    run: { numero, dv },
    tipo: typeof rol.tipo === "string" ? rol.tipo : "RUN",
    nombres,
    apellidos,
    nombreCompleto: [...nombres, ...apellidos].join(" "),
    sub: String(raw.sub ?? ""),
    email: typeof raw.email === "string" ? raw.email : undefined,
    raw: raw as ClaveUnicaUserInfoRaw,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
