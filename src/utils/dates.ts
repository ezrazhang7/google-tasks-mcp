/**
 * Google Tasks stores due dates as DATE ONLY. The API accepts an RFC 3339
 * timestamp but discards the time part, so the only safe encoding is UTC
 * midnight: a local-midnight timestamp west of UTC lands on the previous UTC
 * day and the task shows up a day early on Google Calendar.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate a YYYY-MM-DD string and return it normalized, or throw. */
export function assertDateOnly(value: string, field = "due"): string {
  const m = DATE_RE.exec(value.trim());
  if (!m) {
    throw new Error(
      `${field} must be a date in YYYY-MM-DD form (got "${value}"). Google Tasks ` +
        "stores dates only — it cannot record a time of day.",
    );
  }
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new Error(`${field} is not a real calendar date: "${value}".`);
  }
  return `${y}-${mo}-${d}`;
}

/** YYYY-MM-DD → RFC 3339 at UTC midnight, the form Google expects. */
export function toApiDate(value: string, field = "due"): string {
  return `${assertDateOnly(value, field)}T00:00:00.000Z`;
}

/** RFC 3339 from Google → YYYY-MM-DD (drops the meaningless time part). */
export function fromApiDate(value: string | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

/** Inclusive YYYY-MM-DD upper bound → exclusive RFC 3339 for dueMax. */
export function toApiDateExclusiveEnd(value: string, field: string): string {
  const day = assertDateOnly(value, field);
  const next = new Date(`${day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
