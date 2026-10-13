import { z } from "zod";

/** Public, typed Runtime facts only. No parsing Provider error strings, no
 * invented retry count, deadline, automatic fallback or credential repair. */
export const providerRecoverySchema = z.object({
  startedAt: z.string(),
  phase: z.enum(["waiting", "resumed"]),
  reason: z.enum([
    "service",
    "credentials",
    "configuration",
    "capacity",
    "unknown",
  ]),
});
export type ProviderRecovery = z.infer<typeof providerRecoverySchema>;

export function providerRecoveryFromEvent(event: {
  topic: string;
  actor?: string;
  type?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}): ProviderRecovery | undefined {
  if (event.topic === "runtime/provider_recovered") {
    if (
      event.actor === "Runtime-ProviderRecovery" &&
      event.type === "tool_output" &&
      event.payload.runtime_force_evaluation === true &&
      typeof event.payload.dependency_id === "string" &&
      typeof event.payload.recovery_event_id === "string"
    )
      return {
        startedAt: event.timestamp,
        phase: "resumed",
        reason: "unknown",
      };
    return;
  }
  if (
    !["chat/progress", "runtime/provider_wait"].includes(event.topic) ||
    event.payload.disposition !== "provider_wait"
  )
    return;
  const failure = event.payload.runtime_failure_kind;
  const reason =
    failure === "authentication"
      ? "credentials"
      : ["provider_configuration", "invalid_model_or_request"].includes(
            String(failure),
          )
        ? "configuration"
        : failure === "quota_exhausted"
          ? "capacity"
          : [
                "transient_network",
                "server_unavailable",
                "rate_limited",
              ].includes(String(failure))
            ? "service"
            : "unknown";
  return { startedAt: event.timestamp, phase: "waiting", reason };
}
