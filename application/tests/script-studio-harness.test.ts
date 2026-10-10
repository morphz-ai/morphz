import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { scriptStudioApplication } from "../packages/core/src/applications.js";
import { platformRuntimeHostFixture } from "./platform-runtime-host-fixture.js";
import type { RecordedInput } from "../packages/core/src/model.js";
import { workInputRequest } from "../packages/application/src/session-io.js";
import { receivedWorkflowText } from "../scripts/script-studio-quality-evidence.js";
import { workToolDefinitions } from "../packages/application/src/agent-tools.js";

test("两种 Host 工具说明都符合真实 Runtime 的 16000 字节上限", () => {
  for (const definition of workToolDefinitions) {
    assert.ok(Buffer.byteLength(definition.description, "utf8") <= 16000);
    assert.match(definition.description, /restore old versions as new heads/);
    assert.match(definition.description, /submissionMode=current/);
    assert.doesNotMatch(definition.description, /Humans edit\/adopt/);
  }
});

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
    version: "2.0.0",
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
  assert.match(source, /\(version "2\.0\.0"\)/);
  for (const [version, hash] of [
    [
      "1.4.0",
      "707a8d5c619bc285a91543cd388f7c5fc596d4aa2a88625319378039664b9828",
    ],
    [
      "1.4.2",
      "4295fd7197f9c0b4a82c8aef946af199d82c5c66ab68d0d8f9278ade216b0224",
    ],
    [
      "1.4.3",
      "b2539bab37bf101894bfba3542d4ebe75d82b58e6a5266d553ff158e43cdb9ff",
    ],
    [
      "1.4.4",
      "8c6050d77490fa6783ba0ec4c1681d3ef09384e6a54c82768490a3b56b1808ac",
    ],
  ] as const) {
    const archived = readFileSync(
      new URL(
        `../harnesses/legacy/script-studio-${version}.hns`,
        import.meta.url,
      ),
    );
    assert.equal(createHash("sha256").update(archived).digest("hex"), hash);
    assert.match(
      archived.toString("utf8"),
      new RegExp(`\\(version "${version.replaceAll(".", "\\.")}"\\)`),
    );
  }
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

test("准备阶段允许明确新建空对象，未绑定目标不再被误当作创建限制", () => {
  const source = readFileSync(
    new URL("../harnesses/script-studio.hns", import.meta.url),
    "utf8",
  );
  const prepare = source.slice(
    source.indexOf("(fn prepare-script"),
    source.indexOf("(fn initial-script"),
  );
  assert.match(source, /明确要求新建剧本或条目.*execute=true/);
  assert.match(prepare, /create-production的projectId只用input.projectId/);
  assert.match(
    prepare,
    /expectedActivityRevision来自最新read-production.activityRevision/,
  );
  assert.match(prepare, /只要求创建时.*不调用prepare-workflow/);
  assert.match(prepare, /command只允许上述create-production\/create-item/);
  assert.match(prepare, /只有明确新建意图才允许/);
  assert.match(prepare, /无需额外启用Agent或确认模型处理许可/);
  assert.match(prepare, /旧modelProcessingAllowed=false不阻止创作/);
  assert.match(prepare, /真实项目、原作版本访问权限与取消校验仍适用/);
  assert.doesNotMatch(prepare, /不代替用户确认资料可交给模型/);
  assert.doesNotMatch(prepare, /不能调用command或submit-workflow/);
});

test("新正文报告原子写入与投影事实，旧输入保持候选兼容，不从失败响应猜回滚", () => {
  const source = readFileSync(
    new URL("../harnesses/script-studio.hns", import.meta.url),
    "utf8",
  );
  const delivery = source.slice(
    source.indexOf("STAGE script-delivery。"),
    source.indexOf("(eval"),
  );
  assert.match(delivery, /saved=true说明全部正文原件已保存/);
  assert.match(delivery, /directoryReady=false说明目录待恢复，不重新生成/);
  assert.match(delivery, /新批次全量保存或全量回滚/);
  assert.match(
    delivery,
    /saved已保存，saved-projection-pending已写应用原件但目录待恢复/,
  );
  assert.match(delivery, /unknown不能称未保存或已保存/);
  assert.match(delivery, /新正文无需采纳.*回退版本/);
  assert.match(source, /submissionMode="current",maxCandidates=1/);
  assert.match(source, /baseRevision\+1.*完整数组中真实交付的其他目标/);
  assert.doesNotMatch(source, /正式稿、采纳、批准、锁稿和导出仍由Human控制/);
  assert.doesNotMatch(delivery, /已执行自审次数；ok=false/);
});

test("新输入绑定 2.0.0；历史请求和回执重试保留原 Harness 版本", async () => {
  const f = await platformRuntimeHostFixture();
  try {
    const command = {
      commandId: randomUUID(),
      operation: {
        type: "record-input" as const,
        projectId: f.projectId,
        artifactId: null,
        artifactRevision: null,
        selection: "",
        body: "合成编剧版本测试",
        targetActantId: "morphz-agent",
        application: {
          id: scriptStudioApplication.id,
          version: scriptStudioApplication.version,
        },
      },
    };
    const receipt = await f.session().platformMessage(command);
    const ledger = f.store.runtimeState() as {
      deliveries: {
        inputId: string;
        platformSource: Omit<
          RecordedInput,
          "id" | "artifactId" | "artifactRevision" | "selection"
        >;
        request: ReturnType<typeof workInputRequest>;
      }[];
    };
    const delivery = ledger.deliveries.find(
      (entry) => entry.inputId === receipt.entityId,
    )!;
    assert.deepEqual(
      delivery.request.activation.harness,
      scriptStudioApplication.harness,
    );
    const input: RecordedInput = {
      ...delivery.platformSource,
      id: delivery.inputId,
      artifactId: null,
      artifactRevision: null,
      selection: "",
    };
    assert.deepEqual(
      workInputRequest(input).activation.harness,
      scriptStudioApplication.harness,
    );
    // Explicit immutable Runtime protocol fixtures, not old business storage.
    for (const version of [
      "1.0.0",
      "1.1.0",
      "1.1.1",
      "1.2.0",
      "1.2.1",
      "1.3.0",
      "1.4.0",
      "1.4.2",
      "1.4.3",
      "1.4.4",
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
    const before = structuredClone(f.store.runtimeState());
    await f.reopen();
    assert.deepEqual(await f.session().platformMessage(command), receipt);
    assert.deepEqual(f.store.runtimeState(), before);
    f.assertNoLegacyData();
  } finally {
    await f.close();
  }
});
