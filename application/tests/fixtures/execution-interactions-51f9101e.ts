import { z } from "zod";
import {
  executionSnapshotSchema,
  type ExecutionScope,
  type ExecutionControl,
} from "../../packages/core/src/execution.js";
import type { Boot } from "../../apps/web/src/client.js";
import type { applicationCall } from "../../apps/web/src/application-transport.js";

/** Complete original Git 51f9101e algorithms. Typed controlled ports do not
 * establish actual Client/HTTP/Runtime authority or native UI acceptance.
 */
export const legacyExecutionClientSha =
  "effed98cb46cd9ab9ed968a1877ba3c363c2496ab6ca87bd243bd2034225c679";
export const legacyExecutionSourceHashes = {
  cancelInput:
    "e2fcdb5a456411526851f77347ae7e9cb3edcd91f6a5f576433e7e9fe2ade0c8",
  executionSnapshot:
    "27095ecdf2c8bef7939e3c5fd5c8c764612dfebccaeaab4963a4d8d955777411",
  executionResult:
    "8ee153277bd996ab4ff57c91c17c96640661fa6fc1a4930963244fb99f502a54",
  controlExecution:
    "d0475fb63d6bcd4afa17a17c56e135d8ca5d1e0f3da00eb0ea0acbef66946d6d",
  approvalSubmitted:
    "437a5679224991d49672cf83b9c1f9e8edd288c695a0da987c61e749ea24d409",
};
export type FixedExecutionBindings = {
  current: { readonly current: Boot | null };
  approvalSubmissions: { readonly current: Set<string> };
  updateApprovalSubmissions(
    value: number | ((version: number) => number),
  ): void;
  call: typeof applicationCall;
  refreshAfterMutation(): Promise<boolean>;
};
export function createFixedExecutionInteractions({
  current,
  approvalSubmissions,
  updateApprovalSubmissions,
  call: applicationCall,
  refreshAfterMutation,
}: FixedExecutionBindings) {
  async function cancelInput(inputId: string) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    await applicationCall("input.cancel", inputId, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(8000),
    });
    await refreshAfterMutation();
  }
  async function executionSnapshot(
    scope: ExecutionScope,
    signal?: AbortSignal,
  ) {
    return executionSnapshotSchema.parse(
      await applicationCall("execution.snapshot", scope, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
          : AbortSignal.timeout(12000),
      }),
    );
  }
  async function executionResult(scope: ExecutionScope, jobId: string) {
    return z
      .object({
        text: z.string(),
        truncated: z.boolean(),
        available: z.boolean(),
      })
      .parse(
        await applicationCall(
          "execution.result",
          { scope, jobId },
          { signal: AbortSignal.timeout(12000) },
        ),
      );
  }
  async function controlExecution(command: ExecutionControl) {
    if (!current.current) throw new Error("应用尚未就绪，请稍后重试。");
    if (
      command.action.type === "allow-once" ||
      command.action.type === "deny"
    ) {
      const key = JSON.stringify([
        current.current.csrfToken,
        command.action.approvalId,
        command.action.fingerprint,
      ]);
      if (approvalSubmissions.current.has(key))
        throw new Error("本次审批已提交，请核对最新执行状态，不要重复批准。");
      approvalSubmissions.current.add(key);
      updateApprovalSubmissions((version) => version + 1);
    }
    return applicationCall("execution.control", command, {
      identityGeneration: current.current.csrfToken,
      signal: AbortSignal.timeout(12000),
    });
  }
  function approvalSubmitted(approvalId: string, fingerprint: string) {
    return approvalSubmissions.current.has(
      JSON.stringify([current.current?.csrfToken, approvalId, fingerprint]),
    );
  }
  return {
    cancelInput,
    executionSnapshot,
    executionResult,
    controlExecution,
    approvalSubmitted,
  };
}
