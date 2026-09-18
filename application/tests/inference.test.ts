import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { RuntimeBridge } from "../apps/service/src/runtime.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess, commandSchema } from "../packages/core/src/model.js";
import { workInputRequest } from "../apps/service/src/session-io.js";
import { modelLabel } from "../packages/core/src/inference.js";

test("模型来源只公开名称；强度按模型能力校验，默认不伪造限制", async () => {
  const server = createServer((request, response) => {
    const inference = {
      model: "primary",
      reasoning_effort: "low",
      model_options: [
        {
          id: "primary",
          label: "主用",
          physical_models: ["same-model"],
          supported_reasoning_efforts: ["low", "high"],
          secret: "never-forward",
        },
        {
          id: "backup",
          label: "备用",
          physical_models: ["same-model"],
          supported_reasoning_efforts: [],
        },
        {
          id: "unknown",
          label: "能力未声明",
          supported_reasoning_efforts: null,
        },
      ],
    };
    const providers = {
      provider_instances: {
        vendor: {
          accounts: ["key-a", "disabled"],
          base_url: "https://private.invalid",
          headers: { Authorization: "secret-header" },
        },
      },
      auth_accounts: {
        "key-a": {
          config: { label: "工作 Key", credential_ref: "private-secret-ref" },
          effective_enabled: true,
          oauth: false,
          authenticated: false,
        },
        "key-b": {
          config: { label: "备用 Key" },
          effective_enabled: true,
          oauth: false,
          authenticated: false,
        },
        disabled: {
          config: { label: "停用 Key" },
          effective_enabled: false,
          oauth: false,
          authenticated: false,
        },
      },
      model_routes: {
        primary: {
          candidates: [
            { provider: "vendor", account: null },
            { provider: "vendor", account: "key-a" },
          ],
        },
        backup: { candidates: [{ provider: "vendor", account: "key-b" }] },
      },
    };
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.endsWith("/providers") ? providers : inference,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new WorkspaceStore(":memory:");
  const bridge = new RuntimeBridge(store, {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "test",
    namespace: randomUUID(),
  });
  try {
    const catalog = await bridge.models();
    assert.deepEqual(catalog.options[0]!.sources, ["工作 Key"]);
    assert.equal(
      modelLabel(catalog.options[1]!),
      "same-model · 备用 · 备用 Key",
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /never-forward|private-secret|secret-header|private.invalid|停用 Key/,
    );
    await bridge.validateInference("primary", "high");
    await bridge.validateInference(undefined, "low");
    await bridge.validateInference("unknown", "medium");
    await assert.rejects(
      () => bridge.validateInference("primary", "max"),
      /不支持此推理强度/,
    );
    await assert.rejects(
      () => bridge.validateInference("backup", "low"),
      /不支持此推理强度/,
    );
    await assert.rejects(
      () => bridge.validateInference("invented", "low"),
      /模型当前不可用/,
    );
  } finally {
    await bridge.stop();
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("推理强度独立于正文持久化，每次输入固定；默认和旧输入不额外绑定", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const operation = {
      type: "record-input" as const,
      projectId: "first-project",
      artifactId: null,
      artifactRevision: null,
      selection: "",
      body: "本次设置验收",
      targetActantId: "morphz-agent",
    };
    assert.equal(
      commandSchema.safeParse({
        commandId: randomUUID(),
        operation: { ...operation, reasoningEffort: "invented" },
      }).success,
      false,
    );
    for (const reasoningEffort of ["high", undefined] as const) {
      const receipt = store.execute(
        {
          commandId: randomUUID(),
          operation: {
            ...operation,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          },
        },
        localAccess,
      );
      const input = store
        .snapshot()
        .inputs.find((i) => i.id === receipt.entityId)!;
      assert.equal(input.reasoningEffort, reasoningEffort);
      const request = workInputRequest(input);
      assert.equal(request.activation.reasoning_effort, reasoningEffort);
      assert.equal("reasoning_effort" in request.activation, !!reasoningEffort);
      assert.equal("reasoningEffort" in request.message.content.value, false);
    }
  } finally {
    store.close();
  }
});
