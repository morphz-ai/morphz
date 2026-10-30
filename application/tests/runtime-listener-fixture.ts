import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";

/** Only a ChildProcess created by the isolated fixture may be passed here.
 * A signal exit leaves exitCode null forever; it is already finished. */
export async function stopRuntimeFixtureChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Only the canonical Runtime's structured bound-listener diagnostic is
 * startup authority. A configured :0, human log, model text or other target
 * cannot choose the synthetic fixture's endpoint. */
export function runtimeListenerFromJsonLine(line: string): string | undefined {
  let value: any;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (
    value?.target !== "morphz::web" ||
    value.fields?.event_code !== "web.dashboard_api.started"
  )
    return;
  const match =
    typeof value.fields.addr === "string" &&
    /^127\.0\.0\.1:(\d+)$/.exec(value.fields.addr);
  assert.ok(match, "Isolated Runtime advertised a non-loopback listener");
  const port = Number(match[1]);
  assert.ok(
    Number.isInteger(port) && port > 0 && port <= 65535,
    "Isolated Runtime did not advertise a bound port",
  );
  return `http://127.0.0.1:${port}`;
}
