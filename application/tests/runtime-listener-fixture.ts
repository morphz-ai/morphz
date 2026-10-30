import assert from "node:assert/strict";

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
