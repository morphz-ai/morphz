import {
  guardCognitiveAppApplicationCommand,
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../../packages/core/src/cognitive-app-application-target.js";
import {
  guardCognitiveAppInputCommand,
  parseCognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import {
  isPortableText,
  parseWireJson,
} from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import type { InputDraft } from "./exchange-drafts.js";
import {
  cognitiveWorkSurfaceKey,
  type CognitiveWorkSurface,
} from "./work-surface.js";

/** Borrowed live Host facts, not a stored preference, grant or execution permit.
 * The Host calls this leaf inside its existing latest-state draft updater. */
export type CognitiveApplicationChoiceScope = Readonly<{
  projectId: string;
  expectedContextKey: string;
  currentContextKey: string;
  artifactId?: string | null;
  cognitiveSurface?: CognitiveWorkSurface | null;
}>;
export type CognitiveApplicationChoiceResult =
  { ok: true; draft: InputDraft } | { ok: false; error: string };

/** Pure explicit selection/clear only. No catalog lookup, authority claim,
 * writer, navigation, Session, network, input submission or object manufacture. */
export function chooseCognitiveApplication(
  draft: InputDraft,
  selected: CognitiveAppApplicationTarget | null,
  inputScope: CognitiveApplicationChoiceScope,
): CognitiveApplicationChoiceResult {
  try {
    // Inspect additive slots before spreading any legacy carrier. Do not apply
    // the SDK wire budget to legacy body/attachments/quotes or optional fields.
    guardCognitiveAppInputCommand({ operation: draft });
    guardCognitiveAppApplicationCommand({ operation: draft });
    const target =
      selected === null
        ? undefined
        : parseCognitiveAppApplicationTarget(selected);
    const scope = JSON.parse(
      JSON.stringify(parseWireJson(inputScope)),
    ) as CognitiveApplicationChoiceScope;
    if (
      Object.keys(scope).some(
        (key) =>
          ![
            "projectId",
            "expectedContextKey",
            "currentContextKey",
            "artifactId",
            "cognitiveSurface",
          ].includes(key),
      ) ||
      typeof scope.projectId !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(scope.projectId) ||
      typeof scope.expectedContextKey !== "string" ||
      !scope.expectedContextKey ||
      scope.expectedContextKey !== scope.currentContextKey ||
      (scope.artifactId !== undefined &&
        scope.artifactId !== null &&
        (typeof scope.artifactId !== "string" ||
          !scope.artifactId ||
          !isPortableText(scope.artifactId))) ||
      (scope.cognitiveSurface !== undefined &&
        scope.cognitiveSurface !== null &&
        (typeof scope.cognitiveSurface !== "object" ||
          Array.isArray(scope.cognitiveSurface)))
    )
      return { ok: false, error: "输入工作范围已有变化，原草稿已保留。" };
    if (
      scope.artifactId ||
      draft.continuation ||
      draft.pendingSupplement ||
      draft.continuationFailure ||
      draft.annotation ||
      draft.taskResult ||
      draft.reading ||
      draft.scriptGeneration ||
      draft.selection ||
      draft.revision != null ||
      draft.page !== undefined
    )
      return {
        ok: false,
        error: "原输入中已有来源或专用请求，请先处理原请求；原草稿已保留。",
      };
    const objectSlot = Object.getOwnPropertyDescriptor(
      draft,
      "cognitiveObject",
    );
    const original =
      objectSlot?.value !== undefined
        ? parseCognitiveAppObjectLocator(objectSlot.value)
        : undefined;
    let surfaceTarget: CognitiveAppApplicationTarget | undefined;
    const surface = scope.cognitiveSurface;
    if (surface) {
      if (surface.kind === "original") {
        const locator = parseCognitiveAppObjectLocator(surface.locator);
        if (
          locator.projectId !== scope.projectId ||
          (original &&
            cognitiveWorkSurfaceKey({ kind: "original", locator: original }) !==
              cognitiveWorkSurfaceKey({ kind: "original", locator }))
        )
          return { ok: false, error: "原件工作范围已有变化，原草稿已保留。" };
        surfaceTarget = parseCognitiveAppApplicationTarget({
          connectionId: locator.connectionId,
          authority: locator.authority,
        });
      } else if (
        surface.kind === "view" &&
        surface.projectId === scope.projectId &&
        typeof surface.viewId === "string" &&
        /^[A-Za-z0-9_-]{1,100}$/.test(surface.viewId)
      ) {
        surfaceTarget = parseCognitiveAppApplicationTarget({
          connectionId: surface.connectionId,
          authority: surface.authority,
        });
      } else throw Error("Invalid cognitive surface");
    }
    const originalTarget = original
      ? parseCognitiveAppApplicationTarget({
          connectionId: original.connectionId,
          authority: original.authority,
        })
      : undefined;
    if (
      (original && original.projectId !== scope.projectId) ||
      (originalTarget &&
        surfaceTarget &&
        !sameCognitiveAppApplicationTarget(originalTarget, surfaceTarget)) ||
      (target &&
        originalTarget &&
        !sameCognitiveAppApplicationTarget(target, originalTarget)) ||
      (target &&
        surfaceTarget &&
        !sameCognitiveAppApplicationTarget(target, surfaceTarget))
    )
      return {
        ok: false,
        error: "应用目标与原件工作范围不一致，原草稿已保留。",
      };
    const { cognitiveApplication: _old, ...rest } = draft;
    return {
      ok: true,
      draft: target ? { ...rest, cognitiveApplication: target } : rest,
    };
  } catch {
    return { ok: false, error: "应用目标或输入工作范围无效，原草稿已保留。" };
  }
}
