import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { workInputRequest } from "../packages/application/src/session-io.js";

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
  assert.deepEqual(scriptStudioApplication.harness, {
    id: "morphz.script-studio",
    version: "1.1.1",
  });
  assert.match(source, /\(version "1\.1\.1"\)/);
  assert.match(
    source,
    /\(capabilities \(tools host_morphz context_tx recall\)\)/,
  );
  assert.equal((source.match(/^\(infer/gm) ?? []).length, 1);
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

test("新输入绑定 1.1.1；历史输入及未知回执重试使用原 Harness，不替换版本", () => {
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
    for (const version of ["1.0.0", "1.1.0"]) {
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
