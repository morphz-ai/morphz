import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MessageCircleQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UserInputAnswer } from "../../../sdk/typescript/src/user-input.ts";
import { DashboardApiError } from "../api/client";
import { DASHBOARD_API } from "../api/runtime";
import { CORE_HTTP_URL } from "../api/deployment";
import {
  currentQuestion,
  forgetQuestionForm,
  questionCommand,
  questionKey,
  readQuestionForms,
  saveQuestionForm,
  forgetLegacyQuestionForm,
  legacyQuestionKey,
  readLegacyQuestionForms,
  saveLegacyQuestionForm,
  type LegacyQuestionForm,
  type QuestionForm,
} from "../app/userInput";
import { threadAssignment } from "../app/steering";
import type {
  SchedulerThreadSnapshot,
  ThreadDetailResponse,
} from "../scheduler/types";
import { UserInputDialog } from "./UserInputDialog";
import { LegacyUserInputDialog } from "./LegacyUserInputDialog";

type Draft = QuestionForm & {
  reading?: boolean;
  busy?: boolean;
  available?: boolean;
  error?: string;
};
type LegacyObjective = {
  id: string;
  generation: number;
  revision: number;
  context_id: string;
  coordinator_session_id: string;
  stated_objective: string;
  wait_condition?: { kind: string; [key: string]: unknown };
};
type LegacyDraft = LegacyQuestionForm & {
  busy?: boolean;
  available?: boolean;
  error?: string;
};
export type UserInputDialogHandle = {
  open(snapshot: SchedulerThreadSnapshot): void;
  openLegacy(objective: LegacyObjective): void;
  close(): void;
};
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** No navigation, composer mutation or automatic replay. A frozen command can
 * only be retried explicitly, with its original identity and exact payload. */
export const UserInputDialogHost = forwardRef<
  UserInputDialogHandle,
  {
    principalId: string;
    readOnly: boolean;
    onAccepted(): void;
    container: HTMLElement | null;
    onEngage?(): void;
    onRelease?(): void;
  }
>(function UserInputDialogHost({ principalId, readOnly, onAccepted, container, onEngage, onRelease }, ref) {
  const { t } = useTranslation();
  const scope = `${CORE_HTTP_URL}:${principalId}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      readQuestionForms(browserStorage(), scope).map((form) => [
        questionKey(form.request),
        form,
      ]),
    ),
  );
  const draftsRef = useRef(drafts);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [legacyDrafts, setLegacyDrafts] = useState<Record<string, LegacyDraft>>(
    () =>
      Object.fromEntries(
        readLegacyQuestionForms(browserStorage(), scope).map((form) => [
          legacyQuestionKey(form),
          form,
        ]),
      ),
  );
  const legacyRef = useRef(legacyDrafts);
  const [legacyKey, setLegacyKey] = useState<string | null>(null);
  const legacyKeyRef = useRef(legacyKey);
  legacyKeyRef.current = legacyKey;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function failureMessage(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return error instanceof DashboardApiError &&
      [401, 403].includes(error.status)
      ? `${t("userInput.permissionLost")} ${detail}`
      : detail;
  }
  function update(key: string, patch: Partial<Draft>) {
    if (!mounted.current || !draftsRef.current[key]) return;
    const next = {
      ...draftsRef.current,
      [key]: { ...draftsRef.current[key], ...patch },
    };
    draftsRef.current = next;
    setDrafts(next);
  }
  function close() {
    activeKeyRef.current = null;
    setActiveKey(null);
  }
  function dismiss() {
    close();
    legacyKeyRef.current = null;
    setLegacyKey(null);
    onRelease?.();
  }
  function updateLegacy(key: string, patch: Partial<LegacyDraft>) {
    if (!mounted.current || !legacyRef.current[key]) return;
    const next = {
      ...legacyRef.current,
      [key]: { ...legacyRef.current[key], ...patch },
    };
    legacyRef.current = next;
    setLegacyDrafts(next);
  }
  async function checkLegacy(form: LegacyQuestionForm) {
    const result = await DASHBOARD_API.get<{
      objective: {
        id: string;
        generation: number;
        revision: number;
        status: string;
        coordinator_session_id: string;
        context_id: string;
        wait_condition?: {
          kind: string;
          request_id?: string | null;
          session_id?: string;
        };
      };
    }>("/api/objectives/" + encodeURIComponent(form.objectiveId));
    const value = result.objective;
    return (
      value.id === form.objectiveId &&
      value.generation === form.generation &&
      value.status === "active" &&
      value.coordinator_session_id === form.sessionId &&
      value.context_id === form.contextId &&
      value.wait_condition?.kind === "user_input" &&
      value.wait_condition.session_id === form.sessionId &&
      (value.wait_condition.request_id ??
        `legacy:${value.id}:${value.generation}:${value.revision}`) ===
        form.requestId
    );
  }
  useImperativeHandle(ref, () => ({
    close() {
      close();
      legacyKeyRef.current = null;
      setLegacyKey(null);
    },
    open(snapshot) {
      const request = currentQuestion(snapshot);
      if (!request) return;
      onEngage?.();
      const key = questionKey(request);
      legacyKeyRef.current = null;
      setLegacyKey(null);
      const previous = draftsRef.current[key];
      // A saved Runtime request is immutable. Never apply an old form to a
      // different question body even if a corrupt client snapshot reuses an ID.
      const same =
        previous &&
        JSON.stringify(previous.request.questions) ===
          JSON.stringify(request.questions);
      const draft: Draft = {
        request,
        title: threadAssignment(snapshot) ?? snapshot.thread.id,
        answers: request.questions.map((question) => ({
          question_id: question.id,
          selected_option_ids: [],
          text: "",
        })),
        ...(same ? previous : {}),
        reading: true,
        available: false,
        error: undefined,
      };
      draftsRef.current = { ...draftsRef.current, [key]: draft };
      setDrafts(draftsRef.current);
      activeKeyRef.current = key;
      setActiveKey(key);
      if (readOnly || snapshot.thread.control_state !== "active") {
        update(key, { reading: false });
        return;
      }
      void DASHBOARD_API.get<ThreadDetailResponse>(
        `/api/contexts/${encodeURIComponent(request.context_id)}/threads/${encodeURIComponent(request.thread_id)}`,
      )
        .then((detail) => {
          const actual = currentQuestion(detail.snapshot);
          update(key, {
            reading: false,
            available:
              detail.snapshot.thread.control_state === "active" &&
              actual?.reply_allowed !== false &&
              actual !== undefined &&
              questionKey(actual) === key &&
              JSON.stringify(actual.questions) ===
                JSON.stringify(request.questions),
          });
        })
        .catch((error) =>
          update(key, {
            reading: false,
            error: failureMessage(error),
          }),
        );
    },
    openLegacy(objective) {
      if (readOnly || objective.wait_condition?.kind !== "user_input") return;
      onEngage?.();
      const requestId =
        typeof objective.wait_condition.request_id === "string"
          ? objective.wait_condition.request_id
          : `legacy:${objective.id}:${objective.generation}:${objective.revision}`;
      const original: LegacyQuestionForm = {
        objectiveId: objective.id,
        generation: objective.generation,
        requestId,
        sessionId: objective.coordinator_session_id,
        contextId: objective.context_id,
        title: objective.stated_objective,
        body: "",
      };
      const key = legacyQuestionKey(original);
      legacyRef.current = {
        ...legacyRef.current,
        [key]: {
          ...original,
          ...legacyRef.current[key],
          busy: true,
          available: false,
          error: undefined,
        },
      };
      setLegacyDrafts(legacyRef.current);
      close();
      legacyKeyRef.current = key;
      setLegacyKey(key);
      void checkLegacy(original)
        .then((available) => updateLegacy(key, { busy: false, available }))
        .catch((error) =>
          updateLegacy(key, {
            busy: false,
            error: failureMessage(error),
          }),
        );
    },
  }));

  function change(key: string, answers: UserInputAnswer[]) {
    const draft = draftsRef.current[key];
    if (!draft || draft.command || draft.busy || draft.reading || readOnly)
      return;
    update(key, { answers, error: undefined });
    saveQuestionForm(browserStorage(), scope, draftsRef.current[key]);
  }
  async function submit(key: string) {
    const draft = draftsRef.current[key];
    if (!draft || draft.busy || draft.reading || readOnly || !principalId)
      return;
    if (!draft.command && !draft.available) return;
    update(key, { busy: true, error: undefined }); // synchronous ref fence for double-clicks
    let command = draft.command;
    try {
      if (!command) {
        const detail = await DASHBOARD_API.get<ThreadDetailResponse>(
          `/api/contexts/${encodeURIComponent(draft.request.context_id)}/threads/${encodeURIComponent(draft.request.thread_id)}`,
        );
        if (!mounted.current) return;
        const actual = currentQuestion(detail.snapshot);
        if (
          !actual ||
          actual.reply_allowed === false ||
          questionKey(actual) !== key ||
          detail.snapshot.thread.control_state !== "active" ||
          JSON.stringify(actual.questions) !==
            JSON.stringify(draft.request.questions)
        ) {
          update(key, { available: false, error: t("userInput.stale") });
          return;
        }
        command = questionCommand(
          actual,
          draft.answers,
          `dashboard-question-${crypto.randomUUID()}`,
        );
        if (!command) {
          update(key, { error: t("userInput.invalid") });
          return;
        }
        update(key, { command });
        saveQuestionForm(browserStorage(), scope, { ...draft, command });
      }
      const receipt = await DASHBOARD_API.command<{ event_id?: string }>(
        `/api/sessions/${encodeURIComponent(draft.request.session_id)}/messages`,
        "POST",
        command,
      );
      if (!receipt?.event_id) throw new Error(t("userInput.unknown"));
      if (!mounted.current) return;
      forgetQuestionForm(browserStorage(), scope, draft.request);
      const next = { ...draftsRef.current };
      delete next[key];
      draftsRef.current = next;
      setDrafts(next);
      if (activeKeyRef.current === key) { close(); onRelease?.(); }
      onAccepted();
    } catch (error) {
      if (!mounted.current) return;
      const definitive =
        error instanceof DashboardApiError &&
        [400, 401, 403, 404, 409, 422].includes(error.status);
      update(key, {
        ...(definitive
          ? {
              command: undefined,
              available: error.status === 400 || error.status === 422,
            }
          : {}),
        error: failureMessage(error),
      });
      if (definitive)
        saveQuestionForm(browserStorage(), scope, draftsRef.current[key]);
    } finally {
      update(key, { busy: false });
    }
  }
  async function submitLegacy(key: string) {
    const draft = legacyRef.current[key];
    if (
      !draft ||
      draft.busy ||
      readOnly ||
      (!draft.command && !draft.available)
    )
      return;
    updateLegacy(key, { busy: true, error: undefined });
    let command = draft.command;
    try {
      if (!command) {
        if (
          !draft.body.trim() ||
          Array.from(draft.body).length > 8000 ||
          draft.body.includes("\0")
        )
          return;
        if (!(await checkLegacy(draft))) {
          updateLegacy(key, { available: false, error: t("userInput.stale") });
          return;
        }
        if (!mounted.current) return;
        command = {
          client_message_id: `dashboard-question-${crypto.randomUUID()}`,
          text: draft.body.trim(),
          dispatch_mode: "parallel",
          input_destination: {
            kind: "objective",
            objective_id: draft.objectiveId,
            generation: draft.generation,
            reply_to_request_id: draft.requestId,
          },
        };
        updateLegacy(key, { command });
        saveLegacyQuestionForm(browserStorage(), scope, { ...draft, command });
      }
      const receipt = await DASHBOARD_API.command<{ event_id?: string }>(
        `/api/sessions/${encodeURIComponent(draft.sessionId)}/messages`,
        "POST",
        command,
      );
      if (!receipt?.event_id) throw new Error(t("userInput.unknown"));
      if (!mounted.current) return;
      forgetLegacyQuestionForm(browserStorage(), scope, draft);
      const next = { ...legacyRef.current };
      delete next[key];
      legacyRef.current = next;
      setLegacyDrafts(next);
      if (legacyKeyRef.current === key) {
        legacyKeyRef.current = null;
        setLegacyKey(null);
        onRelease?.();
      }
      onAccepted();
    } catch (error) {
      const definitive =
        error instanceof DashboardApiError &&
        [400, 401, 403, 404, 409, 422].includes(error.status);
      updateLegacy(key, {
        ...(definitive ? { command: undefined, available: false } : {}),
        error: failureMessage(error),
      });
      if (definitive && mounted.current)
        saveLegacyQuestionForm(browserStorage(), scope, legacyRef.current[key]);
    } finally {
      updateLegacy(key, { busy: false });
    }
  }
  const active = activeKey ? drafts[activeKey] : undefined;
  const activeLegacy = legacyKey ? legacyDrafts[legacyKey] : undefined;
  const unresolved = Object.entries(drafts).filter(
    ([, draft]) => draft.command && !draft.busy,
  );
  if (!container) return null;
  return createPortal((
    <>
      {(!!unresolved.length ||
        Object.values(legacyDrafts).some((draft) => draft.command)) &&
        !active &&
        !activeLegacy &&
        !readOnly && (
          <div className="runtime-question-recovery" role="status">
            {unresolved.map(([key, draft]) => (
              <button
                type="button"
                key={key}
                title={draft.title}
                onClick={() => {
                  onEngage?.();
                  activeKeyRef.current = key;
                  setActiveKey(key);
                }}
              >
                <MessageCircleQuestion size={15} />
                {t("userInput.pendingReceipt")}
              </button>
            ))}
            {Object.entries(legacyDrafts)
              .filter(([, draft]) => draft.command && !draft.busy)
              .map(([key, draft]) => (
                <button
                  type="button"
                  key={key}
                  title={draft.title}
                  onClick={() => {
                    onEngage?.();
                    legacyKeyRef.current = key;
                    setLegacyKey(key);
                  }}
                >
                  <MessageCircleQuestion size={15} />
                  {t("userInput.pendingReceipt")}
                </button>
              ))}
          </div>
        )}
      {active && (
        <UserInputDialog
          key={activeKey}
          title={active.title}
          request={active.request}
          answers={active.answers}
          available={!readOnly && !!active.available}
          busy={!!active.busy || !!active.reading}
          frozen={!!active.command && !readOnly}
          error={active.error}
          status={
            active.reading
              ? t("userInput.reading")
              : active.command
                ? t("userInput.unknown")
                : undefined
          }
          onChange={(answers) => change(activeKey!, answers)}
          onSubmit={() => void submit(activeKey!)}
          onClose={dismiss}
        />
      )}
      {activeLegacy && (
        <LegacyUserInputDialog
          key={legacyKey}
          title={activeLegacy.title}
          body={activeLegacy.body}
          available={!!activeLegacy.available && !readOnly}
          busy={!!activeLegacy.busy}
          frozen={!!activeLegacy.command && !readOnly}
          error={activeLegacy.error}
          onChange={(body) => {
            if (activeLegacy.command || activeLegacy.busy || readOnly) return;
            updateLegacy(legacyKey!, { body, error: undefined });
            saveLegacyQuestionForm(
              browserStorage(),
              scope,
              legacyRef.current[legacyKey!],
            );
          }}
          onSubmit={() => void submitLegacy(legacyKey!)}
          onClose={dismiss}
        />
      )}
    </>
  ), container);
});
