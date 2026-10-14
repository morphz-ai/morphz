// Reproduce a header-success/body-timeout Node channel without business data.
globalThis.__fixtureNodeFetchCalls = 0;
globalThis.fetch = async () => {
  globalThis.__fixtureNodeFetchCalls++;
  const response = new Response(null, { status: 200 });
  response.json = response.text = async () => {
    throw new DOMException("Fixture response body stalled", "TimeoutError");
  };
  return response;
};
require("./production-desktop-entry.cjs");
