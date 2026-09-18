/** Canonical Morphz application names. Legacy values exist only for compatibility. */
export const applicationManifestFormat = "morphz-app/v1";
export const legacyApplicationManifestFormat = "morphz-work-app/v1";
export const applicationStoragePrefix = "morphz:";
export const legacyApplicationStoragePrefix = "morphzwork:";
export const applicationWindowKey = applicationStoragePrefix + "window";
export const legacyApplicationWindowKey =
  legacyApplicationStoragePrefix + "window";
export const applicationTokenHeader = "X-Morphz-Token";
export const legacyApplicationTokenHeader = "X-MorphzWork-Token";
export const objectToolName = "host_morphz";
export const legacyObjectToolName = "host_morphz_work";

export function isObjectToolName(name: string) {
  return name === objectToolName || name === legacyObjectToolName;
}

/** An installed package keeps its original protocol; never rewrite its HTML. */
export function applicationMessagePrefix(format: string) {
  return format === legacyApplicationManifestFormat
    ? "morphz-work:"
    : "morphz-app:";
}

/** Accept either header, but conflicting names never bypass CSRF validation. */
export function applicationTokenMatches(
  headers: Record<string, string | string[] | undefined>,
  expected: string,
) {
  const current = headers[applicationTokenHeader.toLowerCase()];
  const legacy = headers[legacyApplicationTokenHeader.toLowerCase()];
  return (
    (current !== undefined || legacy !== undefined) &&
    (current === undefined || current === expected) &&
    (legacy === undefined || legacy === expected)
  );
}
