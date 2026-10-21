/**
 * RUN (Rol Único Nacional) helpers.
 *
 * The check digit (dígito verificador) uses the standard modulo 11 algorithm:
 * multiply the digits right to left by 2,3,4,5,6,7,2,3,... and sum them.
 * dv = 11 - (sum % 11), where 11 -> "0" and 10 -> "K".
 */

export interface Run {
  /** Number without check digit, e.g. 44444444. */
  numero: number;
  /** Check digit: "0"-"9" or "K". */
  dv: string;
}

export class InvalidRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunError";
  }
}

const MAX_RUN = 99_999_999;

export function computeDv(numero: number): string {
  if (!Number.isInteger(numero) || numero < 1 || numero > MAX_RUN) {
    throw new InvalidRunError(`RUN fuera de rango: ${numero}`);
  }
  let sum = 0;
  let factor = 2;
  let rest = numero;
  while (rest > 0) {
    sum += (rest % 10) * factor;
    rest = Math.floor(rest / 10);
    factor = factor === 7 ? 2 : factor + 1;
  }
  const value = 11 - (sum % 11);
  if (value === 11) return "0";
  if (value === 10) return "K";
  return String(value);
}

/** Removes dots, spaces and dashes and upper-cases a trailing "k". */
export function cleanRun(input: string): string {
  return input.replace(/[.\s-]/g, "").toUpperCase();
}

/**
 * Parses a RUN with check digit in any common format:
 * "44.444.444-4", "44444444-4", "444444444".
 * Throws InvalidRunError when the format or the check digit is wrong.
 */
export function parseRun(input: string): Run {
  const clean = cleanRun(input);
  if (!/^\d{1,8}[0-9K]$/.test(clean)) {
    throw new InvalidRunError(`Formato de RUN inválido: "${input}"`);
  }
  const numero = Number(clean.slice(0, -1));
  const dv = clean.slice(-1);
  const expected = computeDv(numero);
  if (dv !== expected) {
    throw new InvalidRunError(`Dígito verificador incorrecto para "${input}"`);
  }
  return { numero, dv };
}

export function isValidRun(input: string): boolean {
  try {
    parseRun(input);
    return true;
  } catch {
    return false;
  }
}

/** Formats as "44.444.444-4". */
export function formatRun(run: Run): string {
  const withDots = String(run.numero).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${run.dv}`;
}
