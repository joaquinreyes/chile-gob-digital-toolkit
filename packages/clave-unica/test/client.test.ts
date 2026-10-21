import { describe, expect, it, vi } from "vitest";
import {
  CLAVEUNICA_ENDPOINTS,
  ClaveUnicaClient,
  ClaveUnicaError,
  createRandomToken,
  parseUserInfo,
  statesMatch,
} from "../src/client.js";

const config = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://integrador.example.gob.cl/callback",
};

// Shape copied from the official guide (step 6), with a sandbox test RUN.
const userinfoBody = {
  sub: "1234567",
  RolUnico: { DV: "4", numero: 44444444, tipo: "RUN" },
  name: { apellidos: ["Del Río", "González"], nombres: ["María", "Carmen"] },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

describe("ClaveUnicaClient.authorizationUrl", () => {
  it("builds the documented authorize URL", () => {
    const client = new ClaveUnicaClient(config);
    const url = new URL(client.authorizationUrl({ state: "abcdefgh", nonce: "n-1" }));
    expect(`${url.origin}${url.pathname}`).toBe(CLAVEUNICA_ENDPOINTS.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "test-client-id",
      response_type: "code",
      scope: "openid run name",
      redirect_uri: "https://integrador.example.gob.cl/callback",
      state: "abcdefgh",
      nonce: "n-1",
    });
  });

  it("requires state", () => {
    const client = new ClaveUnicaClient(config);
    expect(() => client.authorizationUrl({ state: "" })).toThrow(ClaveUnicaError);
  });

  it("accepts an extra scope when configured", () => {
    const client = new ClaveUnicaClient({ ...config, scope: "openid run name email" });
    const url = new URL(client.authorizationUrl({ state: "s" }));
    expect(url.searchParams.get("scope")).toBe("openid run name email");
  });

  it("rejects bad configuration", () => {
    expect(() => new ClaveUnicaClient({ ...config, clientId: "" })).toThrow(/clientId/);
    expect(() => new ClaveUnicaClient({ ...config, redirectUri: "https://x.gob.cl/cb?a=1" })).toThrow(/query/);
  });
});

describe("ClaveUnicaClient token + userinfo", () => {
  it("exchanges the code with a form POST and reads userinfo with Bearer", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === CLAVEUNICA_ENDPOINTS.token) {
        return jsonResponse({
          access_token: "95104ab471534af08683aefa7d0935a3",
          token_type: "bearer",
          expires_in: 3600,
          id_token: fakeJwt({ nonce: "n-1" }),
        });
      }
      if (url === CLAVEUNICA_ENDPOINTS.userinfo) return jsonResponse(userinfoBody);
      return new Response("not found", { status: 404 });
    });
    const client = new ClaveUnicaClient({ ...config, fetch: fetchMock });

    const tokens = await client.handleCallback({ code: "c0de", state: "st" }, { state: "st", nonce: "n-1" });
    expect(tokens.access_token).toBe("95104ab471534af08683aefa7d0935a3");

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe(CLAVEUNICA_ENDPOINTS.token);
    expect(tokenInit?.method).toBe("POST");
    expect((tokenInit?.headers as Record<string, string>)["content-type"]).toMatch(/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit?.body)))).toEqual({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      redirect_uri: "https://integrador.example.gob.cl/callback",
      grant_type: "authorization_code",
      code: "c0de",
      state: "st",
    });

    const profile = await client.userInfo(tokens.access_token);
    const [uiUrl, uiInit] = fetchMock.mock.calls[1]!;
    expect(uiUrl).toBe(CLAVEUNICA_ENDPOINTS.userinfo);
    expect(uiInit?.method).toBe("POST");
    expect((uiInit?.headers as Record<string, string>).authorization).toBe(
      "Bearer 95104ab471534af08683aefa7d0935a3",
    );
    expect(profile.run).toEqual({ numero: 44444444, dv: "4" });
    expect(profile.nombreCompleto).toBe("María Carmen Del Río González");
    expect(profile.sub).toBe("1234567");
  });

  it("rejects a state mismatch before calling the token endpoint", async () => {
    const fetchMock = vi.fn();
    const client = new ClaveUnicaClient({ ...config, fetch: fetchMock });
    await expect(client.handleCallback({ code: "c", state: "other" }, { state: "st" })).rejects.toThrow(/state/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces provider errors in the callback", async () => {
    const client = new ClaveUnicaClient({ ...config, fetch: vi.fn() });
    await expect(
      client.handleCallback({ error: "access_denied", error_description: "cancelado" }, { state: "st" }),
    ).rejects.toThrow(/"access_denied": cancelado/);
  });

  it("rejects a nonce mismatch in the id_token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "t", token_type: "bearer", id_token: fakeJwt({ nonce: "evil" }) }),
    );
    const client = new ClaveUnicaClient({ ...config, fetch: fetchMock });
    await expect(client.handleCallback({ code: "c", state: "st" }, { state: "st", nonce: "n-1" })).rejects.toThrow(
      /nonce/,
    );
  });

  it("maps HTTP errors to ClaveUnicaError with status and body", async () => {
    const client = new ClaveUnicaClient({
      ...config,
      fetch: async () => jsonResponse({ error: "invalid_grant" }, 400),
    });
    const err = await client.exchangeCode({ code: "expired", state: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaveUnicaError);
    expect((err as ClaveUnicaError).status).toBe(400);
    expect((err as ClaveUnicaError).body).toEqual({ error: "invalid_grant" });
  });

  it("maps network errors", async () => {
    const client = new ClaveUnicaClient({
      ...config,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.userInfo("t")).rejects.toThrow(/Error de red/);
  });
});

describe("parseUserInfo", () => {
  it("rejects a RolUnico with a wrong check digit", () => {
    expect(() => parseUserInfo({ ...userinfoBody, RolUnico: { numero: 44444444, DV: "5", tipo: "RUN" } })).toThrow(
      /DV/,
    );
  });

  it("rejects a body without RolUnico", () => {
    expect(() => parseUserInfo({ sub: "1" })).toThrow(/RolUnico/);
  });

  it("accepts numero as a string and lower-case k", () => {
    const p = parseUserInfo({ ...userinfoBody, RolUnico: { numero: "44444444", DV: "4", tipo: "RUN" } });
    expect(p.run.numero).toBe(44444444);
  });
});

describe("logout and helpers", () => {
  it("builds the logout URL with optional redirect", () => {
    const client = new ClaveUnicaClient(config);
    expect(client.logoutUrl()).toBe(CLAVEUNICA_ENDPOINTS.logout);
    expect(client.logoutUrl("https://integrador.example.gob.cl/salir")).toBe(
      `${CLAVEUNICA_ENDPOINTS.logout}?redirect=https%3A%2F%2Fintegrador.example.gob.cl%2Fsalir`,
    );
  });

  it("creates distinct random tokens and compares states safely", () => {
    const a = createRandomToken();
    const b = createRandomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statesMatch(a, a)).toBe(true);
    expect(statesMatch(a, b)).toBe(false);
    expect(statesMatch(a, undefined)).toBe(false);
    expect(statesMatch(a, a.slice(1))).toBe(false);
  });
});
