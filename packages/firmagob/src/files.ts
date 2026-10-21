import { createHash } from "node:crypto";

/** One element of the `files` array, as documented in the FirmaGob integration manual. */
export interface FirmaGobFile {
  "content-type": "application/pdf" | "application/xml" | "application/json";
  /** base64 of the file. For hash signing: the hash itself. */
  content: string;
  description: string;
  /** SHA256 (hex) of the file. */
  checksum: string;
  /** Optional XML (AgileSignerConfig) to place a visible signature image in a PDF. */
  layout?: string;
  /** XML only: ids of the nodes to sign, e.g. ["#nodo1"]. */
  references?: string[];
  /** XML only: signer info put inside the signature Object tag. */
  xmlObjects?: string[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function pdfFile(pdf: Buffer, description: string, layout?: string): FirmaGobFile {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("El contenido no parece un PDF (falta cabecera %PDF-)");
  }
  return {
    "content-type": "application/pdf",
    content: pdf.toString("base64"),
    description,
    checksum: sha256Hex(pdf),
    ...(layout ? { layout } : {}),
  };
}

export function xmlFile(
  xml: Buffer | string,
  description: string,
  opts: { references?: string[]; xmlObjects?: string[] } = {},
): FirmaGobFile {
  const buf = Buffer.isBuffer(xml) ? xml : Buffer.from(xml, "utf8");
  return {
    "content-type": "application/xml",
    content: buf.toString("base64"),
    description,
    checksum: sha256Hex(buf),
    ...(opts.references ? { references: opts.references } : {}),
    ...(opts.xmlObjects ? { xmlObjects: opts.xmlObjects } : {}),
  };
}

export function jsonFile(value: unknown, description: string): FirmaGobFile {
  const buf = Buffer.from(JSON.stringify(value), "utf8");
  return { "content-type": "application/json", content: buf.toString("base64"), description, checksum: sha256Hex(buf) };
}

/**
 * Hash signing: `content` is the hash (base64) of the data to sign, typically the
 * byte range of a PDF prepared for an external signature. The response content is a
 * PKCS#7 (p7s) that the caller embeds in the PDF signature dictionary.
 */
export function hashFile(hashBase64: string, description: string): FirmaGobFile {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(hashBase64)) throw new Error("hash debe ir en base64");
  return {
    "content-type": "application/json",
    content: hashBase64,
    description,
    checksum: sha256Hex(Buffer.from(hashBase64, "base64")),
  };
}

export interface LayoutOptions {
  llx: number;
  lly: number;
  urx: number;
  ury: number;
  /** Page number or "LAST". */
  page: number | "LAST";
  /** Signature image, base64. */
  imageBase64: string;
}

/** Builds the AgileSignerConfig XML documented in Anexo B of the manual. */
export function buildLayoutXml(o: LayoutOptions): string {
  for (const k of ["llx", "lly", "urx", "ury"] as const) {
    if (!Number.isInteger(o[k])) throw new Error(`${k} debe ser entero`);
  }
  if (o.page !== "LAST" && (!Number.isInteger(o.page) || o.page < 1)) throw new Error("page inválida");
  return (
    `<AgileSignerConfig><Application id="THIS-CONFIG"><pdfPassword/><Signature>` +
    `<Visible active="true" layer2="false" label="true" pos="1">` +
    `<llx>${o.llx}</llx><lly>${o.lly}</lly><urx>${o.urx}</urx><ury>${o.ury}</ury>` +
    `<page>${o.page}</page><image>BASE64</image><BASE64VALUE>${o.imageBase64}</BASE64VALUE>` +
    `</Visible></Signature></Application></AgileSignerConfig>`
  );
}
