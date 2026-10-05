import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import {
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
} from "../../../../packages/core/src/cognitive-app-application-target.js";
import {
  guardCognitiveAppInputCommand,
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import { canonicalJsonBytes } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  parseBrowserRequest,
  type BrowserContext,
} from "../../../../packages/cognitive-app-sdk/src/browser-wire.js";
import type { OperationResourceReference } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import { updateComposerDraft } from "../composer-drafts.js";
import { chooseCognitiveApplication } from "./cognitive-application-choice.js";
import {
  cognitiveWorkSurfaceKey,
  type CognitiveWorkSurface,
} from "./work-surface.js";
import type {
  createExchangeDraftCommands,
  InputDraft,
} from "./exchange-drafts.js";

export type CognitiveComposeScope = Readonly<{
  key: string;
  surface: Extract<CognitiveWorkSurface, { kind: "view" }>;
  viewRevision: number;
  bindingRevision: number;
}>;
export type CognitiveViewComposeRequest = Readonly<{
  source: CognitiveAppViewUi;
  text: string;
  object?: OperationResourceReference;
}>;
type PreparedRequest = Readonly<{
  source: CognitiveAppViewUi;
  text: string;
  locator?: CognitiveAppObjectLocator;
}>;
type DraftResult =
  | { ok: true; draft: InputDraft; bodyChanged: boolean }
  | { ok: false; error: string };
const same = (a: unknown, b: unknown) => {
  const left = canonicalJsonBytes(a),
    right = canonicalJsonBytes(b);
  return left.length === right.length && left.every((n, i) => n === right[i]);
};
const changed = "应用工作范围已有变化，原草稿已保留。";

function expectedSurface(
  source: CognitiveAppViewUi,
): CognitiveComposeScope["surface"] {
  return {
    kind: "view",
    projectId: source.binding.projectId,
    viewId: source.view.id,
    connectionId: source.binding.connectionId,
    authority: source.authority,
  };
}
function scopeMatches(
  scope: CognitiveComposeScope,
  source: CognitiveAppViewUi,
) {
  return (
    scope.viewRevision === source.view.revision &&
    scope.bindingRevision === source.binding.revision &&
    same(scope.surface, expectedSurface(source)) &&
    scope.key.endsWith(":cognitive:" + cognitiveWorkSurfaceKey(scope.surface))
  );
}

/** Pure latest-draft transformation, not a view authorization or publication
 * acknowledgement. Borrowed Host scope must come from its actual live owner. */
export function composeCognitiveViewDraft(
  latest: InputDraft,
  request: PreparedRequest,
  scope: CognitiveComposeScope,
): DraftResult {
  try {
    const source = parseCognitiveAppViewResponse("readUi", request.source);
    if (
      !scopeMatches(scope, source) ||
      !source.manifest.permissions.includes("input.compose")
    )
      return { ok: false, error: changed };
    guardCognitiveAppInputCommand({ operation: latest });
    const target = parseCognitiveAppApplicationTarget({
      connectionId: source.binding.connectionId,
      authority: source.authority,
    });
    const previousTarget = Object.getOwnPropertyDescriptor(
      latest,
      "cognitiveApplication",
    );
    if (
      previousTarget?.value !== undefined &&
      !sameCognitiveAppApplicationTarget(previousTarget.value, target)
    )
      return { ok: false, error: "原输入已选择另一应用，原草稿已保留。" };
    if (latest.intent !== undefined)
      return { ok: false, error: "原输入中已有专用意图，原草稿已保留。" };
    const selected = chooseCognitiveApplication(latest, target, {
      projectId: source.binding.projectId,
      expectedContextKey: scope.key,
      currentContextKey: scope.key,
      cognitiveSurface: scope.surface,
    });
    if (!selected.ok) return selected;
    if (typeof request.text !== "string" || typeof latest.body !== "string")
      return { ok: false, error: "应用输入格式无效，原草稿已保留。" };
    const body = [latest.body, request.text].filter(Boolean).join("\n");
    if (body.length > 30000)
      return { ok: false, error: "追加后正文超过 30000 字，原草稿已保留。" };
    const previousSlot = Object.getOwnPropertyDescriptor(
      latest,
      "cognitiveObject",
    );
    const old =
      previousSlot?.value === undefined
        ? undefined
        : parseCognitiveAppObjectLocator(previousSlot.value);
    const locator =
      request.locator === undefined
        ? undefined
        : parseCognitiveAppObjectLocator(request.locator);
    if (
      locator &&
      (locator.projectId !== source.binding.projectId ||
        locator.connectionId !== source.binding.connectionId ||
        !same(locator.authority, source.authority) ||
        (old && !same(old, locator)))
    )
      return { ok: false, error: "原输入已绑定不同原件或版本，原草稿已保留。" };
    return {
      ok: true,
      draft: {
        ...selected.draft,
        body,
        ...(locator ? { cognitiveObject: locator } : {}),
      },
      bodyChanged: body !== latest.body,
    };
  } catch {
    return { ok: false, error: "应用来源或输入格式无效，原草稿已保留。" };
  }
}

class ComposeError extends Error {
  constructor(
    readonly code: "conflict" | "forbidden" | "invalid" | "unavailable",
  ) {
    super(
      "Cognitive input preparation did not publish to its original live owner.",
    );
  }
}

/** Uses the original public functional draft writer and actual committed
 * publication witness. No new draft store, input send, numeric version coercion,
 * navigation, grant or durable-save claim. The mounting Host must supply real
 * navigation incarnation/generation, identity, persistent draft owner and view
 * premises in isCurrent, including inside the deferred React updater. */
export function createCognitiveComposePreparation(ports: {
  captureScope(source: CognitiveAppViewUi): Readonly<{
    scope: CognitiveComposeScope;
    isCurrent(): boolean;
  }> | null;
  locatorForView(
    source: CognitiveAppViewUi,
    object: OperationResourceReference,
    signal: AbortSignal,
  ): Promise<CognitiveAppObjectLocator>;
  writeInputs: ReturnType<typeof createExchangeDraftCommands>["writeInputs"];
  flushSync(run: () => void): void;
  publishedDraft(key: string): InputDraft | undefined;
  emptyDraft: InputDraft;
  onPrepared?(bodyChanged: boolean): void;
}) {
  return async (
    raw: CognitiveViewComposeRequest,
    signal: AbortSignal,
  ): Promise<{ prepared: true }> => {
    let source: CognitiveAppViewUi;
    let request: Extract<
      ReturnType<typeof parseBrowserRequest>,
      { method: "compose" }
    >;
    try {
      source = parseCognitiveAppViewResponse("readUi", raw.source);
      const context: BrowserContext = {
        definition: source.definition,
        authority: source.authority,
        view: {
          id: source.view.id,
          revision: source.view.revision,
          bindingRevision: source.binding.revision,
          active: true,
          state: source.view.state,
        },
        ui: { compose: source.manifest.permissions.includes("input.compose") },
        theme: { appearance: "light", accent: "iris" },
        presentation: { mode: "workspace", returnControl: null },
      };
      request = parseBrowserRequest(
        {
          method: "compose",
          text: raw.text,
          ...(raw.object === undefined ? {} : { object: raw.object }),
        },
        context,
      ) as typeof request;
    } catch {
      throw new ComposeError("invalid");
    }
    if (!source.manifest.permissions.includes("input.compose"))
      throw new ComposeError("forbidden");
    // The captured scope is detached; it cannot mutate while locator resolution awaits.
    let scope: CognitiveComposeScope;
    let current: () => boolean;
    try {
      const lease = ports.captureScope(source);
      if (!lease) throw new ComposeError("conflict");
      current = lease.isCurrent;
      scope = structuredClone(lease.scope);
      if (!scopeMatches(scope, source)) throw new ComposeError("conflict");
    } catch {
      throw new ComposeError("conflict");
    }
    const active = () => {
      if (signal.aborted) throw new ComposeError("unavailable");
      if (!current()) throw new ComposeError("conflict");
    };
    active();
    const locator = request.object
      ? await ports.locatorForView(source, request.object, signal)
      : undefined;
    active();
    if (request.object && (!locator || !same(locator.object, request.object)))
      throw new ComposeError("conflict");
    // StrictMode may evaluate an updater again only for purity checking while
    // publishing its earlier eager result. Track actual candidates, never the
    // last evaluated candidate or structurally equal/rendered draft as an ACK.
    const proposals = new WeakMap<InputDraft, boolean>();
    let refusal = false;
    let preparing = true;
    try {
      ports.flushSync(() =>
        ports.writeInputs((previous) => {
          // A retired/deferred updater returns the exact previous map, not an empty
          // quote bucket or a successful result computed from a render snapshot.
          try {
            if (!preparing) return previous;
            active();
          } catch {
            refusal = true;
            return previous;
          }
          const quotesKey = scope.key.split(":")[0] + ":quotes";
          const latest = {
            ...(previous[scope.key] ?? ports.emptyDraft),
            textQuotes: previous[quotesKey]?.textQuotes ?? [],
          };
          const prepared = composeCognitiveViewDraft(
            latest,
            { source, text: request.text, locator },
            scope,
          );
          if (!prepared.ok) {
            refusal = true;
            return previous;
          }
          const next = updateComposerDraft(
            previous,
            scope.key,
            ports.emptyDraft,
            () => prepared.draft,
          );
          proposals.set(next[scope.key]!, prepared.bodyChanged);
          return next;
        }),
      );
    } finally {
      // A writer which did not actually commit inside flush cannot apply its
      // captured callback later after the caller has already been refused.
      preparing = false;
    }
    active();
    if (refusal) throw new ComposeError("conflict");
    const published = ports.publishedDraft(scope.key);
    active();
    if (!published || !proposals.has(published))
      throw new ComposeError("unavailable");
    try {
      ports.onPrepared?.(proposals.get(published)!);
    } catch {
      /* UI feedback is not authority. */
    }
    active();
    return { prepared: true };
  };
}
