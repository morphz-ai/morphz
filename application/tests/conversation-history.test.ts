import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  createConversationHistory,
  readHistoryHead,
  type CachedHistory,
  type HistoryScope,
} from "../apps/web/src/data/conversation-history.js";
import type {
  HistoryCursor,
  PlatformHistory,
} from "../apps/web/src/platform-client.js";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  baselineHistoryHead,
  createBaselineHistory,
  type BaselinePorts,
} from "./fixtures/conversation-history-9ea571d0.js";

const scope = { projectId: "project-A", conversationId: "conversation-A" };
const other = { projectId: "project-B", conversationId: "conversation-B" };
const cursor = (id: string): HistoryCursor => ({
  createdAt: "2026-10-04T00:00:00.000Z",
  id,
});
function history(id?: string, before: string | null = null): PlatformHistory {
  return {
    inputs: id
      ? [
          {
            id,
            ...scope,
            author: { principalId: "human", actantId: "actor" },
            targetActantId: "agent",
            body: `原文 ${id}`,
            createdAt: "2026-10-04T00:00:00.000Z",
          },
        ]
      : [],
    runtime: disconnectedRuntime,
    scriptOutputs: [],
    nextCursor: before === null ? null : cursor(before),
  };
}
function reply(id: string): PlatformHistory["runtime"]["messages"][number] {
  return {
    id,
    ...scope,
    text: `回复 ${id}`,
    kind: "reply",
    artifactId: null,
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}
function review(reviewId: string): PlatformHistory["scriptOutputs"][number] {
  return {
    commandId: "shared-review-command",
    inputId: "input",
    ...scope,
    productionId: "production",
    kind: "review",
    reviewId,
    title: "剧本审阅",
    productionTitle: "剧本",
    revision: 1,
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Owner = ReturnType<typeof createConversationHistory>;
type Fixture = ReturnType<typeof fixture>;
function fixture(factory: (ports: BaselinePorts) => Owner) {
  const events: unknown[][] = [];
  const seed = history("current", "z");
  let identity: string | undefined = "identity-A";
  let connected = true;
  let pending: Promise<boolean> | null = null;
  let pageRead: NonNullable<
    ReturnType<BaselinePorts["connection"]>
  >["readPage"] = async () => history("older");
  let projectRefresh: () => Promise<boolean> = async () => true;
  const signals = new Map<AbortSignal, number>();
  const timeouts = mock.method(
    AbortSignal,
    "timeout",
    (milliseconds: number) => {
      const signal = new AbortController().signal;
      signals.set(signal, signals.size + 1);
      events.push(["budget", milliseconds, signals.size]);
      return signal;
    },
  );
  const owner = factory({
    connection: () =>
      connected
        ? {
            identityGeneration: "identity-A",
            readPage: async (captured, before, signal) => {
              events.push([
                "read",
                captured,
                before,
                signal ? signals.get(signal) : null,
              ]);
              return pageRead(captured, before, signal);
            },
          }
        : undefined,
    currentIdentity: () => identity,
    pendingRefresh: () => pending,
    refreshProjection: () => {
      events.push(["refresh", owner.captureSelection(), owner.olderCursor]);
      return projectRefresh();
    },
    invalidateProjectionReuse: () => events.push(["invalidate"]),
  });
  // Constructing the owner must not issue a query or start any timer.
  assert.deepEqual(events, []);
  owner.commitProjection(scope, seed, "version-A", 1);
  return {
    owner,
    events,
    seed,
    signals,
    page: (reader: typeof pageRead) => {
      pageRead = reader;
    },
    identity: (next: string | undefined) => {
      identity = next;
    },
    connected: (next: boolean) => {
      connected = next;
    },
    pending: (next: Promise<boolean> | null) => {
      pending = next;
    },
    refresh: (next: typeof projectRefresh) => {
      projectRefresh = next;
    },
    finish: () => timeouts.mock.restore(),
    snapshot: () => ({
      events,
      selection: owner.captureSelection(),
      cache: owner.cachedForCatalog(1),
      cursor: owner.olderCursor,
    }),
  };
}
async function compare(run: (f: Fixture) => Promise<unknown>) {
  const outcomes: unknown[] = [];
  for (const factory of [createBaselineHistory, createConversationHistory]) {
    const f = fixture(factory);
    try {
      outcomes.push({ result: await run(f), ...f.snapshot() });
    } finally {
      f.finish();
    }
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
  return outcomes[1];
}
const ticks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const failure = async (action: Promise<unknown>) => {
  try {
    await action;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

test("fixed original oracle: selection keeps raw reference, short-circuits equal scope, waits refresh before new refresh", async () => {
  await compare(async (f) => {
    assert.equal(f.owner.captureSelection(), scope);
    assert.equal(f.owner.cachedForCatalog(1)?.value, f.seed);
    assert.equal(f.owner.cachedForCatalog(2), undefined);
    await f.owner.selectScope({ ...scope });
    assert.equal(f.owner.captureSelection(), scope);
    assert.deepEqual(f.events, []);
    const pending = deferred<boolean>();
    f.pending(pending.promise);
    const selected = f.owner.selectScope(other);
    assert.equal(f.owner.captureSelection(), other);
    assert.equal(f.owner.isSelectionCurrent({ ...other }), false);
    assert.equal(f.owner.isSelectionCurrent(other), true);
    await ticks();
    assert.deepEqual(f.events, []);
    pending.resolve(true);
    await selected;
    return "selected";
  });
});

test("fixed original oracle: earlier waits refresh before capturing cache; overlapping callers join one paging slot", async () => {
  await compare(async (f) => {
    const pending = deferred<boolean>();
    const page = deferred<PlatformHistory>();
    f.pending(pending.promise);
    f.page(() => page.promise);
    const first = f.owner.loadEarlier();
    const second = f.owner.loadEarlier();
    await ticks();
    assert.deepEqual(f.events, []);
    const updated = history("updated", "y");
    f.owner.commitProjection(scope, updated, "version-B", 1);
    pending.resolve(true);
    await ticks();
    assert.equal(f.events.filter((e) => e[0] === "read").length, 1);
    assert.deepEqual(f.events.find((e) => e[0] === "read")?.[2], cursor("y"));
    page.resolve(history("older"));
    await Promise.all([first, second]);
    return f.owner.cachedForCatalog(1)?.value.inputs.map((i) => i.id);
  });
});

test("fixed original oracle: four invisible windows share one 15s budget; fifth is not read", async () => {
  await compare(async (f) => {
    let page = 0;
    f.page(async () => history(undefined, String(9 - page++)));
    await f.owner.loadEarlier();
    assert.equal(page, 4);
    assert.equal(f.signals.size, 1);
    assert.deepEqual(f.owner.olderCursor, cursor("6"));
    return page;
  });
});

test("fixed original oracle: any visible input/message ends earlier paging; script-only output does not", async () => {
  for (const visible of ["input", "message", "script"] as const) {
    await compare(async (f) => {
      let page = 0;
      f.page(async () => {
        page++;
        if (visible === "input") return history("older", "y");
        const value = history(undefined, String(9 - page));
        if (visible === "message")
          value.runtime = {
            ...disconnectedRuntime,
            messages: [
              {
                id: "reply",
                ...scope,
                text: "回复",
                kind: "reply",
                artifactId: null,
                createdAt: "2026-10-04T00:00:00.000Z",
              },
            ],
          };
        else
          value.scriptOutputs = [
            {
              commandId: "script-command",
              inputId: "input",
              ...scope,
              productionId: "production",
              kind: "production",
              title: "剧本",
              productionTitle: "剧本",
              revision: 1,
              createdAt: "2026-10-04T00:00:00.000Z",
            },
          ];
        return value;
      });
      await f.owner.loadEarlier();
      assert.equal(page, visible === "script" ? 4 : 1);
      return page;
    });
  }
});

test("fixed original oracle: exact source jump does not wait workspace refresh; uses independent 15s page budgets", async () => {
  await compare(async (f) => {
    f.pending(new Promise<boolean>(() => {}));
    let page = 0;
    f.page(async () =>
      ++page === 1 ? history(undefined, "y") : history("wanted"),
    );
    assert.equal(await f.owner.loadUntil("wanted"), true);
    assert.equal(page, 2);
    assert.equal(f.signals.size, 2);
    return page;
  });
});

test("fixed original oracle: exact cached input/reply uses no read or refresh; exhausted history returns false", async () => {
  await compare(async (f) => {
    assert.equal(await f.owner.loadUntil("current"), true);
    const withReply = {
      ...f.seed,
      runtime: { ...disconnectedRuntime, messages: [reply("cached-reply")] },
    };
    f.owner.commitProjection(scope, withReply, "v", 1);
    assert.equal(await f.owner.loadUntil("cached-reply"), true);
    assert.deepEqual(f.events, []);
    f.page(async () => history("not-wanted"));
    assert.equal(await f.owner.loadUntil("missing"), false);
    return false;
  });
});

test("fixed original oracle: rejected pending refresh prevents select/earlier from issuing a new request; false refresh does not undo a commit", async () => {
  for (const action of ["select", "earlier"] as const) {
    await compare(async (f) => {
      const pending = deferred<boolean>();
      f.pending(pending.promise);
      const operation =
        action === "select"
          ? f.owner.selectScope(other)
          : f.owner.loadEarlier();
      const rejected = failure(operation);
      pending.reject(new Error("pending refresh failed"));
      assert.equal(await rejected, "pending refresh failed");
      assert.deepEqual(f.events, []);
      assert.equal(
        f.owner.captureSelection(),
        action === "select" ? other : scope,
      );
      return action;
    });
  }
  await compare(async (f) => {
    f.refresh(async () => false);
    await f.owner.loadEarlier();
    assert.deepEqual(
      f.owner.cachedForCatalog(1)?.value.inputs.map((input) => input.id),
      ["current", "older"],
    );
    return false;
  });
});

test("fixed original oracle: exact source jump commits 200 pages before reporting still-earlier bound", async () => {
  await compare(async (f) => {
    f.owner.commitProjection(scope, history("current", "999"), "v", 1);
    let page = 0;
    f.page(async () => history(undefined, String(998 - page++)));
    const error = await failure(f.owner.loadUntil("missing"));
    assert.equal(page, 200);
    assert.equal(f.signals.size, 200);
    assert.equal(
      error,
      "引用仍在更早的记录中；已加载旧消息，请再点一次查看原文。",
    );
    assert.deepEqual(f.events.at(-2), ["invalidate"]);
    assert.equal(f.events.at(-1)?.[0], "refresh");
    assert.deepEqual(f.owner.olderCursor, cursor("799"));
    return error;
  });
});

test("fixed original oracle: nonprogressing time/id cursor fails before stale guard, with no partial commit", async () => {
  for (const mode of ["earlier", "until"] as const) {
    for (const next of [
      cursor("z"),
      cursor("zz"),
      { ...cursor("a"), createdAt: "2026-10-05T00:00:00.000Z" },
    ]) {
      await compare(async (f) => {
        f.page(async () => {
          f.identity("identity-B");
          return { ...history("older"), nextCursor: next };
        });
        const error = await failure(
          mode === "earlier"
            ? f.owner.loadEarlier()
            : f.owner.loadUntil("wanted"),
        );
        assert.equal(error, "历史分页位置没有前进，请重试。");
        assert.equal(f.owner.cachedForCatalog(1)?.value, f.seed);
        return error;
      });
    }
  }
});

test("fixed original oracle: identity/scope/cache/clear invalidate late pages; earlier silent versus exact source error", async () => {
  for (const invalidation of ["identity", "scope", "cache", "clear"] as const) {
    for (const mode of ["earlier", "until"] as const) {
      await compare(async (f) => {
        const page = deferred<PlatformHistory>();
        f.page(() => page.promise);
        const action =
          mode === "earlier"
            ? f.owner.loadEarlier()
            : f.owner.loadUntil("wanted");
        await ticks();
        if (invalidation === "identity") f.identity("identity-B");
        if (invalidation === "scope") await f.owner.selectScope(other);
        if (invalidation === "cache")
          f.owner.commitProjection(scope, f.seed, "version-B", 1);
        if (invalidation === "clear") f.owner.clear();
        assert.equal([...f.signals.keys()][0]?.aborted, false);
        page.resolve(history("wanted"));
        const error = await failure(action);
        assert.equal(
          error,
          mode === "until" ? "对话已切换或更新，请重新打开引用。" : null,
        );
        return error;
      });
    }
  }
});

test("fixed original oracle: clear retains pending join until finally; restoring an identical cache does not revive old response", async () => {
  await compare(async (f) => {
    const page = deferred<PlatformHistory>();
    f.page(() => page.promise);
    const first = f.owner.loadEarlier();
    await ticks();
    f.owner.clear();
    f.owner.commitProjection(scope, f.seed, "version-A", 1);
    const joined = f.owner.loadEarlier();
    const exact = f.owner.loadUntil("current");
    await ticks();
    assert.equal(f.events.filter((e) => e[0] === "read").length, 1);
    page.resolve(history("older"));
    await Promise.all([first, joined]);
    assert.equal(await exact, true);
    f.page(async () => history("newer-old"));
    await f.owner.loadEarlier();
    assert.equal(f.events.filter((e) => e[0] === "read").length, 2);
    return "finally-released";
  });
});

test("fixed original oracle: two source jumps waiting on the same earlier request retain original concurrent resume and stale rejection", async () => {
  await compare(async (f) => {
    const earlier = deferred<PlatformHistory>();
    const firstPage = deferred<PlatformHistory>();
    const secondPage = deferred<PlatformHistory>();
    let reads = 0;
    f.page(() => {
      reads++;
      return reads === 1
        ? earlier.promise
        : reads === 2
          ? firstPage.promise
          : secondPage.promise;
    });
    const initial = f.owner.loadEarlier();
    const first = f.owner.loadUntil("first");
    const second = f.owner.loadUntil("second");
    // Attach rejection handling before deliberately retiring its cache.
    const rejected = failure(second);
    await ticks();
    assert.equal(reads, 1);
    earlier.resolve(history("older", "y"));
    await initial;
    await ticks();
    assert.equal(reads, 3);
    firstPage.resolve(history("first"));
    assert.equal(await first, true);
    secondPage.resolve(history("second"));
    assert.equal(await rejected, "对话已切换或更新，请重新打开引用。");
    return reads;
  });
});

test("fixed original oracle: refresh commits the page before its captured pending clears, and later paging uses the confirmed head", async () => {
  await compare(async (f) => {
    const confirmation = deferred<boolean>();
    f.refresh(() => {
      const committed = f.owner.cachedForCatalog(1)!;
      assert.deepEqual(
        committed.value.inputs.map((i) => i.id),
        ["current", "older"],
      );
      f.owner.commitProjection(
        scope,
        history("confirmed", "x"),
        "v-confirmed",
        1,
      );
      return confirmation.promise;
    });
    const first = f.owner.loadEarlier();
    await ticks();
    const joined = f.owner.loadEarlier();
    await ticks();
    assert.equal(f.events.filter((e) => e[0] === "read").length, 1);
    confirmation.resolve(true);
    await Promise.all([first, joined]);
    f.refresh(async () => true);
    await f.owner.loadEarlier();
    assert.deepEqual(
      f.events.filter((e) => e[0] === "read").at(-1)?.[2],
      cursor("x"),
    );
    return f.owner.cachedForCatalog(1)?.value.inputs.map((i) => i.id);
  });
});

test("fixed original oracle: page/refresh failure preserves original commit and releases paging slot", async () => {
  for (const failAt of ["page", "refresh"] as const) {
    await compare(async (f) => {
      f.page(async () => {
        if (failAt === "page") throw new Error("page failed");
        return history("older");
      });
      f.refresh(async () => {
        throw new Error("refresh failed");
      });
      assert.equal(await failure(f.owner.loadEarlier()), `${failAt} failed`);
      assert.equal(
        f.owner.cachedForCatalog(1)?.value === f.seed,
        failAt === "page",
      );
      f.refresh(async () => true);
      f.page(async () => history("older"));
      if (failAt === "refresh") f.owner.commitProjection(scope, f.seed, "v", 1);
      await f.owner.loadEarlier();
      return failAt;
    });
  }
});

test("fixed original oracle: no connection/cursor/cache does not read; empty version cannot install cache", async () => {
  await compare(async (f) => {
    f.connected(false);
    await f.owner.loadEarlier();
    assert.equal(await f.owner.loadUntil("missing"), false);
    f.connected(true);
    f.owner.commitProjection(scope, history("current"), "v", 1);
    await f.owner.loadEarlier();
    f.owner.commitProjection(scope, f.seed, "", 1);
    assert.equal(f.owner.cachedForCatalog(1), undefined);
    assert.equal(await f.owner.loadUntil("current"), false);
    assert.deepEqual(f.events, []);
    return false;
  });
});

async function productionHead(
  readPage: NonNullable<ReturnType<BaselinePorts["connection"]>>["readPage"],
  selected: HistoryScope,
  version: string | undefined,
  cached: CachedHistory | undefined,
  signal: AbortSignal | undefined,
  composed: (value: PlatformHistory) => void,
) {
  const head = readHistoryHead(readPage, selected, version, cached, signal);
  const value = head.kind === "cached" ? head.value : await head.pending;
  composed(value);
  return value;
}

test("fixed original head oracle: cache hit is same raw object and composes before next microtask; miss preserves await ordering", async () => {
  for (const hit of [true, false]) {
    const traces: unknown[] = [];
    for (const readHead of [baselineHistoryHead, productionHead]) {
      const events: string[] = [];
      const value = history("current", "z");
      const cached = { scope, version: "v", value };
      const pending = readHead(
        async () => {
          events.push("read");
          return value;
        },
        scope,
        hit ? "v" : "changed",
        cached,
        undefined,
        (composed) => {
          assert.equal(composed === value, hit);
          events.push("compose");
        },
      );
      events.push("called");
      queueMicrotask(() => events.push("sentinel"));
      const result = await pending;
      await ticks();
      traces.push({ events, result });
      if (hit) assert.deepEqual(events, ["compose", "called", "sentinel"]);
    }
    assert.deepEqual(traces[1], traces[0]);
  }
});

test("fixed original head oracle: scope/version/overlap/delivery quality decide reuse, not script-output coincidence", async () => {
  for (const variant of [
    "same",
    "different-scope",
    "overlap",
    "no-overlap",
    "message-overlap",
    "script-only-coincidence",
    "queued",
    "sending",
    "running",
    "completed",
  ] as const) {
    const outcomes: unknown[] = [];
    for (const readHead of [baselineHistoryHead, productionHead]) {
      const cachedValue = history("retained", "z");
      const latest = history(
        ["no-overlap", "message-overlap", "script-only-coincidence"].includes(
          variant,
        )
          ? "different"
          : "retained",
        "y",
      );
      if (variant === "message-overlap") {
        cachedValue.runtime = {
          ...disconnectedRuntime,
          messages: [reply("same-reply")],
        };
        latest.runtime = {
          ...disconnectedRuntime,
          messages: [{ ...reply("same-reply"), text: "最新确切正文" }],
        };
      }
      if (variant === "script-only-coincidence") {
        cachedValue.scriptOutputs = [review("same-review")];
        latest.scriptOutputs = [review("same-review")];
      }
      if (["queued", "sending", "running", "completed"].includes(variant))
        cachedValue.runtime = {
          ...disconnectedRuntime,
          deliveries: [
            {
              inputId: "retained",
              state: variant as "queued" | "sending" | "running" | "completed",
              error: null,
              retryable: false,
            },
          ],
        };
      let reads = 0;
      const value = await readHead(
        async () => {
          reads++;
          return latest;
        },
        scope,
        variant === "same" ? "v" : "changed",
        {
          scope: variant === "different-scope" ? other : scope,
          version: "v",
          value: cachedValue,
        },
        undefined,
        () => {},
      );
      assert.equal(reads, variant === "same" ? 0 : 1);
      assert.equal(value === cachedValue, variant === "same");
      assert.equal(
        value === latest,
        [
          "different-scope",
          "no-overlap",
          "script-only-coincidence",
          "queued",
          "sending",
          "running",
        ].includes(variant),
      );
      outcomes.push({ reads, value });
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
  }
});

test("fixed original head oracle: head signal is forwarded verbatim and script-output identity retains distinct reviews from one command", async () => {
  const outcomes: unknown[] = [];
  for (const readHead of [baselineHistoryHead, productionHead]) {
    const signal = new AbortController().signal;
    const cachedValue = history("retained", "z");
    cachedValue.scriptOutputs = [review("review-A"), review("review-B")];
    const latest = history("retained", "y");
    latest.scriptOutputs = [review("review-B")];
    let reads = 0;
    const value = await readHead(
      async (captured, before, actualSignal) => {
        reads++;
        // The old Platform method takes the two string IDs, so the oracle
        // adapter reconstructs this tuple; only its values have identity here.
        assert.deepEqual(captured, scope);
        assert.equal(before, undefined);
        assert.equal(actualSignal, signal);
        return latest;
      },
      scope,
      "changed",
      { scope, version: "v", value: cachedValue },
      signal,
      () => {},
    );
    assert.equal(reads, 1);
    assert.deepEqual(
      value.scriptOutputs.map((output) => output.reviewId),
      ["review-A", "review-B"],
    );
    assert.equal(value.nextCursor, cachedValue.nextCursor);
    outcomes.push(value);
  }
  assert.deepEqual(outcomes[1], outcomes[0]);
});
