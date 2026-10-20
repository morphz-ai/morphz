/** System integration only. Never inherit provider, database or app settings. */
export function nativeTestEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    // Xvfb requires both its display address and the matching Xauthority file.
    // Dropping the latter must not be worked around by disabling X access control.
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
