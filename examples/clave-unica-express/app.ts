import express, { type Request, type Response } from "express";
import {
  ClaveUnicaClient,
  ClaveUnicaError,
  createRandomToken,
  formatRun,
  type ClaveUnicaProfile,
} from "../../packages/clave-unica/src/index.js";

/**
 * Minimal login -> callback -> profile -> logout flow.
 * Sessions live in memory: fine for a demo, use a real session store in production.
 */
interface Session {
  state?: string;
  nonce?: string;
  profile?: ClaveUnicaProfile;
}

export interface AppOptions {
  client: ClaveUnicaClient;
  /** Registered Logout URI to come back to after ClaveÚnica logout. Optional. */
  logoutRedirect?: string;
  /** Set the Secure flag on the session cookie. True behind HTTPS. */
  secureCookie?: boolean;
}

const COOKIE = "cu_demo_sid";

export function createApp(opts: AppOptions): express.Express {
  const sessions = new Map<string, Session>();
  const app = express();
  app.disable("x-powered-by");

  function session(req: Request, res: Response): Session {
    const sid = readCookie(req, COOKIE);
    if (sid && sessions.has(sid)) return sessions.get(sid)!;
    const id = createRandomToken();
    const s: Session = {};
    sessions.set(id, s);
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: opts.secureCookie ?? false, path: "/" });
    return s;
  }

  app.get("/", (req, res) => {
    const s = session(req, res);
    res.type("html").send(
      page(
        s.profile
          ? `<p>Sesión iniciada como <b>${esc(s.profile.nombreCompleto)}</b>.</p><p><a href="/profile">Ver perfil</a> · <a href="/logout">Cerrar sesión</a></p>`
          : `<p><a href="/login">Iniciar sesión con ClaveÚnica</a></p>`,
      ),
    );
  });

  app.get("/login", (req, res) => {
    const s = session(req, res);
    s.state = createRandomToken();
    s.nonce = createRandomToken();
    res.redirect(opts.client.authorizationUrl({ state: s.state, nonce: s.nonce }));
  });

  app.get("/callback", async (req, res) => {
    const s = session(req, res);
    const expected = { state: s.state ?? "", nonce: s.nonce };
    // One-time use: clear before any network call.
    s.state = undefined;
    s.nonce = undefined;
    try {
      const tokens = await opts.client.handleCallback(req.query as Record<string, unknown>, expected);
      s.profile = await opts.client.userInfo(tokens.access_token);
      res.redirect("/profile");
    } catch (err) {
      const msg = err instanceof ClaveUnicaError ? err.message : "Error inesperado";
      res.status(400).type("html").send(page(`<p>No se pudo iniciar sesión: ${esc(msg)}</p><p><a href="/">Volver</a></p>`));
    }
  });

  app.get("/profile", (req, res) => {
    const s = session(req, res);
    if (!s.profile) {
      res.redirect("/");
      return;
    }
    const p = s.profile;
    if (req.accepts(["html", "json"]) === "json") {
      res.json({ run: formatRun(p.run), nombres: p.nombres, apellidos: p.apellidos });
      return;
    }
    res.type("html").send(
      page(
        `<dl><dt>RUN</dt><dd>${esc(formatRun(p.run))}</dd><dt>Nombre</dt><dd>${esc(p.nombreCompleto)}</dd></dl><p><a href="/logout">Cerrar sesión</a></p>`,
      ),
    );
  });

  app.get("/logout", (req, res) => {
    const sid = readCookie(req, COOKIE);
    if (sid) sessions.delete(sid);
    res.clearCookie(COOKIE, { path: "/" });
    // The guide asks the integrator to always close the ClaveÚnica session too.
    res.redirect(opts.client.logoutUrl(opts.logoutRedirect));
  });

  return app;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Demo ClaveÚnica</title></head><body><h1>Demo ClaveÚnica</h1>${body}</body></html>`;
}
