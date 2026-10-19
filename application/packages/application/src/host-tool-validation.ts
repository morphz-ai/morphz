import type { ZodError } from "zod";

export const hostOperationInvocationGuide =
  '先调用 {"action":"operations","operations":{"action":"list"}}，再按返回的 operationId 用同样的双层 action 调用 describe／invoke；operations 是单个对象，不是数组，parameters 只承载该操作的 schema 字段。';

/** Describe the rejected shape, never echo argument values or a Zod stack.
 * Both Host transports preserve this same bounded, non-executing receipt. */
export function hostToolValidationFailure(error: ZodError) {
  const key = (value: PropertyKey) => String(value).slice(0, 128);
  return {
    ok: false as const,
    code: "invalid" as const,
    message:
      "工具参数不符合已声明契约，未执行操作。请先 list／describe 读取确切 schema。" +
      hostOperationInvocationGuide,
    issues: error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.slice(0, 8).map(key),
      code: issue.code,
      ...(issue.code === "unrecognized_keys"
        ? { keys: issue.keys.slice(0, 16).map(key) }
        : {}),
      ...(issue.code === "invalid_type" ? { expected: issue.expected } : {}),
      ...(issue.code === "too_big" && typeof issue.maximum === "number"
        ? { maximum: issue.maximum }
        : {}),
      ...(issue.code === "too_small" && typeof issue.minimum === "number"
        ? { minimum: issue.minimum }
        : {}),
    })),
    issuesTruncated: error.issues.length > 8,
  };
}
