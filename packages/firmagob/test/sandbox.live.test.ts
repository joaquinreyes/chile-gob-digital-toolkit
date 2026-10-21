import { describe, expect, it } from "vitest";
import {
  FIRMAGOB_TEST_DATA,
  FIRMAGOB_URLS,
  FirmaGobClient,
  pdfFile,
  PURPOSE_UNATTENDED,
} from "../src/index.js";
import { minimalPdf } from "../../../examples/firmagob-sandbox/minimal-pdf.js";

// Real HTTP call to the FirmaGob TEST environment with the generic data published in the manual.
// Skipped unless FIRMAGOB_LIVE=1, so normal CI does not depend on an external server.
describe.skipIf(process.env.FIRMAGOB_LIVE !== "1")("FirmaGob TEST environment (live)", () => {
  it("signs a PDF unattended and returns a PDF with a PKCS#7 signature", async () => {
    const client = new FirmaGobClient({
      apiTokenKey: FIRMAGOB_TEST_DATA.apiTokenKey,
      secret: FIRMAGOB_TEST_DATA.secret,
      entity: FIRMAGOB_TEST_DATA.entity,
      url: FIRMAGOB_URLS.test,
    });
    const pdf = minimalPdf("chile-gob-digital-toolkit live test");
    const result = await client.sign({
      run: FIRMAGOB_TEST_DATA.unattended.run,
      purpose: PURPOSE_UNATTENDED,
      files: [pdfFile(pdf, "live test")],
    });
    const file = result.files[0]!;
    expect(file.ok).toBe(true);
    expect(file.documentStatus).toBe("FIRMADO");
    const signed = Buffer.from(file.content!, "base64");
    expect(signed.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(signed.toString("latin1")).toContain("/ByteRange");
    expect(result.metadata.filesSigned).toBe(1);
  }, 60_000);
});
