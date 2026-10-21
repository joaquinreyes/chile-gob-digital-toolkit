import { signHs256 } from "./jwt.js";
import { formatChileDateTime, MAX_EXPIRATION_MINUTES } from "./time.js";
import { sha256Hex, type FirmaGobFile } from "./files.js";

/** URLs from the FirmaGob manual ("Manual de integración | Protocolo de conexión a repositorio de firmas"). */
export const FIRMAGOB_URLS = {
  production: "https://api.firma.digital.gob.cl/firma/v2/files/tickets",
  /** TEST environment. Signatures made here are not valid. */
  test: "https://api.firma.cert.digital.gob.cl/firma/v2/files/tickets",
} as const;

/**
 * Generic test data published in the manual for the TEST environment.
 * These are public sandbox values, not secrets.
 */
export const FIRMAGOB_TEST_DATA = {
  apiTokenKey: "sandbox",
  secret: "27a216342c744f89b7b82fa290519ba0",
  entity: "Subsecretaría General de la Presidencia",
  /** Attended signature (needs OTP). */
  attended: { run: "11111111", purpose: "Propósito General" },
  /** Unattended signature (no OTP). */
  unattended: { run: "22222222", purpose: "Desatendido" },
} as const;

export const PURPOSE_UNATTENDED = "Desatendido";
export const PURPOSE_GENERAL = "Propósito General";

/** Max request size documented by FirmaGob. */
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FirmaGobConfig {
  /** Unique code from the application registration (api_token_key). */
  apiTokenKey: string;
  /** Symmetric secret from the application registration. Used for HS256. */
  secret: string;
  /** Institution name exactly as it appears in the RA. */
  entity: string;
  /** Endpoint URL. Default: production. Use FIRMAGOB_URLS.test for the test environment. */
  url?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
}

export interface SignRequest {
  /** Signer RUN. Accepts "22.222.222-2", "22222222-2" or "22222222". Sent without DV. */
  run: string;
  /** Purpose name as in the RA, e.g. "Desatendido" or "Propósito General". */
  purpose: string;
  files: FirmaGobFile[];
  /** OTP for attended signature. Must be omitted for "Desatendido". */
  otp?: string;
  /** Token lifetime in minutes (1-30). Default 5. */
  expiresInMinutes?: number;
}

export interface SignedFile {
  status: string;
  ok: boolean;
  /** base64 of the signed file (or p7s for hash signing). */
  content?: string;
  contentType?: string;
  description?: string | null;
  documentStatus?: string;
  checksumOriginal?: string;
  checksumSigned?: string;
  /** True when the returned content's SHA256 equals checksumSigned (when both are present). */
  checksumVerified?: boolean;
}

export interface SignResult {
  files: SignedFile[];
  metadata: { otpExpired?: boolean; filesSigned?: number; signedFailed?: number; filesReceived?: number };
  requestId?: string;
  sessionToken?: string;
  raw: unknown;
}

export class FirmaGobError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "FirmaGobError";
  }
}

/** FirmaGob wants the RUN without dots, dash or check digit. Validates the DV when given. */
export function toFirmaGobRun(input: string): string {
  const clean = input.replace(/[.\s]/g, "").toUpperCase();
  const m = /^(\d{1,8})(?:-([0-9K]))?$/.exec(clean);
  if (!m) throw new FirmaGobError(`RUN inválido: "${input}"`);
  const numero = m[1]!;
  if (m[2] !== undefined && m[2] !== dv(Number(numero))) {
    throw new FirmaGobError(`Dígito verificador incorrecto: "${input}"`);
  }
  return numero;
}

function dv(n: number): string {
  let sum = 0;
  let f = 2;
  for (let r = n; r > 0; r = Math.floor(r / 10)) {
    sum += (r % 10) * f;
    f = f === 7 ? 2 : f + 1;
  }
  const v = 11 - (sum % 11);
  return v === 11 ? "0" : v === 10 ? "K" : String(v);
}

export class FirmaGobClient {
  private readonly url: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly config: FirmaGobConfig) {
    for (const key of ["apiTokenKey", "secret", "entity"] as const) {
      if (!config[key]) throw new FirmaGobError(`Falta configuración: ${key}`);
    }
    this.url = config.url ?? FIRMAGOB_URLS.production;
    this.fetchFn = config.fetch ?? ((input, init) => fetch(input, init));
    this.now = config.now ?? (() => new Date());
  }

  /** Builds the HS256 JWT with entity, run, expiration (Chile time) and purpose. */
  buildToken(params: { run: string; purpose: string; expiresInMinutes?: number }): string {
    const minutes = params.expiresInMinutes ?? 5;
    if (!(minutes > 0 && minutes <= MAX_EXPIRATION_MINUTES)) {
      throw new FirmaGobError(`expiresInMinutes debe estar entre 1 y ${MAX_EXPIRATION_MINUTES}`);
    }
    if (!params.purpose) throw new FirmaGobError("purpose es obligatorio");
    const expiration = formatChileDateTime(new Date(this.now().getTime() + minutes * 60_000));
    return signHs256(
      { entity: this.config.entity, run: toFirmaGobRun(params.run), expiration, purpose: params.purpose },
      this.config.secret,
    );
  }

  /** Builds the JSON body and headers without sending them. Useful for logging and tests. */
  buildRequest(req: SignRequest): { url: string; headers: Record<string, string>; body: string } {
    if (!req.files.length) throw new FirmaGobError("Debe adjuntar al menos un documento");
    const unattended = req.purpose === PURPOSE_UNATTENDED;
    if (unattended && req.otp) {
      throw new FirmaGobError("La firma desatendida no debe enviar OTP");
    }
    if (!unattended && !req.otp) {
      throw new FirmaGobError("La firma atendida requiere OTP");
    }
    if (req.otp && !/^\d{6,8}$/.test(req.otp)) throw new FirmaGobError("OTP debe ser numérico (6-8 dígitos)");

    const body = JSON.stringify({
      api_token_key: this.config.apiTokenKey,
      token: this.buildToken(req),
      files: req.files,
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new FirmaGobError("La solicitud excede el máximo de 5 MB");
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (req.otp) headers.OTP = req.otp;
    return { url: this.url, headers, body };
  }

  /** Sends the signing request and parses the response. */
  async sign(req: SignRequest): Promise<SignResult> {
    const { url, headers, body } = this.buildRequest(req);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new FirmaGobError(`Error de red llamando a FirmaGob: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    if (!res.ok) {
      const msg = isRecord(json) && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      throw new FirmaGobError(`FirmaGob respondió ${res.status}: ${msg}`, res.status, json);
    }
    return parseSignResponse(json, text);
  }
}

/**
 * Parses the success body. The manual shows two shapes (snake_case schema and
 * camelCase example), so both are accepted.
 */
export function parseSignResponse(json: unknown, rawText?: string): SignResult {
  if (!isRecord(json) || !Array.isArray(json.files)) {
    throw new FirmaGobError("Respuesta de FirmaGob sin 'files'", undefined, json);
  }
  const files: SignedFile[] = json.files.map((f: unknown) => {
    const o = isRecord(f) ? f : {};
    const content = str(o.content);
    const checksumSigned = str(o.checksum_signed) ?? str(o.checksum);
    const status = str(o.status) ?? "unknown";
    return {
      status,
      ok: status.toUpperCase() === "OK",
      content,
      contentType: str(o.contentType) ?? str(o["content-type"]) ?? str(o.type),
      description: o.description === null ? null : str(o.description),
      documentStatus: str(o.documentStatus),
      checksumOriginal: str(o.checksum_original),
      checksumSigned,
      checksumVerified:
        content && checksumSigned ? sha256Hex(Buffer.from(content, "base64")) === checksumSigned.toLowerCase() : undefined,
    };
  });
  const m = isRecord(json.metadata) ? json.metadata : {};
  return {
    files,
    metadata: {
      otpExpired: bool(m.otpExpired) ?? bool(m.OTP_expired),
      filesSigned: num(m.filesSigned) ?? num(m.files_signed),
      signedFailed: num(m.signedFailed) ?? num(m.signed_failed),
      filesReceived: num(m.objectsReceived) ?? num(m.files_received) ?? num(m.files_recived),
    },
    // idSolicitud can exceed 2^53, so read the digits from the raw text when available.
    requestId: (rawText && /"idSolicitud"\s*:\s*"?(\d+)/.exec(rawText)?.[1]) ||
      (json.idSolicitud !== undefined ? String(json.idSolicitud) : undefined),
    sessionToken: str(json.session_token),
    raw: json,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
