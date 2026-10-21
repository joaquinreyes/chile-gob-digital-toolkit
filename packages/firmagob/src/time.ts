/**
 * FirmaGob expects `expiration` in Chilean local time, format YYYY-MM-DDTHH:MM:SS,
 * no more than 30 minutes ahead. Chile uses America/Santiago (with DST).
 */
export const CHILE_TZ = "America/Santiago";

export function formatChileDateTime(date: Date, timeZone: string = CHILE_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export const MAX_EXPIRATION_MINUTES = 30;
