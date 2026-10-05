import {
  guardCognitiveAppInputCommand,
  parseCognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import { parseDomainAuthority } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import type { InputDraft } from "./exchange-drafts.js";
import {
  guardCognitiveAppApplicationCommand,
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
} from "../../../../packages/core/src/cognitive-app-application-target.js";
import {
  cognitiveWorkSurfaceKey,
  type CognitiveWorkSurface,
} from "./work-surface.js";

export type CognitiveDraftSourceResult =
  { ok: true; draft: InputDraft } | { ok: false; error: string };

/** Pin an unsent ordinary input at the actual Human editing boundary. This
 * synchronous pure helper neither writes a draft nor sends/authorizes work.
 * The existing latest-state writer must publish/ACK its result itself. */
export function pinCognitiveDraftOriginal(
  draft: InputDraft,
  surface: CognitiveWorkSurface | null | undefined,
): CognitiveDraftSourceResult {
  try {
    // Inspect the new independent slot before any spread or field access.
    // Never apply a whole-carrier wire budget to old drafts/quotes/attachments.
    guardCognitiveAppInputCommand({ operation: draft });
    guardCognitiveAppApplicationCommand({ operation: draft });
    if (
      !surface ||
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
    )
      return { ok: true, draft };
    const slot = Object.getOwnPropertyDescriptor(draft, "cognitiveObject");
    const applicationSlot = Object.getOwnPropertyDescriptor(
      draft,
      "cognitiveApplication",
    );
    const target =
      applicationSlot?.value !== undefined
        ? parseCognitiveAppApplicationTarget(applicationSlot.value)
        : undefined;
    // An unused legacy surface is not part of an empty input. Preserve the
    // original early no-op; only an explicit target requires new coherence.
    if (
      !target &&
      !slot?.value &&
      !draft.body.trim() &&
      !draft.attachments?.length
    )
      return { ok: true, draft };
    const source: CognitiveWorkSurface = JSON.parse(
      JSON.stringify(parseWireJson(surface)),
    );
    if (source.kind !== "view" && source.kind !== "original")
      throw new Error("Invalid cognitive source");
    const original =
      source.kind === "original"
        ? parseCognitiveAppObjectLocator(source.locator)
        : undefined;
    if (
      target &&
      !sameCognitiveAppApplicationTarget(
        target,
        source.kind === "original"
          ? {
              connectionId: original!.connectionId,
              authority: original!.authority,
            }
          : {
              connectionId: source.connectionId,
              authority: parseDomainAuthority(source.authority),
            },
      )
    )
      return {
        ok: false,
        error: "应用目标与原件工作范围不一致，原草稿已保留。",
      };
    if (!slot?.value && !draft.body.trim() && !draft.attachments?.length)
      return { ok: true, draft };
    const pinned =
      slot?.value !== undefined
        ? parseCognitiveAppObjectLocator(slot.value)
        : original;
    if (!pinned) return { ok: true, draft };
    if (
      target &&
      !sameCognitiveAppApplicationTarget(target, {
        connectionId: pinned.connectionId,
        authority: pinned.authority,
      })
    )
      return {
        ok: false,
        error: "应用目标与原件工作范围不一致，原草稿已保留。",
      };
    if (
      (original &&
        cognitiveWorkSurfaceKey({ kind: "original", locator: pinned }) !==
          cognitiveWorkSurfaceKey({ kind: "original", locator: original })) ||
      (source.kind === "view" &&
        (source.projectId !== pinned.projectId ||
          source.connectionId !== pinned.connectionId ||
          JSON.stringify(parseDomainAuthority(source.authority)) !==
            JSON.stringify(pinned.authority)))
    )
      return { ok: false, error: "原件工作范围已有变化，原草稿已保留。" };
    return { ok: true, draft: { ...draft, cognitiveObject: pinned } };
  } catch {
    return { ok: false, error: "原件引用无效，原草稿已保留。" };
  }
}
