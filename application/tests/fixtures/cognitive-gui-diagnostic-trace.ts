/** Opt-in observation for synthetic CI fixtures only. No application hooks,
 * requests, state, waits, click retries or production timeouts are replaced. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

type TraceContext = {
  tracing: {
    start(options: {
      screenshots: boolean;
      snapshots: boolean;
      sources: boolean;
    }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
};
export const guiDiagnosticTraceEnv = "MORPHZ_CI_GUI_TRACE_DIR";

export async function startCognitiveGuiDiagnosticTrace(
  context: TraceContext,
  label: string,
) {
  const directory = process.env[guiDiagnosticTraceEnv];
  // Normal tests do not enable CDP tracing, create output or add explicit waits.
  if (directory === undefined) return async () => {};
  if (!isAbsolute(directory) || !/^[a-z0-9-]{1,80}$/.test(label))
    throw new Error("GUI diagnosis requires an absolute directory and fixed label");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${label}-${process.pid}-${randomUUID()}.zip`);
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const identity = { label, pid: process.pid, path };
  console.log("[ci-gui-trace] " + JSON.stringify({ event: "started", ...identity }));
  let stopped: Promise<void> | undefined;
  return () => {
    // A context belongs to one fixture. Repeated cleanup never overwrites or
    // attempts to stop another context's trace, and never swallows save failure.
    stopped ??= context.tracing.stop({ path }).then(() => {
      console.log("[ci-gui-trace] " + JSON.stringify({ event: "saved", ...identity }));
    });
    return stopped;
  };
}
