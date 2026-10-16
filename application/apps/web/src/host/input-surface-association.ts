import type { InputDraft } from "./exchange-drafts.js";
import type { ExchangeSubmissionContext } from "./submit-exchange-draft.js";

type AssociationDraft = Pick<
  InputDraft,
  | "detachedAssociation"
  | "continuation"
  | "selection"
  | "reading"
  | "cognitiveObject"
  | "cognitiveApplication"
  | "scriptGeneration"
>;

/** Disabling automatic association does not discard a later explicit source
 * selection. Once that message is consumed, ordinary chat remains unbound. */
export function inputSurfaceDetached(draft: AssociationDraft): boolean {
  // This policy runs before source admission: do not evaluate a getter or
  // hide a malformed/inherited source that the existing guards must reject.
  if (
    Object.getOwnPropertyDescriptor(draft, "detachedAssociation")?.value !==
    true
  )
    return false;
  for (const key of [
    "continuation",
    "selection",
    "reading",
    "cognitiveObject",
    "cognitiveApplication",
    "scriptGeneration",
  ] as const) {
    const slot = Object.getOwnPropertyDescriptor(draft, key);
    if ((slot && (!("value" in slot) || slot.value)) || (!slot && key in draft))
      return false;
  }
  return true;
}

/** Unlinking a surface is a local input choice, never a navigation, Session,
 * authority or cancellation operation. Explicit supplements keep their source. */
export function inputSurfaceContext(
  context: ExchangeSubmissionContext,
  draft: AssociationDraft,
): ExchangeSubmissionContext {
  if (!inputSurfaceDetached(draft)) return context;
  return {
    ...context,
    artifact: undefined,
    activeInstance: undefined,
    browserPage: null,
    cognitiveSurface: null,
    readingExpected: false,
    currentReading: null,
  };
}

export function detachComposerAssociation(draft: InputDraft): InputDraft {
  if (
    draft.continuation ||
    draft.pendingSupplement ||
    draft.taskResult ||
    draft.intent ||
    draft.scriptGeneration
  )
    return draft;
  const {
    cognitiveApplication: _application,
    cognitiveObject: _object,
    reading: _reading,
    page: _page,
    ...rest
  } = draft;
  return {
    ...rest,
    detachedAssociation: true,
    selection: "",
    revision: null,
    annotation: false,
    skipReading: true,
  };
}
