import { describe, expect, it, vi } from "vitest";
import {
  consumidorEntry,
  NodoClient,
  parseTransactionId,
  PiseeError,
  proveedorEntry,
} from "../src/index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NodoClient", () => {
  it("calls the documented connectivity test on the local Nodo", async () => {
    // Response shape copied from the Nodo v2 manual.
    const body = {
      id: 53,
      codigo: "PE-SUB-00053",
      descripcion: "Subsecretaría de Hacienda",
      identificador: "1.PE-SUB-00053",
      vigente: true,
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(body));
    const org = await new NodoClient({ fetch: fetchMock }).detalleOrganismo("PE-SUB-00053");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:8084/detalleOrganismo/PE-SUB-00053");
    expect(org.descripcion).toBe("Subsecretaría de Hacienda");
  });

  it("sends JSON bodies with POST and query params", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true }));
    const nodo = new NodoClient({ baseUrl: "http://nodo.interno:8084/", fetch: fetchMock });
    const res = await nodo.call("/mtt/consultaVehiculo", { body: { patente: "ZZ0000" }, query: { v: 2, x: undefined } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://nodo.interno:8084/mtt/consultaVehiculo?v=2");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init?.body).toBe('{"patente":"ZZ0000"}');
    expect(res.data).toEqual({ ok: true });
  });

  it("returns text bodies as text", async () => {
    const nodo = new NodoClient({ fetch: async () => new Response("<xml/>", { headers: { "content-type": "text/xml" } }) });
    expect((await nodo.call("/svc")).data).toBe("<xml/>");
  });

  it("maps HTTP and network errors", async () => {
    const bad = new NodoClient({ fetch: async () => json({ error: "no autorizado" }, 403) });
    const err = await bad.call("/svc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiseeError);
    expect((err as PiseeError).status).toBe(403);
    expect((err as PiseeError).body).toEqual({ error: "no autorizado" });

    const down = new NodoClient({
      fetch: async () => {
        throw new TypeError("ECONNREFUSED");
      },
    });
    await expect(down.call("/svc")).rejects.toThrow(/No se pudo contactar/);
  });

  it("rejects unsafe paths and bad institution codes", async () => {
    const nodo = new NodoClient({ fetch: vi.fn() });
    await expect(nodo.call("sin-slash")).rejects.toThrow(PiseeError);
    await expect(nodo.call("/../etc")).rejects.toThrow(PiseeError);
    await expect(nodo.detalleOrganismo("x")).rejects.toThrow(/organismo/);
  });
});

describe("config.json entries", () => {
  it("builds a consumer entry, with the PISEE 1 pair", () => {
    expect(consumidorEntry({ nombre: "ConsultaX", rutaLocal: "/algo/x" })).toEqual({ nombre: "ConsultaX", rutaLocal: "/algo/x" });
    expect(() => consumidorEntry({ nombre: "A", rutaLocal: "/a", servicioPisee: "s" })).toThrow(/juntos/);
  });

  it("builds and validates a provider entry", () => {
    expect(
      proveedorEntry({ nombre: "ConsultaPermiso", rutaLocalServicio: "http://10.0.0.5/api/permiso", rutaExterna: "/mtt/permiso", tps: 10 }),
    ).toEqual({
      nombre: "ConsultaPermiso",
      origen: { tipo: "WEB_SERVICE", rutaLocal: "http://10.0.0.5/api/permiso" },
      rutaExterna: "/mtt/permiso",
      tps: 10,
    });
    const ok = { nombre: "Svc", rutaLocalServicio: "http://x/a", rutaExterna: "/a", tps: 1 };
    expect(() => proveedorEntry({ ...ok, nombre: "consulta_permiso" })).toThrow(/PascalCase/);
    expect(() => proveedorEntry({ ...ok, tps: 0 })).toThrow(/tps/);
    expect(() => proveedorEntry({ ...ok, rutaExterna: "a" })).toThrow(/rutaExterna/);
    expect(() => proveedorEntry({ ...ok, rutaLocalServicio: "no-url" })).toThrow(/URL/);
  });
});

describe("parseTransactionId", () => {
  it("parses the example from the interoperability model", () => {
    const t = parseTransactionId("6.01GK313E4VSGGB69DKNPTFAM6K");
    expect(t.organismo).toBe("6");
    expect(t.ulid).toBe("01GK313E4VSGGB69DKNPTFAM6K");
    // ULID time prefix 01GK313E4V -> 2022-11-30 UTC (checked independently)
    expect(t.timestamp.toISOString().slice(0, 10)).toBe("2022-11-30");
  });

  it("rejects malformed ids", () => {
    expect(() => parseTransactionId("01GK313E4VSGGB69DKNPTFAM6K")).toThrow(PiseeError);
    expect(() => parseTransactionId("6.NOT-A-ULID")).toThrow(PiseeError);
  });
});
