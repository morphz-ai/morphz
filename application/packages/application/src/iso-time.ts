/** Runtime Events retain nanoseconds while SQL timeline keys retain whole
 * microseconds. Parse the same strict ISO instant for citations and cursors;
 * Date.parse alone both loses precision and accepts normalized invalid dates.
 */
export function isoTimeMicros(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > 31 ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  // setUTCFullYear preserves years 0000..0099, unlike Date.UTC's 1900 offset.
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!);
  date.setUTCHours(hour!, minute!, second!, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const offsetMillis =
    (offsetHour * 60 + offsetMinute) * 60_000 * (match[9] === "-" ? -1 : 1);
  const micros =
    (date.getTime() - offsetMillis) * 1_000 +
    Number((match[7] ?? "").padEnd(6, "0").slice(0, 6));
  return Number.isSafeInteger(micros) ? micros : null;
}

/** Canonical UTC representation of an integer SQL ordering key. */
export function isoTimeAtMicros(micros: number): string | null {
  if (!Number.isSafeInteger(micros)) return null;
  const seconds = Math.floor(micros / 1_000_000);
  const fraction = micros - seconds * 1_000_000;
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  const value = date
    .toISOString()
    .replace(".000Z", `.${String(fraction).padStart(6, "0")}Z`);
  return isoTimeMicros(value) === micros ? value : null;
}

export function sameIsoTimeMicros(left: string, right: string): boolean {
  const micros = isoTimeMicros(left);
  return micros !== null && micros === isoTimeMicros(right);
}
