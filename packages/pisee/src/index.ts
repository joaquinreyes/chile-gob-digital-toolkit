/**
 * PISEE 2 helpers, based on the public "Manual de configuración del Nodo v2" and
 * "Modelo de interoperabilidad" (wikiguias.digital.gob.cl).
 *
 * In PISEE 2 each institution runs the SGD "Nodo". The Nodo does mutual TLS, message
 * signing, encryption, authorization and traceability. Applications only call their
 * local Nodo over HTTP (default port 8084). This package covers that local side:
 *   - NodoClient: call services through the local Nodo.
 *   - config.json entry builders/validators for "consumidor" and "proveedor".
 *   - Transaction id parsing (institution code + ULID).
 * It does not implement the Nodo itself or the MPGA-2 protocol between Nodos.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const NODO_DEFAULT_URL = "http://localhost:8084";

export class PiseeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PiseeError";
  }
}

export interface NodoClientOptions {
  /** Internal URL of the local Nodo. Never expose port 8084 to the internet. */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface NodoCallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  /** Objects are sent as JSON; strings and Buffers are sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface NodoResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export class NodoClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: NodoClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? NODO_DEFAULT_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Calls a service by the "rutaLocal" configured in the Nodo's config.json. */
  async call<T = unknown>(rutaLocal: string, opts: NodoCallOptions = {}): Promise<NodoResponse<T>> {
    assertRutaLocal(rutaLocal);
    const url = new URL(this.baseUrl + rutaLocal);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    let body: RequestInit["body"] | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === "string" || Buffer.isBuffer(opts.body)) {
        body = opts.body as RequestInit["body"];
      } else {
        body = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }
    }
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: opts.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PiseeError(`No se pudo contactar al Nodo en ${this.baseUrl}: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json") || /^\s*[[{]/.test(text)) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep text
      }
    }
    if (!res.ok) throw new PiseeError(`Nodo respondió HTTP ${res.status} en ${rutaLocal}`, res.status, data);
    return { status: res.status, headers: res.headers, data: data as T };
  }

  /**
   * Connectivity test documented in the Nodo manual:
   * GET /detalleOrganismo/<codigo> (e.g. PE-SUB-00053) goes through the SGD test Nodo.
   */
  async detalleOrganismo(codigo: string): Promise<Organismo> {
    if (!/^[A-Z]{2}-[A-Z]{3}-\d{5}$/.test(codigo)) throw new PiseeError(`Código de organismo inválido: ${codigo}`);
    const res = await this.call<Organismo>(`/detalleOrganismo/${codigo}`);
    return res.data;
  }
}

export interface Organismo {
  id: number;
  codigo: string;
  descripcion: string;
  identificador: string;
  vigente: boolean;
  [key: string]: unknown;
}

/* ---------- config.json entries ---------- */

export interface ConsumidorEntry {
  /** Service name exactly as in the PISEE 2 catalog. */
  nombre: string;
  /** Local path your apps call on the Nodo, e.g. /algo/miServicio. */
  rutaLocal: string;
  /** Only for services that still live on PISEE 1. */
  servicioPisee?: string;
  tramitePisee?: string;
  conversion?: { entrada?: string; respuesta?: string };
}

export interface ProveedorEntry {
  /** PascalCase service id in the catalog. */
  nombre: string;
  origen: { tipo: "WEB_SERVICE"; rutaLocal: string };
  /** Public path: https://<ruta_nodo>/<proveedor>/<rutaExterna>. */
  rutaExterna: string;
  /** Max transactions per second. */
  tps: number;
}

export function consumidorEntry(e: ConsumidorEntry): ConsumidorEntry {
  if (!e.nombre.trim()) throw new PiseeError("nombre es obligatorio");
  assertRutaLocal(e.rutaLocal);
  if ((e.servicioPisee === undefined) !== (e.tramitePisee === undefined)) {
    throw new PiseeError("servicioPisee y tramitePisee van juntos (servicios PISEE 1)");
  }
  return { ...e };
}

export function proveedorEntry(e: Omit<ProveedorEntry, "origen"> & { rutaLocalServicio: string }): ProveedorEntry {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(e.nombre)) throw new PiseeError(`nombre debe ser PascalCase: "${e.nombre}"`);
  if (!/^\/[A-Za-z0-9/_-]+$/.test(e.rutaExterna)) throw new PiseeError(`rutaExterna inválida: "${e.rutaExterna}"`);
  if (!Number.isInteger(e.tps) || e.tps < 1) throw new PiseeError("tps debe ser un entero >= 1");
  let origen: URL;
  try {
    origen = new URL(e.rutaLocalServicio);
  } catch {
    throw new PiseeError(`rutaLocal del origen debe ser una URL: "${e.rutaLocalServicio}"`);
  }
  if (origen.protocol !== "http:" && origen.protocol !== "https:") throw new PiseeError("origen debe ser http(s)");
  return { nombre: e.nombre, origen: { tipo: "WEB_SERVICE", rutaLocal: e.rutaLocalServicio }, rutaExterna: e.rutaExterna, tps: e.tps };
}

function assertRutaLocal(r: string): void {
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(r) || r.includes("..")) throw new PiseeError(`rutaLocal inválida: "${r}"`);
}

/* ---------- transaction ids ---------- */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface TransactionId {
  /** Consumer institution code (prefix before the dot). */
  organismo: string;
  ulid: string;
  /** Time encoded in the first 48 bits of the ULID. */
  timestamp: Date;
}

/** Parses ids like "6.01GK313E4VSGGB69DKNPTFAM6K" (institution code + "." + ULID). */
export function parseTransactionId(id: string): TransactionId {
  const dot = id.lastIndexOf(".");
  const organismo = id.slice(0, dot);
  const ulid = id.slice(dot + 1).toUpperCase();
  if (dot < 1 || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(ulid)) {
    throw new PiseeError(`ID de transacción inválido: "${id}"`);
  }
  let ms = 0;
  for (const c of ulid.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return { organismo, ulid, timestamp: new Date(ms) };
}
