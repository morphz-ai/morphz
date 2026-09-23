/** One-time storage cleanup, not an alternate reading policy. */
export function removeReadingPolicyFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const changed = "personalContext" in record || "spoilers" in record;
  delete record.personalContext;
  delete record.spoilers;
  return changed;
}
