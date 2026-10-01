import { randomBytes } from "node:crypto";
import type { HostInvocation } from "./agent-tools.js";
import {
  resolveRuntimeInvocationEvidence,
  type RuntimeInputEvidenceReader,
  type TaskSourceEvidenceReader,
} from "./runtime-input-evidence.js";
import type { TaskRunAdmission } from "../../platform/src/task-run-admission.js";
import {
  PlatformStorageError,
  type PlatformActor,
  type PlatformAuthorityVerifier,
} from "../../platform/src/store.js";

export type RuntimePlatformIdentity = {
  tenantId: string;
  principalId: string;
  humanActantId: string;
  agentActantId: string;
};

type IssuedSource =
  | {
      kind: "input";
      inputId: string;
      projectId: string;
      claimedHumanActantId: string;
    }
  | { kind: "task-run"; admission: TaskRunAdmission };

type Issued = {
  runtimePrincipalId: string;
  runtimeAgentId: string;
  source: IssuedSource;
  identity: RuntimePlatformIdentity;
  expiresAt: number;
};

type TaskRunAuthority = {
  sourceEventForRuntime?: TaskSourceEvidenceReader;
  admissionForRuntime(
    sessionId: string,
    scheduleId: string,
  ): Promise<TaskRunAdmission>;
  identityForTaskRun(
    runtimePrincipalId: string,
    runtimeAgentId: string,
    admission: TaskRunAdmission,
  ): Promise<RuntimePlatformIdentity | null>;
};

/** Host-only, one-invocation credentials. This is not a user token and is
 * never serialized into a model prompt or persisted as a Runtime message.
 */
export class RuntimePlatformAuthority {
  private readonly issued = new Map<string, Issued>();

  constructor(
    private readonly evidence: RuntimeInputEvidenceReader,
    private readonly identityForRuntimePrincipal: (
      runtimePrincipalId: string,
      runtimeAgentId: string,
      projectId: string,
      inputId: string,
      claimedHumanActantId: string,
    ) => Promise<RuntimePlatformIdentity | null>,
    private readonly options: {
      now?: () => number;
      taskRuns?: TaskRunAuthority;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private async currentIdentity(
    runtimePrincipalId: string,
    runtimeAgentId: string,
    source: IssuedSource,
  ) {
    return source.kind === "input"
      ? this.identityForRuntimePrincipal(
          runtimePrincipalId,
          runtimeAgentId,
          source.projectId,
          source.inputId,
          source.claimedHumanActantId,
        )
      : this.options.taskRuns?.identityForTaskRun(
          runtimePrincipalId,
          runtimeAgentId,
          source.admission,
        );
  }

  async withInvocation<T>(
    route: HostInvocation,
    work: (
      actor: PlatformActor,
      scope: { projectId: string; inputId: string | null },
      identity: RuntimePlatformIdentity,
    ) => Promise<T>,
  ): Promise<T> {
    const source = await resolveRuntimeInvocationEvidence(
      route,
      this.evidence,
      this.options.taskRuns?.admissionForRuntime,
      this.options.taskRuns?.sourceEventForRuntime,
    );
    const issuedSource: IssuedSource =
      source.kind === "input"
        ? {
            kind: "input",
            inputId: source.inputId,
            projectId: source.projectId,
            claimedHumanActantId: source.claimedActantId,
          }
        : { kind: "task-run", admission: source.admission };
    const identity = await this.currentIdentity(
      source.runtimePrincipalId,
      route.agent_id,
      issuedSource,
    );
    const expectedHuman =
      issuedSource.kind === "input"
        ? issuedSource.claimedHumanActantId
        : issuedSource.admission.humanActantId;
    if (
      !identity ||
      identity.humanActantId !== expectedHuman ||
      (issuedSource.kind === "task-run" &&
        (identity.tenantId !== issuedSource.admission.tenantId ||
          identity.principalId !== issuedSource.admission.principalId))
    )
      throw new PlatformStorageError(
        "forbidden",
        "发起来源的 Human 身份已失效或与 Runtime 身份不符。",
      );
    const credential = randomBytes(32).toString("hex");
    this.issued.set(credential, {
      runtimePrincipalId: source.runtimePrincipalId,
      runtimeAgentId: route.agent_id,
      source: issuedSource,
      identity,
      expiresAt: this.now() + 60_000,
    });
    try {
      return await work(
        { credential },
        {
          projectId:
            issuedSource.kind === "input"
              ? issuedSource.projectId
              : issuedSource.admission.projectId,
          inputId:
            issuedSource.kind === "input"
              ? issuedSource.inputId
              : issuedSource.admission.sourceInputId,
        },
        identity,
      );
    } finally {
      this.issued.delete(credential);
    }
  }

  /** Compose with existing application-receipt and Node verifiers. */
  verifier(
    remaining: Omit<PlatformAuthorityVerifier, "resolveActor">,
  ): PlatformAuthorityVerifier {
    return {
      ...remaining,
      resolveActor: async ({ credential }) => {
        const issued = this.issued.get(credential);
        if (!issued || this.now() >= issued.expiresAt) return null;
        const current = await this.currentIdentity(
          issued.runtimePrincipalId,
          issued.runtimeAgentId,
          issued.source,
        );
        const expectedHuman =
          issued.source.kind === "input"
            ? issued.source.claimedHumanActantId
            : issued.source.admission.humanActantId;
        if (
          !current ||
          current.tenantId !== issued.identity.tenantId ||
          current.principalId !== issued.identity.principalId ||
          current.humanActantId !== expectedHuman ||
          current.agentActantId !== issued.identity.agentActantId
        )
          return null;
        return {
          tenantId: current.tenantId,
          principalId: current.principalId,
          actantId: current.agentActantId,
          kind: "agent" as const,
          runtimeInputId:
            issued.source.kind === "input"
              ? issued.source.inputId
              : issued.source.admission.sourceInputId,
          initiatingHumanActantId: current.humanActantId,
          scopeProjectId:
            issued.source.kind === "input"
              ? issued.source.projectId
              : issued.source.admission.projectId,
          ...(issued.source.kind === "task-run"
            ? {
                runtimeTaskRun: {
                  sessionId: issued.source.admission.sessionId,
                  scheduleId: issued.source.admission.request.id,
                  eventId: issued.source.admission.eventId,
                },
              }
            : {}),
        };
      },
    };
  }
}
