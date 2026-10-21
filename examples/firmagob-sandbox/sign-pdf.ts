import { writeFileSync } from "node:fs";
import {
  FIRMAGOB_TEST_DATA,
  FIRMAGOB_URLS,
  FirmaGobClient,
  FirmaGobError,
  pdfFile,
  PURPOSE_UNATTENDED,
} from "../../packages/firmagob/src/index.js";
import { minimalPdf } from "./minimal-pdf.js";

/**
 * Unattended signature of a small PDF in the FirmaGob TEST environment,
 * using the generic test data published in the manual (signatures there are not valid).
 *
 * To use your own registration, set FIRMAGOB_API_TOKEN_KEY, FIRMAGOB_SECRET,
 * FIRMAGOB_ENTITY, FIRMAGOB_RUN, FIRMAGOB_PURPOSE and optionally FIRMAGOB_URL / FIRMAGOB_OTP.
 */
const env = process.env;
const client = new FirmaGobClient({
  apiTokenKey: env.FIRMAGOB_API_TOKEN_KEY ?? FIRMAGOB_TEST_DATA.apiTokenKey,
  secret: env.FIRMAGOB_SECRET ?? FIRMAGOB_TEST_DATA.secret,
  entity: env.FIRMAGOB_ENTITY ?? FIRMAGOB_TEST_DATA.entity,
  url: env.FIRMAGOB_URL ?? FIRMAGOB_URLS.test,
});

const out = process.argv[2] ?? "firmado-test.pdf";
try {
  const result = await client.sign({
    run: env.FIRMAGOB_RUN ?? FIRMAGOB_TEST_DATA.unattended.run,
    purpose: env.FIRMAGOB_PURPOSE ?? PURPOSE_UNATTENDED,
    otp: env.FIRMAGOB_OTP,
    files: [pdfFile(minimalPdf("Documento de prueba chile-gob-digital-toolkit"), "Documento de prueba")],
  });
  const file = result.files[0];
  console.log(JSON.stringify({ ...result, raw: undefined, files: result.files.map((f) => ({ ...f, content: f.content ? `<${f.content.length} chars base64>` : undefined })) }, null, 2));
  if (file?.ok && file.content) {
    writeFileSync(out, Buffer.from(file.content, "base64"));
    console.log(`PDF firmado guardado en ${out}`);
  } else {
    process.exitCode = 1;
  }
} catch (err) {
  if (err instanceof FirmaGobError) {
    console.error(err.message, err.body ?? "");
    process.exitCode = 1;
  } else {
    throw err;
  }
}
