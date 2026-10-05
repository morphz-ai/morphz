import { z } from "zod";
import { ApplicationRequestError } from "../../../../packages/core/src/application-api.js";
import {
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../../packages/core/src/cognitive-app-application-target.js";
import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import type { CallOptions } from "../../../../packages/core/src/http-application-client.js";
import type { CognitiveNavigationLocation } from "./cognitive-navigation-location.js";

export type CognitiveViewOpeningRequest = Readonly<{
  projectId: string;
  target: CognitiveAppApplicationTarget;
  expectedGrantRevision: number;
  expectedConnectionRevision: number;
  commandId: string;
}>;
export type CognitiveViewOpened = Readonly<{
  location: Extract<CognitiveNavigationLocation, { kind: "view" }>;
  source: CognitiveAppViewUi;
}>;
export interface CognitiveViewOpeningPorts {
  /** Actual current-Human transport, never guest-controlled credentials. */
  call(
    method:
      | "cognitive-app-views.locate"
      | "cognitive-app-views.launch"
      | "cognitive-app-views.read-ui",
    parameters: unknown,
    options: CallOptions,
  ): Promise<unknown>;
  /** Pure captured-navigation/identity read, never a latest-owner fallback.
   * Real owner retirement also aborts the operation signal synchronously. A
   * stale true from a side-effectful guard is not an independent lease witness.
   */
  current(): boolean;
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const shape = z
  .object({
    projectId: id,
    target: z.unknown(),
    expectedGrantRevision: revision,
    expectedConnectionRevision: revision,
    commandId: id,
  })
  .strict();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
function parsed<T>(parse: () => T, status: 400 | 502): T {
  try {
    return parse();
  } catch {
    throw new ApplicationRequestError(
      status,
      "应用打开数据无效，结果未被采用。",
      status === 400 ? "invalid" : "contract",
    );
  }
}
function match(value: unknown): asserts value {
  if (!value)
    throw new ApplicationRequestError(
      409,
      "应用窗口或保存方已有变化，请重新选择。",
      "conflict",
    );
}

/** Explicit Human opening only. Locating an own slot is not permission. Never
 * silently bind, choose a connection, grant, retry, write preferences/drafts or
 * close an uncertain mutation. A discarded late result does not undo launch.
 */
export function createCognitiveViewOpening(ports: CognitiveViewOpeningPorts) {
  function active(signal: AbortSignal) {
    if (signal.aborted)
      throw new ApplicationRequestError(408, "应用打开已取消。", "cancelled");
    let current = false;
    try {
      current = ports.current();
    } catch {
      /* Retired owner fails closed. */
    }
    if (signal.aborted)
      throw new ApplicationRequestError(408, "应用打开已取消。", "cancelled");
    if (!current)
      throw new ApplicationRequestError(
        409,
        "应用打开位置已有变化，结果已丢弃。",
        "conflict",
      );
  }
  async function call(
    method: Parameters<CognitiveViewOpeningPorts["call"]>[0],
    parameters: unknown,
    signal: AbortSignal,
  ) {
    active(signal);
    try {
      const result = await ports.call(method, structuredClone(parameters), {
        signal,
      });
      active(signal);
      return result;
    } catch (error) {
      active(signal);
      throw error;
    }
  }
  return Object.freeze({
    async open(
      raw: CognitiveViewOpeningRequest,
      signal: AbortSignal,
    ): Promise<CognitiveViewOpened> {
      // Strict own-data inspection precedes reading/spreading any caller field.
      const request = parsed(() => {
        const value = shape.parse(
          JSON.parse(JSON.stringify(parseWireJson(raw))),
        );
        return freeze({
          ...value,
          target: parseCognitiveAppApplicationTarget(value.target),
        });
      }, 400);
      active(signal);
      const target = request.target;
      const slot = freeze(
        parseCognitiveAppViewRequest("locate", {
          projectId: request.projectId,
          appId: target.authority.appId,
          version: target.authority.version,
          expectedDefinitionHash: target.authority.definitionHash,
        }),
      );
      const rawLocation = await call(
        "cognitive-app-views.locate",
        slot,
        signal,
      );
      const located = parsed(
        () => parseCognitiveAppViewResponse("locate", rawLocation),
        502,
      );
      active(signal);
      match(
        located.slot.projectId === slot.projectId &&
          located.slot.appId === slot.appId &&
          located.slot.version === slot.version &&
          located.slot.definitionHash === slot.expectedDefinitionHash,
      );
      const view = located.view,
        binding = view?.binding;
      if (view) {
        // A previous slot belonging to another save owner stays untouched.
        // Even a closed row cannot be rebound merely by opening this target.
        match(
          binding &&
            binding.connectionId === target.connectionId &&
            binding.instanceId === target.authority.instanceId &&
            binding.serviceId === target.authority.serviceId &&
            binding.dataAuthorityId === target.authority.dataAuthorityId,
        );
      }
      let cas;
      if (!view || view.status === "closed") {
        const launch = parseCognitiveAppViewRequest("launch", {
          ...slot,
          connectionId: target.connectionId,
          expectedGrantRevision: request.expectedGrantRevision,
          expectedConnectionRevision: request.expectedConnectionRevision,
          commandId: request.commandId,
          expectedViewRevision: view?.viewRevision ?? 0,
          expectedBindingRevision: binding?.bindingRevision ?? 0,
        });
        const rawMutation = await call(
          "cognitive-app-views.launch",
          launch,
          signal,
        );
        const mutation = parsed(
          () => parseCognitiveAppViewResponse("launch", rawMutation),
          502,
        );
        active(signal);
        if (view)
          match(
            mutation.receipt.viewId === view.viewId &&
              mutation.receipt.viewRevision === view.viewRevision + 1 &&
              mutation.receipt.bindingRevision === binding!.bindingRevision,
          );
        else
          // The actual registry's 0/0 creation initializes both revisions to
          // one; a later same-authority DTO cannot substitute for this receipt.
          match(
            mutation.receipt.viewRevision === 1 &&
              mutation.receipt.bindingRevision === 1,
          );
        cas = parseCognitiveAppViewRequest("readUi", {
          viewId: mutation.receipt.viewId,
          expectedViewRevision: mutation.receipt.viewRevision,
          expectedBindingRevision: mutation.receipt.bindingRevision,
        });
      } else {
        cas = parseCognitiveAppViewRequest("readUi", {
          viewId: view.viewId,
          expectedViewRevision: view.viewRevision,
          expectedBindingRevision: binding!.bindingRevision,
        });
      }
      // A mutation receipt is metadata only. The original readUi service is
      // still the sole immutable-byte and before/after authorization gate.
      const rawSource = await call("cognitive-app-views.read-ui", cas, signal);
      const source = parsed(
        () => parseCognitiveAppViewResponse("readUi", rawSource),
        502,
      );
      active(signal);
      match(
        source.view.id === cas.viewId &&
          source.view.status === "open" &&
          source.view.revision === cas.expectedViewRevision &&
          source.view.workspaceId === slot.projectId &&
          source.binding.revision === cas.expectedBindingRevision &&
          sameCognitiveAppApplicationTarget(target, {
            connectionId: source.binding.connectionId,
            authority: source.authority,
          }) &&
          source.grantRevision === request.expectedGrantRevision &&
          source.connectionRevision === request.expectedConnectionRevision &&
          source.definition.id === slot.appId &&
          source.definition.version === slot.version &&
          source.definition.ui !== null &&
          source.definition.ui.packageVersion === slot.version &&
          source.manifest.id === slot.appId &&
          source.manifest.version === slot.version,
      );
      const result = freeze({
        location: { kind: "view" as const, slot },
        source,
      });
      active(signal);
      return result;
    },
  });
}
