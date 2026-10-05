import { ApplicationRequestError } from "../../../../packages/core/src/application-api.js";
import { parseCognitiveAppRequest } from "../../../../packages/core/src/cognitive-app-api.js";
import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import {
  canonicalJsonBytes,
  parseObjectReadResponse,
  type DomainObjectReadResponse,
} from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  parseOperationResources,
  parseWireJson,
  type OperationResourceReference,
} from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import {
  platformContentSchema,
  type PlatformContent,
} from "../platform-client.js";

type OwnerMethod =
  | "content.get"
  | "content.resolve"
  | "cognitive-apps.read-object"
  | "cognitive-app-views.read-ui";
/** Trusted current-Human transport only. References and view snapshots are
 * locators, not credentials or permission. No navigation/draft owner lives here. */
export interface CognitiveObjectOwnerPorts {
  call(
    method: OwnerMethod,
    parameters: unknown,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
const same = (left: unknown, right: unknown) => {
  const a = canonicalJsonBytes(left),
    b = canonicalJsonBytes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
function active(signal: AbortSignal) {
  if (signal.aborted)
    throw new ApplicationRequestError(408, "原件读取已取消。", "cancelled");
}
function check(condition: unknown, status = 409) {
  if (!condition)
    throw new ApplicationRequestError(
      status,
      "原件保存方或窗口范围不一致，结果已丢弃。",
      status === 409 ? "conflict" : "contract",
    );
}
function parsed<T>(parse: () => T, status: number): T {
  try {
    return parse();
  } catch {
    throw new ApplicationRequestError(
      status,
      "认知应用原件数据无效。",
      status === 400 ? "invalid" : "contract",
    );
  }
}
function entry(raw: unknown): PlatformContent {
  return parsed(
    () =>
      platformContentSchema.parse(
        JSON.parse(JSON.stringify(parseWireJson(raw))),
      ),
    502,
  );
}
function exactEntry(
  value: PlatformContent,
  locator: CognitiveAppObjectLocator,
) {
  // The catalog's observed head is not the authority on App-owned history.
  check(
    value.id === locator.contentId &&
      value.projectId === locator.projectId &&
      value.appId === locator.authority.appId &&
      value.instanceId === locator.authority.instanceId &&
      value.appObjectId === locator.object.objectId &&
      value.availability === "available",
  );
}

/** Read-only original-reference leaf. Every call retains its independent
 * snapshot and exact opaque version; there is no latest/first-connection path,
 * hidden grant, business write, retry, navigation or input submission. */
export function createCognitiveObjectOwner(ports: CognitiveObjectOwnerPorts) {
  async function call(
    method: OwnerMethod,
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
  async function gate(source: CognitiveAppViewUi, signal: AbortSignal) {
    const raw = await call(
      "cognitive-app-views.read-ui",
      {
        viewId: source.view.id,
        expectedViewRevision: source.view.revision,
        expectedBindingRevision: source.binding.revision,
      },
      signal,
    );
    const current = parsed(
      () => parseCognitiveAppViewResponse("readUi", raw),
      502,
    );
    // HTML keeps its existing 1 MB byte contract, not the smaller wire budget
    // used for bounded metadata equality. The remaining manifest is bounded.
    const { ui: sourceUi, ...sourceManifest } = source.manifest;
    const { ui: currentUi, ...currentManifest } = current.manifest;
    check(
      same(current.view, source.view) &&
        same(current.binding, source.binding) &&
        same(current.authority, source.authority) &&
        same(current.definition, source.definition) &&
        same(currentManifest, sourceManifest) &&
        currentUi.type === "sandbox" &&
        sourceUi.type === "sandbox" &&
        currentUi.html === sourceUi.html &&
        currentUi.presentation === sourceUi.presentation &&
        current.grantRevision === source.grantRevision &&
        current.connectionRevision === source.connectionRevision,
    );
  }
  async function get(locator: CognitiveAppObjectLocator, signal: AbortSignal) {
    const result = entry(
      await call("content.get", { contentId: locator.contentId }, signal),
    );
    exactEntry(result, locator);
    return result;
  }
  return {
    async locatorForView(
      sourceUi: CognitiveAppViewUi,
      object: OperationResourceReference,
      signal: AbortSignal,
    ) {
      // All caller-owned values are inspected and detached before the first await.
      const source = parsed(
        () => parseCognitiveAppViewResponse("readUi", sourceUi),
        400,
      );
      const reference = parsed(
        () => parseOperationResources("objects", [object])[0]!,
        400,
      );
      await gate(source, signal);
      const resolved = entry(
        await call(
          "content.resolve",
          {
            appId: source.binding.appId,
            instanceId: source.binding.instanceId,
            appObjectId: reference.objectId,
          },
          signal,
        ),
      );
      const locator = parsed(
        () =>
          parseCognitiveAppObjectLocator({
            contentId: resolved.id,
            projectId: source.binding.projectId,
            connectionId: source.binding.connectionId,
            authority: source.authority,
            object: reference,
          }),
        502,
      );
      exactEntry(resolved, locator);
      await get(locator, signal);
      await gate(source, signal);
      active(signal);
      return locator;
    },
    async readOriginal(
      raw: CognitiveAppObjectLocator,
      maxBytes: number,
      signal: AbortSignal,
    ): Promise<{
      locator: CognitiveAppObjectLocator;
      entry: PlatformContent;
      original: DomainObjectReadResponse;
    }> {
      const locator = parsed(() => parseCognitiveAppObjectLocator(raw), 400);
      const request = parsed(
        () =>
          parseCognitiveAppRequest("readObject", {
            projectId: locator.projectId,
            appId: locator.authority.appId,
            version: locator.authority.version,
            connectionId: locator.connectionId,
            expectedDefinitionHash: locator.authority.definitionHash,
            object: locator.object,
            maxBytes,
          }),
        400,
      );
      await get(locator, signal);
      const reply = await call("cognitive-apps.read-object", request, signal);
      const original = parsed(
        () =>
          parseObjectReadResponse(
            JSON.parse(JSON.stringify(parseWireJson(reply))),
          ),
        502,
      );
      check(
        same(original.authority, locator.authority) &&
          same(original.object, locator.object),
        502,
      );
      const content = original.content;
      check(
        new TextEncoder().encode(
          content.format === "json"
            ? JSON.stringify(content.value)
            : content.text,
        ).byteLength <= maxBytes,
        502,
      );
      const current = await get(locator, signal);
      active(signal);
      return { locator, entry: current, original };
    },
  };
}
