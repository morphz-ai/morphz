import {
  reasoningLabels,
  type ExecutionModel,
} from "../../../packages/core/src/inference.js";

export function executionModelLabel(model?: ExecutionModel | null) {
  return model
    ? `${model.model} · 思考：${model.reasoning_effort === null ? "模型默认" : reasoningLabels[model.reasoning_effort]}`
    : "模型信息未记录";
}

export function executionModelDescription(model?: ExecutionModel | null) {
  return model
    ? `最近一次实际调用：${executionModelLabel(model)}${model.requested_alias !== model.model ? `；请求名：${model.requested_alias}` : ""}`
    : "没有已记录的实际模型调用；不使用当前设置推测";
}
