import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";

/** Node-side fixture setup must not borrow an idle socket from another test.
 * Keep the real client, authorization, commands and errors; no automatic retry
 * or browser transport override. The origin is only the isolated test server. */
export function httpFixtureClient(request: typeof fetch = globalThis.fetch) {
  return new HttpApplicationClient("http://127.0.0.1:65421", (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("connection", "close");
    return request(input, { ...init, headers });
  });
}
