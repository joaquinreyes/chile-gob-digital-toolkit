import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT (RFC 7519) using node:crypto. No external dependency. */
export function signHs256(payload: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error("secret vacío");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** Verifies an HS256 JWT and returns its payload. Throws on a bad signature or format. */
export function verifyHs256(token: string, secret: string): Record<string, unknown> {
  const [header, body, sig] = token.split(".");
  if (!header || !body || !sig) throw new Error("JWT mal formado");
  const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
  if (h.alg !== "HS256") throw new Error(`alg no soportado: ${h.alg}`);
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("firma JWT inválida");
  }
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
