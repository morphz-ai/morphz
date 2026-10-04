import { z } from "zod";
import {
  executionSnapshotSchema,
  type ExecutionScope,
  type ExecutionControl,
} from "../../../../packages/core/src/execution.js";
import type { Boot } from "../client.js";
import type { applicationCall } from "../application-transport.js";

export type ExecutionInteractionPorts = {
  current: { readonly current: Boot | null };
  approvalSubmissions: { readonly current: Set<string> };
  updateApprovalSubmissions(
    value: number | ((version: number) => number),
  ): void;
  call: typeof applicationCall;
  refreshAfterMutation(): Promise<boolean>;
};

/** Own execution queries/controls and the original shared approval-attempt ledger.
 * Client keeps ref/state registration, identity authority and refresh scheduling.
 * Construction only borrows ports; it never reads refs or performs an operation.
 */
export function createExecutionInteractions({
  current,
  approvalSubmissions,
  updateApprovalSubmissions,
  call: applicationCall,
  refreshAfterMutation,
}: ExecutionInteractionPorts) {
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
