import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { workInputRequest } from "../packages/application/src/session-io.js";
import { receivedWorkflowText } from "../scripts/script-studio-quality-evidence.js";

test("真实素材读取证据解码 JSON 后比较原文，不把换行转义误判为未读取", () => {
  const text = '原文第一行\n第二行："铜钥匙"，不是模型回显。';
  const receipt = {
    tool_name: "host_morphz",
    text: JSON.stringify({
      ok: true,
      generating: true,
      materials: [{ draft: { text }, sources: [{ text }] }],
    }),
  };
  assert.equal(receivedWorkflowText([receipt], text, "source"), true);
  assert.equal(receivedWorkflowText([receipt], text, "draft"), true);
  assert.equal(receivedWorkflowText([receipt], "未读取内容", "source"), false);
  assert.equal(
    receivedWorkflowText([{ ...receipt, tool_name: "eval" }], text, "source"),
    false,
  );
  assert.equal(
    receivedWorkflowText(
      [{ tool_name: "host_morphz", text: JSON.stringify({ ok: false, text }) }],
      text,
      "source",
    ),
    false,
  );
  assert.equal(
    receivedWorkflowText([{ tool_name: "host_morphz", text }], text, "draft"),
    false,
  );
});

// Packaging and routing checks only. They do not score creative output.
test("编剧包按新版本发布，1.0.0 字节不变；方法与业务权限分层", () => {
  const legacy = readFileSync(
    new URL("../harnesses/legacy/script-studio-1.0.0.hns", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(legacy).digest("hex"),
    "a5fc917bd20284b037a2efb9cfea7918489c3f9d1f4655cd2f7b855ed2982941",
  );
  const source = readFileSync(
    new URL("../harnesses/script-studio.hns", import.meta.url),
    "utf8",
  );
  const previous = readFileSync(
    new URL("../harnesses/legacy/script-studio-1.1.0.hns", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(previous).digest("hex"),
    "48d0c235f3f351212e5d93f64751be6264539ef794c13323d7c1968d9697d392",
  );
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../harnesses/legacy/script-studio-1.1.1.hns",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
    "587794b6d26d4bc65fb87c29b1d250a2349a3de6b6dd2ed916a347808d709a31",
  );
  assert.deepEqual(scriptStudioApplication.harness, {
    id: "morphz.script-studio",
    version: "1.4.0",
  });
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../harnesses/legacy/script-studio-1.2.0.hns",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
    "a224fc7eac41d991bad8eefa7ecccf8964c7aaf6715c510b6b3e01557b7cc12a",
  );
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../harnesses/legacy/script-studio-1.2.1.hns",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
    "31118476c3dedef7c95a18d2b1545b9c8ed749f7fca113e1258fe8c941246aaa",
  );
  assert.match(source, /\(version "1\.4\.0"\)/);
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../harnesses/legacy/script-studio-1.3.0.hns",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
    "f7d45bbd4d59dde42e3b0ffa686cde4d5f728d0a11311fd1810a54b76b4dae89",
  );
  for (const type of ["ScriptIntent", "ScriptProduct", "ScriptCheck"])
    assert.ok(source.includes(`(returns ${type})`));
  assert.ok(!source.includes("(produces "));
  assert.ok(!source.includes("(decode Json"));
  assert.ok(!source.includes("(fn script-product"));
  assert.match(source, /\(capabilities \(tools host_morphz\)\)/);
  assert.equal((source.match(/^\(eval/gm) ?? []).length, 1);
  assert.equal((source.match(/^\(mind/gm) ?? []).length, 1);
  for (const method of [
    "brief-and-evidence",
    "story-design",
    "deliverable-by-kind",
    "character-and-voice",
    "scene-and-screen",
    "serial-and-format",
    "adaptation",
    "targeted-rewrite",
    "continuity-and-impact",
    "quality-and-handoff",
  ])
    assert.ok(source.includes(`(id script-studio/${method})`), method);
  for (const action of ["read-source", "read-results", "read-result"])
    assert.ok(source.includes(`script/${action}`));
  assert.ok(source.includes("maxReviewPasses=0"));
  assert.ok(source.includes("review-before-submit"));
  assert.ok(source.includes("不把结构通过、模型自评或来源方法论称为专业认证"));
});

test("新输入绑定 1.4.0；历史输入及未知回执重试使用原 Harness，不替换版本", () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const instanceId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "launch-application",
          workspaceId: "first-project",
          applicationId: scriptStudioApplication.id,
          applicationVersion: scriptStudioApplication.version,
        },
      },
      localAccess,
    ).entityId;
    const inputId = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "record-input",
          projectId: "first-project",
          artifactId: null,
          artifactRevision: null,
          selection: "",
          body: "合成编剧版本测试",
          targetActantId: "morphz-agent",
          applicationInstanceId: instanceId,
        },
      },
      localAccess,
    ).entityId;
    const input = store.snapshot().inputs.find((i) => i.id === inputId)!;
    assert.deepEqual(
      workInputRequest(input).activation.harness,
      scriptStudioApplication.harness,
    );
    // Explicit historical fixture, not a rewrite of a live input.
    for (const version of [
      "1.0.0",
      "1.1.0",
      "1.1.1",
      "1.2.0",
      "1.2.1",
      "1.3.0",
    ]) {
      const historical = structuredClone(input);
      historical.application!.harness = { id: "morphz.script-studio", version };
      const frozen = JSON.stringify(historical);
      const request = workInputRequest(historical);
      assert.equal(request.client_message_id, input.id);
      assert.deepEqual(request.activation.harness, {
        id: "morphz.script-studio",
        version,
      });
      assert.deepEqual(workInputRequest(historical), request);
      assert.equal(JSON.stringify(historical), frozen);
    }
    assert.deepEqual(
      store.snapshot().inputs.find((i) => i.id === inputId),
      input,
    );
  } finally {
    store.close();
  }
});
