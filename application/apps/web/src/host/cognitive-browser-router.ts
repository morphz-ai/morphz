import {
  parseBrowserContext,
  parseBrowserRequest,
  parseBrowserResult,
  type BrowserContext,
  type BrowserRequest,
  type BrowserHostErrorCode,
} from "../../../../packages/cognitive-app-sdk/src/browser-wire.js";
import { canonicalJsonBytes } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import type { OperationResourceReference } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import type { ApplicationMethod } from "../../../../packages/core/src/application-api.js";
import type { CallOptions } from "../../../../packages/core/src/http-application-client.js";

/** Trusted presentation ports only. A guest supplies none of these. The two
 * object owners must resolve the real catalog locator, preserve opaque versions,
 * and acknowledge their original navigation/unsent-draft owner. They may not
 * manufacture a content ID from an author's object ID or submit an input. */
export interface CognitiveBrowserRouterPorts {
  call(
    method: ApplicationMethod,
    parameters: unknown,
    options: CallOptions,
  ): Promise<unknown>;
  openObject(
    request: {
      source: CognitiveAppViewUi;
      object: OperationResourceReference;
    },
    signal: AbortSignal,
  ): Promise<{ opened: true; object: OperationResourceReference }>;
  compose(
    request: {
      source: CognitiveAppViewUi;
      text: string;
      object?: OperationResourceReference;
    },
    signal: AbortSignal,
  ): Promise<{ prepared: true }>;
}
class RouterError extends Error {
  constructor(readonly code: BrowserHostErrorCode) {
    super("Cognitive browser request cannot use this view.");
  }
}
const equal = (a: unknown, b: unknown) =>
  new TextDecoder().decode(canonicalJsonBytes(a)) ===
  new TextDecoder().decode(canonicalJsonBytes(b));
const requireMatch = (condition: unknown, code: BrowserHostErrorCode) => {
  if (!condition) throw new RouterError(code);
};

/** Fixed eight-operation mapping. Public Human services still own authority,
 * mutations and receipts; this leaf never calls Agent tools or legacy UI RPC.
 * Wire validity is not an authorization. Every request crosses the current
 * same-view readUi gate before and after the work, including owner callbacks. */
export function createCognitiveBrowserRouter(
  initial: CognitiveAppViewUi,
  ports: CognitiveBrowserRouterPorts,
) {
  const fixed = parseCognitiveAppViewResponse("readUi", initial);
  const compose = fixed.manifest.permissions.includes("input.compose");
  const target = {
    projectId: fixed.binding.projectId,
    appId: fixed.binding.appId,
    version: fixed.binding.version,
    connectionId: fixed.binding.connectionId,
    expectedDefinitionHash: fixed.authority.definitionHash,
    expectedGrantRevision: fixed.grantRevision,
    expectedConnectionRevision: fixed.connectionRevision,
  };
  // Status/recovery retain the original command's scope. Neither creates a
  // replacement command or silently repeats invoke.
  const commandTarget = {
    projectId: target.projectId,
    appId: target.appId,
    version: target.version,
    connectionId: target.connectionId,
    expectedDefinitionHash: target.expectedDefinitionHash,
  };
  function scope(input: BrowserContext, requireActive = true): BrowserContext {
    const context = parseBrowserContext(input);
    requireMatch(
      equal(context.definition, fixed.definition) &&
        equal(context.authority, fixed.authority) &&
        context.view.id === fixed.view.id &&
        context.view.bindingRevision === fixed.binding.revision &&
        context.ui.compose === compose,
      "forbidden",
    );
    if (requireActive) requireMatch(context.view.active, "forbidden");
    return context;
  }
  function active(signal: AbortSignal) {
    if (signal.aborted) throw new RouterError("unavailable");
  }
  async function authorize(input: BrowserContext, signal: AbortSignal) {
    // Hidden presentation still needs current metadata authorization to keep
    // this document warm. Operation admission separately requires active=true.
    const context = scope(input, false);
    active(signal);
    const current = parseCognitiveAppViewResponse(
      "readUi",
      await ports.call(
        "cognitive-app-views.read-ui",
        {
          viewId: fixed.view.id,
          expectedViewRevision: context.view.revision,
          expectedBindingRevision: fixed.binding.revision,
        },
        { signal },
      ),
    );
    active(signal);
    requireMatch(
      equal(current.definition, fixed.definition) &&
        equal(current.authority, fixed.authority) &&
        current.binding.projectId === fixed.binding.projectId &&
        current.binding.connectionId === fixed.binding.connectionId &&
        current.binding.revision === fixed.binding.revision &&
        current.view.id === fixed.view.id &&
        current.view.revision === context.view.revision &&
        equal(current.view.state, context.view.state) &&
        current.grantRevision === fixed.grantRevision &&
        current.connectionRevision === fixed.connectionRevision &&
        current.manifest.permissions.includes("input.compose") === compose,
      "conflict",
    );
    return current;
  }
  return {
    /** Host selects visibility/theme/return geometry; the guest cannot retarget
     * the authority. A persisted UI read supplies exact initial navigation. */
    context(
      presentation: Pick<BrowserContext, "theme" | "presentation"> & {
        active: boolean;
      },
    ): BrowserContext {
      return parseBrowserContext({
        definition: fixed.definition,
        authority: fixed.authority,
        view: {
          id: fixed.view.id,
          revision: fixed.view.revision,
          bindingRevision: fixed.binding.revision,
          active: presentation.active,
          state: fixed.view.state,
        },
        ui: { compose },
        theme: presentation.theme,
        presentation: presentation.presentation,
      });
    },
    async authorize(context: BrowserContext, signal: AbortSignal) {
      await authorize(context, signal);
    },
    async request(
      raw: BrowserRequest,
      input: BrowserContext,
      signal: AbortSignal,
    ) {
      // Independent finite snapshots precede the first service await. No
      // mutable latest-view slot is shared between concurrent requests.
      const context = scope(input);
      const request = parseBrowserRequest(raw, context);
      if (request.method === "compose") requireMatch(compose, "forbidden");
      if (request.method === "saveState")
        requireMatch(
          request.expectedRevision === context.view.revision,
          "conflict",
        );
      const source = await authorize(context, signal);
      active(signal);
      let result: unknown;
      let end = context;
      switch (request.method) {
        case "ready":
          result = context;
          break;
        case "invoke":
          result = await ports.call(
            "cognitive-apps.invoke",
            structuredClone({
              ...target,
              operationId: request.operationId,
              parameters: request.parameters,
              resources: request.resources,
              commandId: request.commandId,
            }),
            { signal },
          );
          break;
        case "readObject":
          result = await ports.call(
            "cognitive-apps.read-object",
            structuredClone({
              ...target,
              object: request.object,
              maxBytes: request.maxBytes,
            }),
            { signal },
          );
          break;
        case "commandStatus":
        case "recoverReceipt":
          result = await ports.call(
            request.method === "commandStatus"
              ? "cognitive-apps.command-status"
              : "cognitive-apps.recover",
            { ...commandTarget, commandId: request.commandId },
            { signal },
          );
          break;
        case "openObject": {
          result = await ports.openObject(
            structuredClone({ source, object: request.object }),
            signal,
          );
          break;
        }
        case "compose": {
          result = await ports.compose(
            structuredClone({
              source,
              text: request.text,
              ...(request.object ? { object: request.object } : {}),
            }),
            signal,
          );
          break;
        }
        case "saveState": {
          const response = parseCognitiveAppViewResponse(
            "save",
            await ports.call(
              "cognitive-app-views.save",
              structuredClone({
                viewId: fixed.view.id,
                expectedViewRevision: request.expectedRevision,
                expectedBindingRevision: fixed.binding.revision,
                commandId: crypto.randomUUID(),
                state: request.state,
              }),
              { signal },
            ),
          );
          requireMatch(
            response.receipt.viewId === fixed.view.id &&
              response.receipt.bindingRevision === fixed.binding.revision &&
              response.receipt.viewRevision === request.expectedRevision + 1,
            "contract",
          );
          // This is the original receipt + original state, not a later read
          // impersonating that acknowledgement. Later changes fail the gate.
          result = {
            revision: response.receipt.viewRevision,
            state: request.state,
          };
          end = parseBrowserContext({
            ...context,
            view: {
              ...context.view,
              revision: response.receipt.viewRevision,
              state: request.state,
            },
          });
          break;
        }
      }
      active(signal);
      let checked: ReturnType<typeof parseBrowserResult>;
      try {
        checked = parseBrowserResult(request, result, context);
      } catch {
        throw new RouterError("contract");
      }
      await authorize(end, signal);
      active(signal);
      return checked;
    },
  };
}
