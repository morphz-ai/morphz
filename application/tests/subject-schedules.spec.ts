import { test, expect, type Page, type Route } from "@playwright/test";
import { disconnectedRuntime } from "../packages/core/src/conversation.js";
import {
  taskRuntimeSchema,
  type TaskRuntime,
} from "../packages/core/src/task-runtime.js";
import {
  platformTaskSchema,
  type PlatformTask,
} from "../apps/web/src/platform-client.js";
import { mockPlatformConversation } from "./platform-conversation-fixture.js";

const stamp = "2026-10-01T12:00:00.000Z";
type Run = TaskRuntime["runs"][number];

function observation(overrides: Partial<Run> = {}): TaskRuntime {
  return taskRuntimeSchema.parse({
    runs: [
      {
        run: 1,
        artifactRevision: 1,
        record: { revision: 1, status: "queued", interval_seconds: null },
        controlRevision: 1,
        threadState: null,
        ...overrides,
      },
    ],
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(page: Page) {
  const platform = await mockPlatformConversation(page, () => ({
    inputs: [],
    runtime: {
      ...disconnectedRuntime,
      configured: true,
      connected: true,
      activity: { available: true, truncated: false, threads: [] },
      attention: { available: true, approvals: [] },
    },
  }));
  function task(id: string, title: string, runRequested = 1): PlatformTask {
    return platformTaskSchema.parse({
      id,
      projectId: platform.scope.projectId,
      title,
      description: "TEST 受控传输，不创建实际事项或执行",
      assigneeId: "morphz-agent",
      execution: "planned",
      dueDate: null,
      orderRank: 0,
      revision: 1,
      updatedAt: stamp,
      createdAt: stamp,
      createdByPrincipalId: platform.client.boot.principalId,
      createdByActantId: platform.client.boot.actantId,
      headVersion: {
        taskId: id,
        revision: 1,
        projectId: platform.scope.projectId,
        title,
        description: "TEST 受控安排",
        assigneeId: "morphz-agent",
        modelId: null,
        reasoningEffort: null,
        dueDate: null,
        assignment: "agent",
        execution: "planned",
        delivery: "none",
        runRequested,
        // Mutable head fields are not proof of the admitted run's schedule.
        notBefore: null,
        everySeconds: null,
        authorPrincipalId: platform.client.boot.principalId,
        authorActantId: platform.client.boot.actantId,
        createdAt: stamp,
        resultIds: [],
        dependsOnIds: [],
        watchSourceIds: [],
      },
    });
  }
  async function routeList(handle: (route: Route) => Promise<void>) {
    await page.route(/\/api\/platform\/tasks(?:\?.*)?$/, async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("owner") === "agent" && query.get("limit") === "50")
        await handle(route);
      else await route.fallback();
    });
  }
  async function open() {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "对话", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Morphz 信息",
      exact: true,
    });
    if (!(await panel.isVisible()))
      await page
        .getByRole("button", { name: "显示右侧栏", exact: true })
        .click();
    await expect(panel).toBeVisible();
    const tabs = panel.getByRole("tablist", { name: "Morphz 信息分类" });
    await tabs.getByRole("tab", { name: "安排", exact: true }).click();
    return {
      panel,
      tabs,
      section: panel.getByRole("region", { name: "事项安排", exact: true }),
    };
  }
  return { task, routeList, open };
}

test("事项安排只查询 Agent 的有界目录，并按真实 run 排除停止、取消与终态", async ({
  page,
}) => {
  const f = await fixture(page);
  const cases: Array<[string, string, TaskRuntime]> = [
    ["queued", "TEST 已提交但当前 head 无日期", observation()],
    [
      "repeat",
      "TEST 真正重复安排",
      observation({
        record: { revision: 1, status: "dispatched", interval_seconds: 120 },
      }),
    ],
    [
      "watch",
      "TEST 真实持续关注",
      observation({
        record: { revision: 1, status: "completed", interval_seconds: null },
        hasSourceWatch: true,
      }),
    ],
    ["paused", "TEST 暂停安排", observation({ paused: true })],
    ["pending", "TEST 停止尚待确认", observation({ stopRequested: true })],
    [
      "cancelled",
      "TEST 已取消不复活",
      observation({
        record: { revision: 1, status: "cancelled", interval_seconds: 120 },
        hasSourceWatch: true,
      }),
    ],
    [
      "stopped",
      "TEST 已停止不复活",
      observation({ sourceStopped: true, hasSourceWatch: true }),
    ],
    [
      "completed",
      "TEST 已完成不是未来重复",
      observation({
        record: { revision: 1, status: "completed", interval_seconds: 120 },
      }),
    ],
    [
      "dispatched",
      "TEST 一次性已派发",
      observation({
        record: { revision: 1, status: "dispatched", interval_seconds: null },
      }),
    ],
  ];
  const tasks = cases.map(([id, title]) => f.task(id, title));
  tasks.push(f.task("not-requested", "TEST 未提交事项不是安排", 0));
  const reads: string[] = [];
  let listQuery: URLSearchParams | undefined;
  await f.routeList(async (route) => {
    listQuery = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: tasks });
  });
  await page.route(/\/api\/tasks\/[^/]+\/runtime$/, async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/")[3]!,
    );
    reads.push(id);
    const item = cases.find(([key]) => key === id);
    if (!item) throw new Error(`Unexpected task snapshot: ${id}`);
    await route.fulfill({ json: item[2] });
  });
  const { section } = await f.open();
  await expect(
    section.getByRole("button", { name: /TEST 已提交但当前 head 无日期/ }),
  ).toContainText("已排队");
  await expect(
    section.getByRole("button", { name: /TEST 真正重复安排/ }),
  ).toContainText("每 2 分钟");
  await expect(
    section.getByRole("button", { name: /TEST 真实持续关注/ }),
  ).toContainText("持续关注");
  await expect(
    section.getByRole("button", { name: /TEST 暂停安排/ }),
  ).toContainText("已暂停");
  await expect(
    section.getByRole("button", { name: /TEST 停止尚待确认/ }),
  ).toContainText("停止待确认");
  for (const [, title] of cases.slice(5))
    await expect(
      section.getByRole("button", { name: new RegExp(title) }),
    ).toHaveCount(0);
  await expect(
    section.getByText("TEST 未提交事项不是安排", { exact: true }),
  ).toHaveCount(0);
  expect(listQuery?.get("owner")).toBe("agent");
  expect(listQuery?.get("limit")).toBe("50");
  expect(reads.sort()).toEqual(cases.map(([id]) => id).sort());
});

test("事项安排读取 HTTP、Runtime 或确切 run 错误时不宣称暂无安排", async ({
  page,
}) => {
  const f = await fixture(page);
  let failure: "http" | "runtime" | "run" = "http";
  await f.routeList(async (route) => {
    if (failure === "http")
      await route.fulfill({
        status: 503,
        json: { error: "TEST 目录不可读取" },
      });
    else await route.fulfill({ json: [f.task("failed", "TEST 不可核验安排")] });
  });
  await page.route(/\/api\/tasks\/failed\/runtime$/, async (route) => {
    const runtime =
      failure === "runtime"
        ? taskRuntimeSchema.parse({ error: "TEST 执行节点不可读取", runs: [] })
        : observation({ error: "TEST 该 run 状态不可读取" });
    await route.fulfill({ json: runtime });
  });
  const { section } = await f.open();
  for (const next of ["http", "runtime", "run"] as const) {
    if (next !== "http") {
      failure = next;
      await section
        .getByRole("button", { name: "刷新事项安排", exact: true })
        .click();
    }
    await expect(section.getByRole("alert")).toBeVisible();
    await expect(
      section.getByText("暂无可确认的事项安排", { exact: true }),
    ).toHaveCount(0);
    await expect(
      section.getByRole("button", { name: /TEST 不可核验安排/ }),
    ).toHaveCount(0);
  }
});

test("有界安排最多读取 16 个已提交快照，并明确并非完整目录", async ({
  page,
}) => {
  const f = await fixture(page);
  const tasks = Array.from({ length: 50 }, (_, index) =>
    f.task(`bounded-${index}`, `TEST 安排 ${index}`),
  );
  const reads: string[] = [];
  await f.routeList((route) => route.fulfill({ json: tasks }));
  await page.route(/\/api\/tasks\/bounded-\d+\/runtime$/, async (route) => {
    reads.push(new URL(route.request().url()).pathname);
    await route.fulfill({ json: observation() });
  });
  const { section } = await f.open();
  await expect(section.locator(".subject-record")).toHaveCount(16);
  expect(reads).toHaveLength(16);
  await expect(
    section.getByText("此处为有界事项概览，请到事项查看其余工作。", {
      exact: true,
    }),
  ).toBeVisible();
});

for (const delayed of ["list", "snapshot"] as const)
  test(`同身份刷新后切页，迟到 ${delayed} 不能覆盖新安排或有界标记`, async ({
    page,
  }) => {
    const f = await fixture(page);
    const entered = deferred(),
      release = deferred(),
      delivered = deferred();
    let generation = 0;
    await f.routeList(async (route) => {
      const requestGeneration = generation;
      if (requestGeneration === 1 && delayed === "list") {
        entered.resolve();
        await release.promise;
        try {
          await route.fulfill({
            json: Array.from({ length: 50 }, (_, index) =>
              f.task(`old-${index}`, `TEST 旧安排 ${index}`),
            ),
          });
        } finally {
          delivered.resolve();
        }
      } else {
        await route.fulfill({
          json: [
            f.task(
              `generation-${requestGeneration}`,
              `TEST 第 ${requestGeneration} 代安排`,
            ),
          ],
        });
      }
    });
    await page.route(
      /\/api\/tasks\/generation-\d+\/runtime$/,
      async (route) => {
        const old = new URL(route.request().url()).pathname.includes(
          "generation-1/",
        );
        if (old && delayed === "snapshot") {
          entered.resolve();
          await release.promise;
          try {
            await route.fulfill({ json: observation() });
          } finally {
            delivered.resolve();
          }
        } else await route.fulfill({ json: observation() });
      },
    );
    const { section, tabs } = await f.open();
    await expect(
      section.getByRole("button", { name: /TEST 第 0 代安排/ }),
    ).toBeVisible();
    generation = 1;
    await section
      .getByRole("button", { name: "刷新事项安排", exact: true })
      .click();
    await entered.promise;
    await tabs.getByRole("tab", { name: "设定", exact: true }).click();
    generation = 2;
    await tabs.getByRole("tab", { name: "安排", exact: true }).click();
    await expect(
      section.getByRole("button", { name: /TEST 第 2 代安排/ }),
    ).toBeVisible();
    release.resolve();
    await delivered.promise;
    await expect(section.locator(".subject-record")).toHaveCount(1);
    await expect(
      section.getByRole("button", { name: /TEST 第 2 代安排/ }),
    ).toBeVisible();
    await expect(section.getByText(/TEST (旧安排|第 1 代安排)/)).toHaveCount(0);
    await expect(
      section.getByText("此处为有界事项概览，请到事项查看其余工作。", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      section.getByRole("button", { name: "刷新事项安排", exact: true }),
    ).toBeEnabled();
  });
