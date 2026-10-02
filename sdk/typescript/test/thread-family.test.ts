import assert from "node:assert/strict";
import test from "node:test";
import { MorphzClient, MorphzHttpError } from "../src/index.ts";
import type {
  MorphzPrincipal,
  ThreadFamily,
  ThreadFamilyMember,
} from "../src/index.ts";

const member: ThreadFamilyMember = {
  id: "thread/one ?#% 主",
  session_id: "session/one ?#% 主",
  context_id: "context-one",
  root_turn_id: "root-one",
  parent_thread_id: "ancestor-outside-selected-family",
  revision: 8,
  generation: 2,
};
const family: ThreadFamily = {
  session_id: member.session_id,
  context_id: member.context_id,
  selected_thread_id: member.id,
  generated_at: "2026-10-03T00:00:00Z",
  threads: [
    member,
    {
      ...member,
      id: "thread-child",
      root_turn_id: "distinct-child-root",
      parent_thread_id: member.id,
      revision: 1,
      generation: 0,
    },
  ],
  limit: 64,
  has_more: false,
};

test("Session family GET escapes exact IDs and separates Principal and service authentication from query/body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MorphzClient({
    baseUrl: "https://runtime.example/",
    serviceToken: "synthetic-gateway",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(family);
    },
  });
  const actual = await client.sessionThreadFamily(
    { id: "human/@one", displayName: "Alice" },
    member.session_id,
    member.id,
  );
  assert.deepEqual(actual, family);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  const parsed = new URL(url);
  assert.equal(
    parsed.pathname,
    `/api/sessions/${encodeURIComponent(member.session_id)}/threads/${encodeURIComponent(member.id)}/family`,
  );
  assert.deepEqual([...parsed.searchParams], [["limit", "64"]]);
  assert.equal(init?.method, "GET");
  assert.equal(init?.body, undefined);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-gateway");
  assert.equal(headers.get("x-morphz-principal"), "human/@one");
  assert.equal(headers.get("x-morphz-principal-name"), "Alice");
  assert.equal(headers.get("content-type"), null);
});

test("family limits include the selected Thread and preserve exact truncation and descendant roots", async () => {
  const calls: string[] = [];
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    fetch: async (url) => {
      calls.push(String(url));
      const limit = Number(new URL(String(url)).searchParams.get("limit"));
      return Response.json({
        ...family,
        threads: family.threads.slice(0, limit),
        limit,
        has_more: limit === 1,
      } satisfies ThreadFamily);
    },
  });
  for (const limit of [1, 2, 64]) {
    const result = await client.sessionThreadFamily(
      { id: "human-one" },
      member.session_id,
      member.id,
      limit,
    );
    assert.equal(result.limit, limit);
    assert.equal(result.has_more, limit === 1);
    assert.equal(result.threads.length, limit === 1 ? 1 : 2);
    assert.equal(result.threads[0]?.parent_thread_id, member.parent_thread_id);
    if (limit > 1)
      assert.equal(result.threads[1]?.root_turn_id, "distinct-child-root");
  }
  assert.equal(calls.length, 3, "One exact GET per explicit read, no polling");
});

test("invalid family arguments fail locally without requesting Runtime state", () => {
  let requests = 0;
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    serviceToken: "synthetic-operator",
    fetch: async () => {
      requests++;
      return Response.json(family);
    },
  });
  for (const limit of [
    0,
    -1,
    65,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
    null,
  ])
    assert.throws(
      () =>
        client.sessionThreadFamily(
          { id: "human-one" },
          "session-one",
          "thread-one",
          limit as number,
        ),
      RangeError,
    );
  assert.throws(
    () => client.sessionThreadFamily({ id: "" }, "session-one", "thread-one"),
    /principal\.id is required/,
  );
  for (const principal of [undefined, null])
    assert.throws(
      () =>
        client.sessionThreadFamily(
          principal as unknown as MorphzPrincipal,
          "session-one",
          "thread-one",
        ),
      /principal\.id is required/,
    );
  assert.throws(
    () => client.sessionThreadFamily({ id: "human-one" }, "", "thread-one"),
    /sessionId is required/,
  );
  assert.throws(
    () => client.sessionThreadFamily({ id: "human-one" }, "session-one", ""),
    /threadId is required/,
  );
  assert.equal(requests, 0);
});

test("family HTTP and transport errors propagate without retry, Context inventory fallback or writes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let responseStatus = 403;
  const client = new MorphzClient({
    baseUrl: "https://runtime.example",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        {
          error: { code: "family-error", message: "synthetic family failure" },
        },
        { status: responseStatus },
      );
    },
  });
  for (const status of [401, 403, 404, 409, 500]) {
    responseStatus = status;
    const before = calls.length;
    await assert.rejects(
      () =>
        client.sessionThreadFamily(
          { id: "human-one" },
          "session-one",
          "thread-one",
        ),
      (error: unknown) =>
        error instanceof MorphzHttpError &&
        error.status === status &&
        error.code === "family-error" &&
        error.message === "synthetic family failure",
    );
    assert.equal(calls.length, before + 1);
  }
  for (const call of calls) {
    assert.match(
      call.url,
      /\/api\/sessions\/session-one\/threads\/thread-one\/family\?limit=64$/,
    );
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.body, undefined);
  }
  const failure = new Error("synthetic transport failure");
  let transportRequests = 0;
  const failedClient = new MorphzClient({
    baseUrl: "https://runtime.example",
    fetch: async () => {
      transportRequests++;
      throw failure;
    },
  });
  await assert.rejects(
    () =>
      failedClient.sessionThreadFamily(
        { id: "human-one" },
        "session-one",
        "thread-one",
      ),
    (error: unknown) => error === failure,
  );
  assert.equal(transportRequests, 1);
});
