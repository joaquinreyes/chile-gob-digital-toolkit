import { describe, expect, it } from "vitest";
import { cleanRun, computeDv, formatRun, InvalidRunError, isValidRun, parseRun } from "../src/run.js";

// Test RUNs published in the ClaveÚnica sandbox guide, plus synthetic RUNs in the 30.000.000+ range.
describe("computeDv", () => {
  it.each([
    [44444444, "4"],
    [55555555, "5"],
    [88888888, "8"],
    [99999999, "9"],
    [22222222, "2"],
    [11111111, "1"],
  ])("sandbox RUN %i -> %s", (numero, dv) => {
    expect(computeDv(numero)).toBe(dv);
  });

  it("returns K and 0 for the edge cases of modulo 11", () => {
    // Find synthetic RUNs that hit both edge cases to cover the mapping.
    const dvs = new Set<string>();
    for (let n = 30_000_000; n < 30_000_100; n++) dvs.add(computeDv(n));
    expect(dvs.has("K")).toBe(true);
    expect(dvs.has("0")).toBe(true);
  });

  it("rejects out-of-range input", () => {
    expect(() => computeDv(0)).toThrow(InvalidRunError);
    expect(() => computeDv(1.5)).toThrow(InvalidRunError);
    expect(() => computeDv(100_000_000)).toThrow(InvalidRunError);
  });
});

describe("parseRun", () => {
  it("accepts common formats", () => {
    expect(parseRun("44.444.444-4")).toEqual({ numero: 44444444, dv: "4" });
    expect(parseRun("44444444-4")).toEqual({ numero: 44444444, dv: "4" });
    expect(parseRun(" 444444444 ")).toEqual({ numero: 44444444, dv: "4" });
  });

  it("accepts lower-case k", () => {
    const n = Array.from({ length: 200 }, (_, i) => 30_000_000 + i).find((x) => computeDv(x) === "K")!;
    expect(parseRun(`${n}-k`)).toEqual({ numero: n, dv: "K" });
  });

  it("rejects a wrong check digit", () => {
    expect(() => parseRun("44.444.444-5")).toThrow(/verificador/);
    expect(isValidRun("44.444.444-5")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(() => parseRun("abc")).toThrow(InvalidRunError);
    expect(() => parseRun("")).toThrow(InvalidRunError);
    expect(() => parseRun("123456789-0")).toThrow(InvalidRunError);
  });
});

describe("formatRun / cleanRun", () => {
  it("formats with dots and dash", () => {
    expect(formatRun({ numero: 30123456, dv: computeDv(30123456) })).toBe(`30.123.456-${computeDv(30123456)}`);
    expect(formatRun({ numero: 1234567, dv: "4" })).toBe("1.234.567-4");
  });

  it("cleans separators", () => {
    expect(cleanRun("30.000.000-k")).toBe("30000000K");
  });
});
