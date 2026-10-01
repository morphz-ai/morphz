import test from "node:test";
import assert from "node:assert/strict";
import { composerSettingsSummary } from "../apps/web/src/composer-settings-summary.js";

const catalog = {
  current: "default-route",
  options: [
    {
      id: "default-route",
      label: "默认线路",
      physical_models: ["gpt-6.1-sol"],
    },
    {
      id: "other",
      label: "备用",
      physical_models: ["actual-one", "actual-two"],
    },
  ],
  reasoning: { current: "high" as const, levels: ["low", "high"] as const },
};

test("底栏使用真实物理模型；未指定强度始终显示默认，不冒充继承档位", () => {
  assert.deepEqual(
    composerSettingsSummary({
      catalog: {
        ...catalog,
        reasoning: {
          ...catalog.reasoning,
          levels: [...catalog.reasoning.levels],
        },
      },
    }),
    {
      model: "gpt-6.1-sol",
      reasoning: "默认",
      explicit: false,
    },
  );
});

test("模型默认为轻量也不把本次默认选择改为轻量", () => {
  assert.equal(
    composerSettingsSummary({
      catalog: {
        ...catalog,
        reasoning: { current: "low", levels: ["low", "high"] },
      },
    }).reasoning,
    "默认",
  );
});

test("本次模型与推理选择优先于默认，省略推理才沿用默认", () => {
  assert.deepEqual(
    composerSettingsSummary({
      model: "other",
      reasoning: "low",
      catalog: {
        ...catalog,
        reasoning: {
          ...catalog.reasoning,
          levels: [...catalog.reasoning.levels],
        },
      },
    }),
    {
      model: "actual-one / actual-two",
      reasoning: "轻量",
      explicit: true,
    },
  );
});

test("未读取到能力时只保留已知模型，不编造推理档位或权限", () => {
  assert.deepEqual(composerSettingsSummary({ current: "known-model" }), {
    model: "known-model",
    reasoning: "默认",
    explicit: false,
  });
  assert.deepEqual(composerSettingsSummary({ model: "unconfirmed-route" }), {
    model: "unconfirmed-route",
    reasoning: "默认",
    explicit: true,
  });
  assert.deepEqual(composerSettingsSummary({}), {
    model: "默认模型",
    reasoning: "默认",
    explicit: false,
  });
});
