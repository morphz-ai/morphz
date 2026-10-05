import {
  parseCognitiveAppViewRequest,
  parseCognitiveAppViewResponse,
  type CognitiveAppViewLocation,
  type CognitiveAppViewRequestMap,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import type { CallOptions } from "../../../../packages/core/src/http-application-client.js";

export interface CognitiveViewOwnerPorts {
  /** Actual current-Human transport only; never a guest-supplied authority. */
  call(
    method: "cognitive-app-views.locate" | "cognitive-app-views.read-ui",
    parameters: unknown,
    options: CallOptions,
  ): Promise<unknown>;
}
export type CognitiveViewRead =
  | Readonly<{
      status: "absent" | "closed" | "unbound";
      location: CognitiveAppViewLocation;
    }>
  | Readonly<{
      status: "ready";
      location: CognitiveAppViewLocation;
      source: CognitiveAppViewUi;
    }>;

// Only detached parser output enters here. Freeze every presentation field so
// a caller cannot rewrite the owner's initial premise through its returned DTO.
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
function requireMatch(value: unknown): asserts value {
  if (!value) throw new Error("应用窗口位置已有变化，请重新打开。");
}
function immutableOwner(source: CognitiveAppViewUi) {
  const { view, binding } = source;
  return JSON.stringify([
    source.definition,
    source.manifest,
    source.authority,
    [
      view.id,
      view.workspaceId,
      view.applicationId,
      view.applicationVersion,
      view.createdAt,
    ],
    [
      binding.viewId,
      binding.projectId,
      binding.appId,
      binding.version,
      binding.connectionId,
      binding.instanceId,
      binding.serviceId,
      binding.dataAuthorityId,
      binding.revision,
      binding.createdAt,
    ],
    source.grantRevision,
    source.connectionRevision,
  ]);
}

/** Accept only a fresh source from the trusted router's actual readUi gate.
 * This comparison is not authorization, an own-save receipt, or a latest-source
 * cache. Mutable state/viewRevision may advance; fixed binding/access cannot. */
export function cognitiveViewSourceForOwner(
  initial: CognitiveAppViewUi,
  authorizedSource: unknown,
): CognitiveAppViewUi | null {
  try {
    const original = parseCognitiveAppViewResponse("readUi", initial);
    const current = parseCognitiveAppViewResponse("readUi", authorizedSource);
    if (
      current.view.revision < original.view.revision ||
      immutableOwner(current) !== immutableOwner(original)
    )
      return null;
    return freeze(current);
  } catch {
    return null;
  }
}

/** Read-only restore: an exact registered own slot is metadata, not permission.
 * Null, closed and unbound rows are retained as facts without creating a window,
 * choosing a connection, granting access, author calls, or mutation retries. */
export function createCognitiveViewOwner(ports: CognitiveViewOwnerPorts) {
  return Object.freeze({
    async read(
      raw: CognitiveAppViewRequestMap["locate"],
      signal: AbortSignal,
    ): Promise<CognitiveViewRead> {
      const slot = freeze(parseCognitiveAppViewRequest("locate", raw));
      signal.throwIfAborted();
      const location = freeze(
        parseCognitiveAppViewResponse(
          "locate",
          await ports.call("cognitive-app-views.locate", slot, { signal }),
        ),
      );
      signal.throwIfAborted();
      requireMatch(
        location.slot.projectId === slot.projectId &&
          location.slot.appId === slot.appId &&
          location.slot.version === slot.version &&
          location.slot.definitionHash === slot.expectedDefinitionHash,
      );
      const located = location.view;
      if (!located) return Object.freeze({ status: "absent", location });
      if (located.status === "closed")
        return Object.freeze({ status: "closed", location });
      const bound = located.binding;
      if (!bound) return Object.freeze({ status: "unbound", location });
      const source = freeze(
        parseCognitiveAppViewResponse(
          "readUi",
          await ports.call(
            "cognitive-app-views.read-ui",
            {
              viewId: located.viewId,
              expectedViewRevision: located.viewRevision,
              expectedBindingRevision: bound.bindingRevision,
            },
            { signal },
          ),
        ),
      );
      signal.throwIfAborted();
      requireMatch(
        source.view.id === located.viewId &&
          source.view.revision === located.viewRevision &&
          source.view.workspaceId === slot.projectId &&
          source.view.applicationId === slot.appId &&
          source.view.applicationVersion === slot.version &&
          source.authority.definitionHash === slot.expectedDefinitionHash &&
          source.binding.revision === bound.bindingRevision &&
          source.binding.connectionId === bound.connectionId &&
          source.binding.instanceId === bound.instanceId &&
          source.binding.serviceId === bound.serviceId &&
          source.binding.dataAuthorityId === bound.dataAuthorityId,
      );
      return Object.freeze({ status: "ready", location, source });
    },
  });
}
