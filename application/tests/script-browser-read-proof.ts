import type { Page } from "@playwright/test";

export function isScriptSnapshotEndpoint(url: string) {
  return /^\/api\/platform\/scripts\/[^/]+\/snapshot$/.test(
    new URL(url).pathname,
  );
}

/** Observe the actual browser transport, not Node fixture inspection reads. */
export function observeScriptSnapshotReads(page: Page) {
  const reads = { requests: [] as string[], responses: [] as string[] };
  page.on("request", (request) => {
    if (isScriptSnapshotEndpoint(request.url()))
      reads.requests.push(request.url());
  });
  page.on("response", (response) => {
    if (isScriptSnapshotEndpoint(response.url()))
      reads.responses.push(response.url());
  });
  return reads;
}
