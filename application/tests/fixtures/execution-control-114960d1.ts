import type { ExecutionScope } from "../../packages/core/src/execution.js";

/** Type-only ingress of the committed historical inspection fixtures. Keep
 * their four original actions fixed when the current product gains controls.
 * This changes no captured source, hash, algorithm or runtime validation. */
export type HistoricalExecutionControl = {
  scope: ExecutionScope;
  action:
    | { type: "cancel-thread"; threadId: string; revision: number }
    | { type: "cancel-job"; jobId: string; revision: number }
    | {
        type: "allow-once" | "deny";
        approvalId: string;
        fingerprint: string;
      };
};
