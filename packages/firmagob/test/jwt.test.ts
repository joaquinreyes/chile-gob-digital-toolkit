import { describe, expect, it } from "vitest";
import { signHs256, verifyHs256 } from "../src/jwt.js";
import { formatChileDateTime } from "../src/time.js";
import { FIRMAGOB_TEST_DATA } from "../src/client.js";

// Token, payload and secret published in the FirmaGob integration manual (TEST environment).
const MANUAL_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbnRpdHkiOiJTdWJzZWNyZXRhcsOtYSBHZW5lcmFsIGRlIGxhIFByZXNpZGVuY2lhIiwicnVuIjoiMjIyMjIyMjIiLCJleHBpcmF0aW9uIjoiMjAyMS0xMS0xNVQxNzozMTowMCIsInB1cnBvc2UiOiJEZXNhdGVuZGlkbyJ9.EqcNFArqasx_hlZSYTO2Tnuqa36dMn_qnmk90XEyhTA";
const MANUAL_PAYLOAD = {
  entity: "Subsecretaría General de la Presidencia",
  run: "22222222",
  expiration: "2021-11-15T17:31:00",
  purpose: "Desatendido",
};

describe("HS256", () => {
  it("reproduces byte-for-byte the example token from the FirmaGob manual", () => {
    expect(signHs256(MANUAL_PAYLOAD, FIRMAGOB_TEST_DATA.secret)).toBe(MANUAL_TOKEN);
  });

  it("verifies the manual token and rejects a wrong secret or tampering", () => {
    expect(verifyHs256(MANUAL_TOKEN, FIRMAGOB_TEST_DATA.secret)).toEqual(MANUAL_PAYLOAD);
    expect(() => verifyHs256(MANUAL_TOKEN, "otro-secreto")).toThrow(/firma/);
    const [h, , s] = MANUAL_TOKEN.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...MANUAL_PAYLOAD, run: "30000000" })).toString("base64url")}.${s}`;
    expect(() => verifyHs256(forged, FIRMAGOB_TEST_DATA.secret)).toThrow(/firma/);
  });

  it("rejects an empty secret", () => {
    expect(() => signHs256({}, "")).toThrow();
  });
});

describe("formatChileDateTime", () => {
  it("uses Chile summer time (UTC-3) in January", () => {
    expect(formatChileDateTime(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15T09:00:00");
  });

  it("uses Chile winter time (UTC-4) in July", () => {
    expect(formatChileDateTime(new Date("2026-07-15T12:00:00Z"))).toBe("2026-07-15T08:00:00");
  });

  it("handles midnight with h23", () => {
    expect(formatChileDateTime(new Date("2026-07-15T04:00:30Z"))).toBe("2026-07-15T00:00:30");
  });
});
