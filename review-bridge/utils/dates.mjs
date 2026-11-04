export const DAY_MS = 86_400_000;

// Local calendar day, because the person reads these next to their own clock.
export function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date for archive.");
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

// A moment as the person reads it, in local time with its offset, as `git log --date=iso` prints it:
// 2026-11-04 13:33:27 +0800.
export function localTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date to print.");
  const pad = (n) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return localDateKey(date) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
    + " " + (offset < 0 ? "-" : "+") + pad(Math.trunc(Math.abs(offset) / 60)) + pad(Math.abs(offset) % 60);
}

// Whether the moment `iso` lies more than `days` whole days before `now`.
export function olderThan(iso, days, now) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return now - time > days * DAY_MS;
}

// A sortable, filename-safe UTC stamp: 20261016T101500123Z.
export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");
}
