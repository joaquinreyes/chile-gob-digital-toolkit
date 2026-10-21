import { describe, expect, it, vi } from "vitest";
import {
  FIRMAGOB_TEST_DATA,
  FIRMAGOB_URLS,
  FirmaGobClient,
  FirmaGobError,
  parseSignResponse,
  PURPOSE_GENERAL,
  PURPOSE_UNATTENDED,
  toFirmaGobRun,
} from "../src/client.js";
import { buildLayoutXml, hashFile, jsonFile, pdfFile, sha256Hex, xmlFile } from "../src/files.js";
import { verifyHs256 } from "../src/jwt.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");
const NOW = new Date("2026-10-21T15:00:00Z"); // 12:00 in Chile (UTC-3, DST)

function client(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
  return new FirmaGobClient({
    apiTokenKey: FIRMAGOB_TEST_DATA.apiTokenKey,
    secret: FIRMAGOB_TEST_DATA.secret,
    entity: FIRMAGOB_TEST_DATA.entity,
    url: FIRMAGOB_URLS.test,
    fetch: fetchImpl,
    now: () => NOW,
  });
}

// Appends a raw JSON fragment so big integers stay as numbers, like the real API.
function raw(body: Record<string, unknown>, extra: string) {
  const text = JSON.stringify(body).replace(/}$/, `${extra}}`);
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("toFirmaGobRun", () => {
  it("strips dots, dash and DV", () => {
    expect(toFirmaGobRun("22.222.222-2")).toBe("22222222");
    expect(toFirmaGobRun("22222222")).toBe("22222222");
  });
  it("validates the DV when present", () => {
    expect(() => toFirmaGobRun("22.222.222-3")).toThrow(/verificador/);
    expect(() => toFirmaGobRun("abc")).toThrow(FirmaGobError);
  });
});

describe("buildRequest", () => {
  it("builds the unattended body with a valid JWT and no OTP header", () => {
    const req = client().buildRequest({
      run: "22.222.222-2",
      purpose: PURPOSE_UNATTENDED,
      files: [pdfFile(PDF, "Resolución de prueba")],
    });
    expect(req.url).toBe("https://api.firma.cert.digital.gob.cl/firma/v2/files/tickets");
    expect(req.headers.OTP).toBeUndefined();
    const body = JSON.parse(req.body);
    expect(body.api_token_key).toBe("sandbox");
    expect(verifyHs256(body.token, FIRMAGOB_TEST_DATA.secret)).toEqual({
      entity: "Subsecretaría General de la Presidencia",
      run: "22222222",
      expiration: "2026-10-21T12:05:00",
      purpose: "Desatendido",
    });
    expect(body.files).toEqual([
      {
        "content-type": "application/pdf",
        content: PDF.toString("base64"),
        description: "Resolución de prueba",
        checksum: sha256Hex(PDF),
      },
    ]);
  });

  it("adds the OTP header for attended signature", () => {
    const req = client().buildRequest({
      run: "11111111",
      purpose: PURPOSE_GENERAL,
      otp: "123456",
      files: [jsonFile({ a: 1 }, "json")],
    });
    expect(req.headers.OTP).toBe("123456");
  });

  it("enforces the OTP rules", () => {
    const files = [pdfFile(PDF, "x")];
    expect(() => client().buildRequest({ run: "22222222", purpose: PURPOSE_UNATTENDED, otp: "123456", files })).toThrow(
      /desatendida/,
    );
    expect(() => client().buildRequest({ run: "11111111", purpose: PURPOSE_GENERAL, files })).toThrow(/requiere OTP/);
    expect(() =>
      client().buildRequest({ run: "11111111", purpose: PURPOSE_GENERAL, otp: "12ab", files }),
    ).toThrow(/OTP/);
  });

  it("enforces expiration <= 30 minutes, at least one file and 5 MB", () => {
    const c = client();
    expect(() => c.buildToken({ run: "22222222", purpose: PURPOSE_UNATTENDED, expiresInMinutes: 31 })).toThrow(/30/);
    expect(() => c.buildRequest({ run: "22222222", purpose: PURPOSE_UNATTENDED, files: [] })).toThrow(/documento/);
    const big = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(4 * 1024 * 1024)]);
    expect(() =>
      c.buildRequest({ run: "22222222", purpose: PURPOSE_UNATTENDED, files: [pdfFile(big, "big")] }),
    ).toThrow(/5 MB/);
  });

  it("rejects missing configuration", () => {
    expect(() => new FirmaGobClient({ apiTokenKey: "", secret: "s", entity: "e" })).toThrow(/apiTokenKey/);
  });
});

describe("file builders", () => {
  it("rejects non-PDF content", () => {
    expect(() => pdfFile(Buffer.from("hola"), "x")).toThrow(/PDF/);
  });

  it("builds XML with references and xmlObjects", () => {
    const f = xmlFile("<a id='nodo1'/>", "xml", { references: ["#nodo1"], xmlObjects: ["<b/>"] });
    expect(f["content-type"]).toBe("application/xml");
    expect(Buffer.from(f.content, "base64").toString()).toBe("<a id='nodo1'/>");
    expect(f.references).toEqual(["#nodo1"]);
  });

  it("builds a hash file", () => {
    const h = Buffer.from(sha256Hex("datos"), "hex").toString("base64");
    const f = hashFile(h, "hash");
    expect(f.content).toBe(h);
    expect(f["content-type"]).toBe("application/json");
    expect(() => hashFile("no es base64!", "x")).toThrow();
  });

  it("builds the AgileSignerConfig layout", () => {
    const xml = buildLayoutXml({ llx: 250, lly: 300, urx: 350, ury: 450, page: "LAST", imageBase64: "iVBORw0K" });
    expect(xml).toContain("<llx>250</llx>");
    expect(xml).toContain("<page>LAST</page>");
    expect(xml).toContain("<BASE64VALUE>iVBORw0K</BASE64VALUE>");
    expect(() => buildLayoutXml({ llx: 1.5, lly: 0, urx: 0, ury: 0, page: 1, imageBase64: "" })).toThrow();
  });
});

describe("sign (mocked HTTP)", () => {
  it("POSTs JSON and parses the documented 200 response", async () => {
    const signed = Buffer.from("%PDF-1.4 firmado");
    const fetchMock = vi.fn(async () =>
      raw({
        files: [
          {
            content: signed.toString("base64"),
            status: "OK",
            contentType: "application/pdf",
            description: "Resolución",
            documentStatus: "FIRMADO",
            checksum_original: sha256Hex(PDF),
            checksum_signed: sha256Hex(signed),
          },
        ],
        metadata: { otpExpired: false, filesSigned: 1, signedFailed: 0, objectsReceived: 1 },
      }, ', "idSolicitud": 570880299954241865'),
    );
    const result = await client(fetchMock).sign({
      run: "22222222",
      purpose: PURPOSE_UNATTENDED,
      files: [pdfFile(PDF, "Resolución")],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FIRMAGOB_URLS.test);
    expect(init.method).toBe("POST");
    expect(result.files[0]).toMatchObject({ ok: true, documentStatus: "FIRMADO", checksumVerified: true });
    expect(result.metadata).toEqual({ otpExpired: false, filesSigned: 1, signedFailed: 0, filesReceived: 1 });
    expect(result.requestId).toBe("570880299954241865");
  });

  it.each([
    [400, "Fecha de expiración del token está vencida"],
    [404, "El certificado no es válido, se encuentra expirado o no existe"],
    [412, "Verificaciòn de OTP fallido"],
    [429, "Ha excedido el número máximo de intentos de OTP. Intente mas tarde"],
  ])("maps HTTP %i errors with the server message", async (status, error) => {
    const c = client(async () => json({ timestamp: "2026-10-21 12:00:00", status, error }, status));
    const err = await c
      .sign({ run: "22222222", purpose: PURPOSE_UNATTENDED, files: [pdfFile(PDF, "x")] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirmaGobError);
    expect((err as FirmaGobError).status).toBe(status);
    expect((err as FirmaGobError).message).toContain(error);
  });

  it("maps network errors", async () => {
    const c = client(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(c.sign({ run: "22222222", purpose: PURPOSE_UNATTENDED, files: [pdfFile(PDF, "x")] })).rejects.toThrow(
      /red/,
    );
  });
});

describe("parseSignResponse", () => {
  it("accepts the snake_case schema and flags per-file errors", () => {
    const r = parseSignResponse({
      session_token: "abc",
      files: [{ status: "error", checksum_original: "x" }],
      metadata: { OTP_expired: true, files_recived: 1, files_signed: 0, signed_failed: 1 },
    });
    expect(r.files[0]!.ok).toBe(false);
    expect(r.metadata).toEqual({ otpExpired: true, filesSigned: 0, signedFailed: 1, filesReceived: 1 });
    expect(r.sessionToken).toBe("abc");
  });

  it("detects a checksum mismatch", () => {
    const r = parseSignResponse({ files: [{ status: "OK", content: "aGVsbG8=", checksum_signed: "00" }] });
    expect(r.files[0]!.checksumVerified).toBe(false);
  });

  it("rejects a body without files", () => {
    expect(() => parseSignResponse({ foo: 1 })).toThrow(/files/);
  });
});
