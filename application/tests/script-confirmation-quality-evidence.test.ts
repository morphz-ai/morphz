import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoCreativeWrites,
  assertThreeCandidateDeliveries,
  assertWithinLiveAllowance,
  assertPartialDeliveryText,
  contextContainsProposal,
  extractCanonicalDeliveryPrompt,
  nativeResponseMessage,
  nativeUsageTotals,
} from "../scripts/script-confirmation-quality.js";
import {
  emptyScriptDraft,
  type ScriptProduction,
} from "../packages/core/src/script-studio.js";

function fixture() {
  const targetIds = ["character-one", "character-two", "outline"];
  const inputId = "confirmation-input";
  const items = targetIds.map((id, index) => ({
    id,
    kind: index < 2 ? "character" : "outline",
    revision: 1,
    status: "draft",
    approval: null,
    versions: [{ revision: 1, draft: emptyScriptDraft(id) }],
  }));
  const prose =
    "这是一份具有可行动目标、具体阻力、人物关系与选择代价的合成候选正文。".repeat(
      5,
    );
  const candidates = targetIds.map((targetId, index) => ({
    id: `candidate-${index}`,
    targetId,
    inputId,
    baseRevision: 1,
    status: "pending",
    draft: {
      ...emptyScriptDraft(targetId),
      text:
        index < 2
          ? prose
          : ["一", "二", "三", "四", "五"]
              .map((scene) => `第${scene}场\n${prose}`)
              .join("\n"),
    },
  }));
  // This is only a validator fixture, not a Runtime or Host acceptance claim.
  const production = {
    items,
    candidates,
    reviews: [],
    exports: [],
  } as unknown as ScriptProduction;
  const preparations = targetIds.map((target_item_id, index) => ({
    input_id: inputId,
    target_item_id,
    base_item_revision: 1,
    task_request:
      index === 0 ? "为当前唯一提案制作两位主角设定与五场戏大纲。" : "",
  }));
  const receipts = candidates.map((candidate) => ({
    input_id: inputId,
    operation: "submit-candidate",
    result_object_id: candidate.id,
    result_version_ref: "candidate:1",
  }));
  return { production, inputId, targetIds, preparations, receipts };
}

test("live gate requires three distinct nonempty pending candidates and exact durable receipts", () => {
  const f = fixture();
  assertThreeCandidateDeliveries(
    f.production,
    f.inputId,
    f.targetIds,
    f.preparations,
    f.receipts,
  );
  for (const mutation of [
    "empty",
    "missing",
    "receipt",
    "input",
    "target",
    "accepted",
    "formal",
    "six-scenes",
    "root-task",
    "copied-child-task",
  ] as const) {
    const bad = fixture();
    switch (mutation) {
      case "empty":
        bad.production.candidates[0]!.draft.text = "";
        break;
      case "missing":
        bad.production.candidates.pop();
        break;
      case "receipt":
        bad.receipts.pop();
        break;
      case "input":
        bad.receipts[0]!.input_id = "another-input";
        break;
      case "target":
        bad.production.candidates[1]!.targetId = bad.targetIds[0]!;
        break;
      case "accepted":
        bad.production.candidates[0]!.status = "accepted";
        break;
      case "formal":
        bad.production.items[0]!.versions[0]!.draft.text = "Agent 不该自行采纳";
        break;
      case "six-scenes":
        bad.production.candidates[2]!.draft.text += "\n第六场";
        break;
      case "root-task":
        bad.preparations[0]!.task_request = "";
        break;
      case "copied-child-task":
        bad.preparations[1]!.task_request = bad.preparations[0]!.task_request;
        break;
    }
    assert.throws(
      () =>
        assertThreeCandidateDeliveries(
          bad.production,
          bad.inputId,
          bad.targetIds,
          bad.preparations,
          bad.receipts,
        ),
      mutation,
    );
  }
});

test("native lab adapter preserves original tool argument bytes including optional annotations", () => {
  const argumentsText =
    '{"action":"script","_annotations":{"intent":"核对实际范围"},"script":{"action":"list"}}';
  const message = nativeResponseMessage({
    content: "",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        func_name: "host_morphz",
        arguments: argumentsText,
      },
    ],
  });
  assert.equal(message.tool_calls?.[0]?.function.arguments, argumentsText);
  assert.deepEqual(
    nativeResponseMessage({ content: "原生实际回复", tool_calls: [] }),
    { role: "assistant", content: "原生实际回复" },
  );
});

test("buffered native multi-call stream keeps independent OpenAI call indices", () => {
  const raw = {
    content: "",
    tool_calls: ["first", "second", "third"].map((name, index) => ({
      id: `call-${index}`,
      type: "function",
      func_name: name,
      arguments: JSON.stringify({ input: index }),
    })),
  };
  const message = nativeResponseMessage(raw, true);
  assert.deepEqual(
    message.tool_calls?.map((call) => call.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    message.tool_calls?.map((call) => call.function.arguments),
    raw.tool_calls.map((call) => call.arguments),
  );
  assert.deepEqual(
    nativeResponseMessage(raw).tool_calls?.map((call) => call.index),
    [undefined, undefined, undefined],
  );
});

test("proposal evidence accepts exact quoted Context text but never a paraphrase", () => {
  const proposal = "先做两位主角设定。\n然后制作五场戏大纲。";
  assert.ok(
    contextContainsProposal([{ role: "system", content: proposal }], proposal),
  );
  assert.ok(
    contextContainsProposal(
      [{ role: "system", content: `(${JSON.stringify(proposal)})` }],
      proposal,
    ),
  );
  assert.equal(
    contextContainsProposal(
      [{ role: "system", content: "拟写人物和大纲" }],
      proposal,
    ),
    false,
  );
});

test("defer/ambiguous gate rejects empty target creation and saved candidate prose", () => {
  const baseline = fixture().production;
  assertNoCreativeWrites(structuredClone(baseline), baseline);
  const candidate = structuredClone(baseline);
  candidate.candidates.pop();
  assert.throws(() => assertNoCreativeWrites(candidate, baseline));
  const emptyTarget = structuredClone(baseline);
  emptyTarget.items.pop();
  assert.throws(() => assertNoCreativeWrites(emptyTarget, baseline));
});

test("request 17 is refused before a bridge write, without any new Native Client call", () => {
  let bridgeWrites = 0;
  const start = (calls: number) => {
    assertWithinLiveAllowance(calls);
    bridgeWrites++;
  };
  start(15);
  assert.equal(bridgeWrites, 1);
  assert.throws(() => start(16), /allowance is exhausted/);
  assert.equal(bridgeWrites, 1);
  for (const invalid of [-1, 1.5, Number.NaN])
    assert.throws(() => start(invalid));
});

test("Native usage keeps processed input, cache and output separate", () => {
  assert.deepEqual(
    nativeUsageTotals([
      {
        native: {
          usage: {
            input_tokens: 10,
            cached_input_tokens: 4,
            uncached_input_tokens: 6,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      },
      {
        native: {
          usage: {
            input_tokens: 20,
            cached_input_tokens: 5,
            uncached_input_tokens: 15,
            output_tokens: 3,
            total_tokens: 23,
          },
        },
      },
    ]),
    {
      input_tokens: 30,
      cached_input_tokens: 9,
      uncached_input_tokens: 21,
      output_tokens: 5,
      total_tokens: 35,
    },
  );
});

test("partial semantic probe uses the canonical literal and distinguishes saved, failed and unknown", () => {
  const literal = "STAGE script-delivery。\n只根据 receipt 汇报，不调用工具。";
  assert.equal(
    extractCanonicalDeliveryPrompt(
      `(infer (returns String) \"\"\"${literal}\"\"\")`,
    ),
    literal,
  );
  assert.throws(() =>
    extractCanonicalDeliveryPrompt("a rewritten delivery prompt"),
  );
  assertPartialDeliveryText(
    "主角一已保存候选；主角二保存失败、未保存；五场戏大纲状态未知，无法核对是否保存，保留原命令等待回执恢复。候选未采纳、未批准。",
  );
  assert.throws(() =>
    assertPartialDeliveryText("主角一、主角二、五场戏大纲全部已保存，未批准。"),
  );
});
