import {
  sameCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../packages/core/src/cognitive-app-application-target.js";
import type { InputIntent } from "../../../packages/core/src/input-intent.js";
import {
  cognitiveApplicationTargets,
  type ApplicationPresentationDirectory,
} from "./application-presentation.js";
import {
  chooseCognitiveApplication,
  type CognitiveApplicationChoiceScope,
} from "./host/cognitive-application-choice.js";
import type { InputDraft } from "./host/exchange-drafts.js";

export const builtinCreationIntents: readonly Readonly<{
  intent: InputIntent;
  label: string;
  application: string;
}>[] = Object.freeze([
  { intent: "script", label: "构思剧本", application: "剧本工作室" },
  { intent: "task", label: "新建事项", application: "事项" },
  { intent: "document", label: "起草文档", application: "内容库" },
]);
export type CognitiveCreationIntent = Readonly<{
  operationId: string;
  label: string;
  prompt?: string;
}>;
export type CognitiveCreationChoice = Readonly<{
  key: string;
  application: string;
  intent: CognitiveCreationIntent;
  target: CognitiveAppApplicationTarget;
  connectionLabel: string;
}>;

/** One authenticated directory projection. A write effect alone does not
 * declare creation; no GUI is required and no first connection is selected. */
export function cognitiveCreationChoices(
  directory: ApplicationPresentationDirectory,
): readonly CognitiveCreationChoice[] {
  return directory.quickEntries.flatMap((entry) =>
    entry.kind !== "cognitive" || entry.inputAvailability !== "selectable"
      ? []
      : (entry.metadata.creationIntents ?? []).flatMap((intent) =>
          cognitiveApplicationTargets(entry).map((target) => ({
            key: `${entry.key}/${intent.operationId}/${target.connectionId}`,
            application: `${entry.metadata.title} · ${entry.metadata.version}`,
            intent,
            target,
            connectionLabel: entry.connections.find(
              (connection) => connection.connectionId === target.connectionId,
            )!.dataAuthorityId,
          })),
        ),
  );
}

/** Same draft/application selection carrier, with visible editable user text.
 * The operationId identifies discovery only; IO freezes the app target, not a
 * forced tool invocation. No object, Session, side effect or permission write. */
export function prepareCognitiveCreation(
  draft: InputDraft,
  choice: CognitiveCreationChoice,
  scope: CognitiveApplicationChoiceScope,
) {
  if (cognitiveCreationConflicts(draft, choice, scope))
    return {
      ok: false as const,
      error:
        "当前输入已关联应用或原件，请先处理原草稿，再准备新建。原草稿已保留。",
    };
  if (draft.body.length || draft.intent)
    return {
      ok: false as const,
      error:
        "输入框中有未发送内容或意图，请先处理原草稿，再准备新建。原草稿已保留。",
    };
  const selected = chooseCognitiveApplication(draft, choice.target, scope);
  if (!selected.ok) return selected;
  return {
    ok: true as const,
    draft: {
      ...selected.draft,
      body:
        choice.intent.prompt ??
        `请使用「${choice.application}」的「${choice.intent.label}」能力，帮我准备新的内容。`,
    },
  };
}

/** A normal chosen app/view may create in its same exact authority. An original
 * or a different explicit target must never be silently replaced by +. */
export function cognitiveCreationConflicts(
  draft: InputDraft,
  choice: CognitiveCreationChoice,
  scope: CognitiveApplicationChoiceScope,
) {
  const surface = scope.cognitiveSurface;
  return (
    !!draft.cognitiveObject ||
    surface?.kind === "original" ||
    (!!draft.cognitiveApplication &&
      !sameCognitiveAppApplicationTarget(
        draft.cognitiveApplication,
        choice.target,
      )) ||
    (!!surface &&
      surface.kind === "view" &&
      !sameCognitiveAppApplicationTarget(
        { connectionId: surface.connectionId, authority: surface.authority },
        choice.target,
      ))
  );
}

/** Built-in shortcuts use the existing removable InputIntent carrier. Keep
 * ordinary ideas/materials intact; never redirect a dedicated original or an
 * explicitly chosen third-party Harness into a different creation workflow. */
export function prepareBuiltinCreation(draft: InputDraft, intent: InputIntent) {
  if (!builtinCreationIntents.some((entry) => entry.intent === intent))
    return { ok: false as const, error: "新建意图无效，原草稿已保留。" };
  if (
    draft.pendingSupplement ||
    draft.continuation ||
    draft.continuationFailure ||
    draft.annotation ||
    draft.taskResult ||
    draft.scriptGeneration ||
    draft.reading ||
    draft.cognitiveApplication ||
    draft.cognitiveObject
  )
    return {
      ok: false as const,
      error:
        "当前输入已关联专用工作，请先处理原草稿，再选择新建。原草稿已保留。",
    };
  return { ok: true as const, draft: { ...draft, intent } };
}
