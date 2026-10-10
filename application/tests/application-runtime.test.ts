import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess, type Operation } from "../packages/core/src/model.js";
import {
  objectsApplication,
  readerApplication,
  scriptStudioApplication,
} from "../packages/core/src/applications.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";

type Ledger = {
  sessions: Record<string, unknown>;
  deliveries: {
    inputId: string;
    sessionId: string;
    state: string;
    request: {
      client_message_id: string;
      activation: {
        harness?: { id: string; version: string };
        dispatch_mode: string;
      };
    };
  }[];
};
const message = (
  projectId: string,
  application?: { id: string; version: string },
  artifactId: string | null = null,
  conversationId = projectId,
): {
  commandId: string;
  operation: Extract<Operation, { type: "record-input" }>;
} => ({
  commandId: randomUUID(),
  operation: {
    type: "record-input" as const,
    projectId,
    conversationId,
    artifactId,
    artifactRevision: artifactId ? 1 : null,
    selection: "",
    body: "工作输入",
    targetActantId: "morphz-agent",
    ...(application
      ? { application: { id: application.id, version: application.version } }
      : {}),
  },
});

test("Runtime 投递存储只有连接／关系投递，不创建旧工作空间业务", () => {
  const store = new WorkspaceStore(":memory:", { mode: "transport" });
  try {
    store.saveRuntimeState({ deliveries: [{ inputId: "input-1" }] });
    store.saveRuntimeState({ deliveries: [{ inputId: "input-1" }] });
    assert.deepEqual(store.runtimeState(), {
      deliveries: [{ inputId: "input-1" }],
    });
    assert.equal(Reflect.has(store, "snapshot"), false);
    assert.equal(Reflect.has(store, "execute"), false);
  } finally {
    store.close();
  }
});

test("剧本工作室正式入口固定编剧 Harness，冷重开不重写已排队输入", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const harness = { id: "morphz.script-studio", version: "2.0.0" };
    assert.deepEqual(scriptStudioApplication.harness, harness);
    const command = message(f.projectId, scriptStudioApplication);
    const receipt = await f.session().platformMessage(command);
    const before = f.store.runtimeState() as Ledger;
    assert.equal(before.deliveries.length, 1);
    assert.equal(before.deliveries[0]!.inputId, receipt.entityId);
    assert.equal(
      before.deliveries[0]!.request.client_message_id,
      receipt.entityId,
    );
    assert.deepEqual(before.deliveries[0]!.request.activation.harness, harness);
    assert.equal(
      before.deliveries[0]!.request.activation.dispatch_mode,
      "interrupt",
    );
    await f.reopen();
    assert.deepEqual(await f.session().platformMessage(command), receipt);
    assert.deepEqual(
      (f.store.runtimeState() as Ledger).deliveries,
      before.deliveries,
    );
    // Immutable requests for an existing Runtime protocol are retained, not
    // rebuilt from today's builtin manifest. This is protocol compatibility,
    // not an alternate Workspace or old business-authority write path.
    before.deliveries[0]!.request.activation.harness = {
      id: "morphz.script-studio",
      version: "1.0.0",
    };
    before.deliveries[0]!.state = "failed";
    f.store.saveRuntimeState(before);
    await f.reopen();
    await f.runtime.retryPlatformInput(receipt.entityId);
    before.deliveries[0]!.state = "queued";
    assert.deepEqual(
      (f.store.runtimeState() as Ledger).deliveries,
      before.deliveries,
    );
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});

test("默认对话跨项目／应用共享 Session，每个输入固定 Harness；命名 Session 独立", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const { dialogueId } = await f.session().ensurePlatformSpaces();
    const original = await f.session().createPlatformDocument({
      commandId: randomUUID(),
      projectId: f.projectId,
      title: "原件",
      markdown: "正文",
      objectId: randomUUID(),
    });
    const commands = [
      message(f.projectId, objectsApplication, original.contentId, dialogueId),
      message(f.projectId, scriptStudioApplication, null, dialogueId),
      message(f.projectId, readerApplication, null, dialogueId),
    ];
    for (const command of commands) await f.session().platformMessage(command);
    const secondProjectId = "second-project";
    await f.session().createPlatformProject({
      commandId: randomUUID(),
      projectId: secondProjectId,
      title: "另一项目",
    });
    const another = message(secondProjectId, undefined, null, dialogueId);
    await f.session().platformMessage(another);
    const before = f.store.runtimeState() as Ledger;
    assert.equal(Object.keys(before.sessions).length, 1);
    assert.equal(new Set(before.deliveries.map((d) => d.sessionId)).size, 1);
    assert.deepEqual(
      before.deliveries.slice(0, 3).map((d) => d.request.activation.harness),
      [
        objectsApplication.harness ?? undefined,
        scriptStudioApplication.harness,
        readerApplication.harness ?? undefined,
      ],
    );
    assert.ok(
      before.deliveries.every(
        (d) => d.request.activation.dispatch_mode === "interrupt",
      ),
    );
    await f.reopen();
    const continued = await f
      .session()
      .platformMessage(message(f.projectId, undefined, null, dialogueId));
    const namedId = randomUUID();
    const named = message(f.projectId);
    named.operation.conversationId = namedId;
    named.operation.newConversation = { title: "独立工作线" };
    const namedReceipt = await f.session(localAccess).platformMessage(named);
    const after = f.store.runtimeState() as Ledger;
    assert.equal(
      after.deliveries.find((d) => d.inputId === continued.entityId)!.sessionId,
      before.deliveries[0]!.sessionId,
    );
    assert.notEqual(
      after.deliveries.find((d) => d.inputId === namedReceipt.entityId)!
        .sessionId,
      before.deliveries[0]!.sessionId,
    );
    assert.deepEqual(after.deliveries.slice(0, 4), before.deliveries);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
