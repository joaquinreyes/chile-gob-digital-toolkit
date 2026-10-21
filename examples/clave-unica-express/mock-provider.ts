import { randomBytes } from "node:crypto";
import express from "express";
import { fileURLToPath } from "node:url";

/**
 * Local stand-in for accounts.claveunica.gob.cl with the same paths and response shapes
 * as the official guide. It always logs in the sandbox test RUN 44.444.444-4.
 * For local development and tests only. It is NOT ClaveÚnica.
 */
export interface MockOptions {
  clientId: string;
  clientSecret: string;
}

export function createMockProvider(opts: MockOptions): express.Express {
  const codes = new Map<string, { redirectUri: string; nonce?: string; exp: number }>();
  const tokens = new Set<string>();
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/openid/authorize/", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.client_id !== opts.clientId || q.response_type !== "code" || !q.redirect_uri || !q.state) {
      res.status(400).send("invalid_request");
      return;
    }
    if (!q.scope?.split(" ").includes("openid")) {
      res.status(400).send("invalid_scope");
      return;
    }
    const code = randomBytes(16).toString("hex"); // 32 chars, like the real code
    codes.set(code, { redirectUri: q.redirect_uri, nonce: q.nonce, exp: Date.now() + 5 * 60_000 });
    const target = new URL(q.redirect_uri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", q.state);
    res.redirect(target.toString());
  });

  app.post("/openid/token/", (req, res) => {
    const b = req.body as Record<string, string | undefined>;
    if (b.client_id !== opts.clientId || b.client_secret !== opts.clientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    const entry = b.code ? codes.get(b.code) : undefined;
    if (!entry || b.grant_type !== "authorization_code" || entry.redirectUri !== b.redirect_uri || entry.exp < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    codes.delete(b.code!);
    const accessToken = randomBytes(16).toString("hex");
    tokens.add(accessToken);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const idToken = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "1234567", aud: opts.clientId, nonce: entry.nonce })}.mock`;
    res.json({ access_token: accessToken, token_type: "bearer", expires_in: 3600, id_token: idToken });
  });

  app.post("/openid/userinfo/", (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token || !tokens.has(token)) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    res.json({
      sub: "1234567",
      RolUnico: { DV: "4", numero: 44444444, tipo: "RUN" },
      name: { nombres: ["Usuario"], apellidos: ["De", "Prueba"] },
    });
  });

  app.get("/api/v1/accounts/app/logout", (req, res) => {
    const redirect = typeof req.query.redirect === "string" ? req.query.redirect : undefined;
    if (redirect) res.redirect(redirect);
    else res.send("logout ok");
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 4000);
  createMockProvider({
    clientId: process.env.CLAVEUNICA_CLIENT_ID ?? "mock-client",
    clientSecret: process.env.CLAVEUNICA_CLIENT_SECRET ?? "mock-secret",
  }).listen(port, () => console.log(`Mock ClaveÚnica en http://localhost:${port}`));
}
