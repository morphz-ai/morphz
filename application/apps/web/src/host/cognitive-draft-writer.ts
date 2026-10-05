import {
  guardCognitiveAppInputCommand,
  parseCognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import { parseDomainAuthority } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import type {
  createExchangeDraftCommands,
  InputDraft,
} from "./exchange-drafts.js";
import { pinCognitiveDraftOriginal } from "./cognitive-draft-source.js";
import {
  cognitiveWorkSurfaceKey,
  type CognitiveWorkSurface,
} from "./work-surface.js";

type Drafts = Record<string, InputDraft>;
type Writer = ReturnType<typeof createExchangeDraftCommands>["writeInputs"];
export type CognitiveDraftWriterScope = Readonly<{
  key: string;
  surface: CognitiveWorkSurface;
}>;

function special(draft: InputDraft) {
  return !!(
    draft.continuation ||
    draft.continuationFailure ||
    draft.pendingSupplement ||
    draft.taskResult ||
    draft.scriptGeneration ||
    draft.annotation ||
    draft.reading ||
    draft.selection ||
    draft.revision != null ||
    draft.page !== undefined
  );
}
function snapshotScope(
  input: CognitiveDraftWriterScope,
): CognitiveDraftWriterScope {
  const value = JSON.parse(
    JSON.stringify(parseWireJson(input)),
  ) as CognitiveDraftWriterScope;
  let surface: CognitiveWorkSurface;
  if (value.surface.kind === "original") {
    surface = Object.freeze({
      kind: "original",
      locator: parseCognitiveAppObjectLocator(value.surface.locator),
    });
  } else if (value.surface.kind === "view") {
    surface = Object.freeze({
      kind: "view",
      projectId: value.surface.projectId,
      viewId: value.surface.viewId,
      connectionId: value.surface.connectionId,
      authority: Object.freeze(parseDomainAuthority(value.surface.authority)),
    });
  } else throw new Error("Invalid cognitive surface");
  const suffix = ":cognitive:" + cognitiveWorkSurfaceKey(surface);
  if (typeof value.key !== "string" || !value.key.endsWith(suffix))
    throw new Error("Cognitive draft key does not match its owner");
  return Object.freeze({ key: value.key, surface });
}

/** Decorate the existing public functional writer, never its storage/setter.
 * Capture trusted current owner facts synchronously at the editing boundary,
 * then pin against the writer's actual latest draft. Returns void, not a
 * preparation/persistence ACK; a caller needing one must observe publication.
 * Current Human authorization and retirement remain with the actual owner.
 */
export function createCognitiveDraftWriter({
  writeInputs,
  captureScope,
  onError,
}: {
  writeInputs: Writer;
  captureScope(): CognitiveDraftWriterScope | null | undefined;
  onError(message: string): void;
}): Writer {
  const report = (message: string) => {
    try {
      onError(message);
    } catch {
      /* Feedback failure never authorizes a write. */
    }
  };
  return (update) => {
    let scope: CognitiveDraftWriterScope | undefined;
    try {
      const current = captureScope();
      scope = current ? snapshotScope(current) : undefined;
    } catch {
      report("原件工作范围无效，原草稿已保留。");
      return;
    }
    if (!scope) return writeInputs(update);
    const captured = scope;
    writeInputs((previous) => {
      const next = update(previous),
        candidate = next[captured.key],
        old = previous[captured.key];
      if (!candidate || candidate === old) return next;
      const refuse = (message: string): Drafts => {
        report(message);
        const kept = { ...next };
        if (old) kept[captured.key] = old;
        else delete kept[captured.key];
        return kept;
      };
      try {
        guardCognitiveAppInputCommand({ operation: candidate });
        // Cleanup and specialized operations retain their exact old behavior.
        if (
          special(candidate) ||
          (!candidate.body.trim() && !candidate.attachments?.length)
        )
          return next;
        if (old) guardCognitiveAppInputCommand({ operation: old });
        const changed =
          !old ||
          candidate.body !== old.body ||
          candidate.attachments !== old.attachments;
        const oldSlot =
          old && Object.getOwnPropertyDescriptor(old, "cognitiveObject");
        if (!changed && !oldSlot?.value) return next;
        let prepared = candidate;
        if (oldSlot?.value !== undefined) {
          const original = parseCognitiveAppObjectLocator(oldSlot.value);
          const nextSlot = Object.getOwnPropertyDescriptor(
            candidate,
            "cognitiveObject",
          );
          if (
            nextSlot?.value !== undefined &&
            cognitiveWorkSurfaceKey({
              kind: "original",
              locator: parseCognitiveAppObjectLocator(nextSlot.value),
            }) !==
              cognitiveWorkSurfaceKey({ kind: "original", locator: original })
          )
            return refuse("原件工作范围已有变化，原草稿已保留。");
          prepared = { ...candidate, cognitiveObject: original };
        }
        const result = pinCognitiveDraftOriginal(prepared, captured.surface);
        if (!result.ok) return refuse(result.error);
        if (result.draft === candidate) return next;
        return { ...next, [captured.key]: result.draft };
      } catch {
        return refuse("原件引用无效，原草稿已保留。");
      }
    });
  };
}
