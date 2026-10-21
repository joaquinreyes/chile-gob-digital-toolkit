import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaveUnicaClient, claveUnicaEndpoints } from "../../packages/clave-unica/src/index.js";
import { createApp } from "./app.js";
import { createMockProvider } from "./mock-provider.js";

// End-to-end over real HTTP: demo app <-> local mock provider (same paths and shapes as the guide).
let mock: Server;
let app: Server;
let appUrl: string;
let mockUrl: string;

function listen(handler: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise((resolve) => {
    const s = handler.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

beforeAll(async () => {
  mock = await listen(createMockProvider({ clientId: "cid", clientSecret: "csecret" }));
  mockUrl = urlOf(mock);
  // Port is needed for the redirect URI, so bind first, then attach the app.
  const { createServer } = await import("node:http");
  app = createServer();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  appUrl = urlOf(app);
  const client = new ClaveUnicaClient({
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: `${appUrl}/callback`,
    endpoints: claveUnicaEndpoints(mockUrl),
  });
  app.on("request", createApp({ client, logoutRedirect: `${appUrl}/` }));
});

afterAll(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => mock.close(r));
});

async function get(url: string, cookie?: string, accept = "text/html") {
  return fetch(url, { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), accept } });
}

describe("example app full flow", () => {
  it("login -> ClaveÚnica (mock) -> callback -> profile -> logout", async () => {
    const login = await get(`${appUrl}/login`);
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authorize = new URL(login.headers.get("location")!);
    expect(authorize.pathname).toBe("/openid/authorize/");
    expect(authorize.searchParams.get("scope")).toBe("openid run name");

    const provider = await get(authorize.toString());
    expect(provider.status).toBe(302);
    const callback = provider.headers.get("location")!;
    expect(callback.startsWith(`${appUrl}/callback?code=`)).toBe(true);

    const cb = await get(callback, cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/profile");

    const profile = await get(`${appUrl}/profile`, cookie, "application/json");
    expect(await profile.json()).toEqual({ run: "44.444.444-4", nombres: ["Usuario"], apellidos: ["De", "Prueba"] });

    // Replaying the same callback must fail: state is single-use.
    const replay = await get(callback, cookie);
    expect(replay.status).toBe(400);

    const logout = await get(`${appUrl}/logout`, cookie);
    expect(logout.headers.get("location")).toBe(
      `${mockUrl}/api/v1/accounts/app/logout?redirect=${encodeURIComponent(`${appUrl}/`)}`,
    );
    const after = await get(`${appUrl}/profile`, cookie);
    expect(after.status).toBe(302);
  });

  it("rejects a callback with a forged state", async () => {
    const login = await get(`${appUrl}/login`);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await get(`${appUrl}/callback?code=x&state=forged`, cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state no coincide");
  });
});
