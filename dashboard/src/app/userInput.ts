import {
  userInputAnswerText,
  type PendingUserInputRequest,
  type UserInputAnswer,
  type UserInputDestination,
} from "../../../sdk/typescript/src/user-input.ts";
import type {
  SchedulerDependencyRecord,
  SchedulerThreadSnapshot,
} from "../scheduler/types.ts";
import type { SessionDraftStorage } from "./sessionDraft.ts";

export type QuestionCommand = {
  client_message_id: string;
  text: string;
  dispatch_mode: "parallel";
  input_destination: UserInputDestination;
};
export type QuestionForm = {
  request: PendingUserInputRequest;
  title: string;
  answers: UserInputAnswer[];
  command?: QuestionCommand;
};
export type LegacyQuestion = {
  objectiveId: string;
  generation: number;
  requestId: string;
  sessionId: string;
  contextId: string;
  title: string;
};
export type LegacyQuestionForm = LegacyQuestion & {
  body: string;
  command?: {
    client_message_id: string;
    text: string;
    dispatch_mode: "parallel";
    input_destination: {
      kind: "objective";
      objective_id: string;
      generation: number;
      reply_to_request_id: string;
    };
  };
};
export function legacyQuestionKey(question: LegacyQuestion): string {
  return JSON.stringify([
    question.contextId,
    question.sessionId,
    question.objectiveId,
    question.generation,
    question.requestId,
  ]);
}
const PREFIX = "morphz.dashboard.question-form.v1:";
export function questionKey(request: PendingUserInputRequest): string {
  return JSON.stringify([
    request.context_id,
    request.session_id,
    request.thread_id,
    request.thread_generation,
    request.request_id,
  ]);
}
export function questionAnswerAccepted(
  id: string,
  generation: number,
  dependencies: readonly SchedulerDependencyRecord[],
): boolean {
  return dependencies.some((edge) => {
    const data = edge.metadata as Record<string, unknown> | null;
    return (
      edge.owner_kind === "objective" &&
      edge.owner_id === id &&
      edge.owner_generation === generation &&
      edge.dependency_kind === "user_input" &&
      edge.required &&
      edge.status === "pending" &&
      data?.source === "request_user_input" &&
      data.request_event_id === edge.dependency_id &&
      typeof data.accepted_answer_event_id === "string" &&
      !!data.accepted_answer_event_id
    );
  });
}
export function currentQuestion(
  snapshot: SchedulerThreadSnapshot,
): PendingUserInputRequest | undefined {
  const question = snapshot.user_input_request;
  const thread = snapshot.thread;
  return question &&
    thread.lifecycle === "open" &&
    question.thread_id === thread.id &&
    question.thread_generation === thread.generation &&
    question.session_id === thread.session_id &&
    question.context_id === thread.context_id
    ? question
    : undefined;
}
export function questionCommand(
  request: PendingUserInputRequest,
  answers: UserInputAnswer[],
  commandId: string,
): QuestionCommand | undefined {
  const text = userInputAnswerText(request.questions, answers);
  if (!text || text.length > 30000) return undefined;
  return {
    client_message_id: commandId,
    text,
    dispatch_mode: "parallel",
    input_destination: {
      kind: "user_input",
      request_id: request.request_id,
      thread_id: request.thread_id,
      generation: request.thread_generation,
      answers: structuredClone(answers),
    },
  };
}
function storagePrefix(scope: string): string {
  return `${PREFIX}${encodeURIComponent(scope)}:`;
}
function validQuestionDraft(form: QuestionForm): boolean {
  const localId = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const text = (value: unknown, limit: number) =>
    typeof value === "string" &&
    !!value.trim() &&
    Array.from(value).length <= limit &&
    !value.includes("\0");
  const questions = form.request.questions;
  if (
    !questions.length ||
    questions.length > 3 ||
    new Set(questions.map((question) => question?.id)).size !==
      questions.length ||
    new TextEncoder().encode(JSON.stringify({ questions })).byteLength >
      32 * 1024 ||
    questions.some(
      (question) =>
        !question ||
        !localId(question.id) ||
        !text(question.question, 2000) ||
        (question.multi_select !== undefined &&
          typeof question.multi_select !== "boolean") ||
        (question.options !== undefined &&
          (!Array.isArray(question.options) || question.options.length > 8)) ||
        (question.options ?? []).some(
          (option) =>
            !option ||
            !localId(option.id) ||
            !text(option.label, 200) ||
            (option.description !== undefined &&
              !text(option.description, 1000)),
        ) ||
        new Set((question.options ?? []).map((option) => option.id)).size !==
          (question.options ?? []).length ||
        (question.multi_select && (question.options ?? []).length < 2),
    )
  )
    return false;
  return (
    form.answers.length === questions.length &&
    new Set(form.answers.map((answer) => answer?.question_id)).size ===
      questions.length &&
    new TextEncoder().encode(JSON.stringify(form.answers)).byteLength <=
      32 * 1024 &&
    form.answers.every((answer) => {
      const question = questions.find(
        (question) => question.id === answer?.question_id,
      );
      return (
        question &&
        Array.isArray(answer.selected_option_ids) &&
        answer.selected_option_ids.length <= 8 &&
        (question.multi_select || answer.selected_option_ids.length <= 1) &&
        new Set(answer.selected_option_ids).size ===
          answer.selected_option_ids.length &&
        answer.selected_option_ids.every((id) =>
          (question.options ?? []).some((option) => option.id === id),
        ) &&
        typeof answer.text === "string" &&
        Array.from(answer.text).length <= 8000 &&
        !answer.text.includes("\0")
      );
    })
  );
}

/** This is a form/outbox, never question authority. Reads are shown only under
 * the original authenticated scope; every new send re-reads Runtime state. */
export function saveQuestionForm(
  storage: SessionDraftStorage | undefined,
  scope: string,
  form: QuestionForm,
): boolean {
  if (!storage || !scope) return false;
  try {
    storage.setItem(
      `${storagePrefix(scope)}${encodeURIComponent(questionKey(form.request))}`,
      JSON.stringify(form),
    );
    return true;
  } catch {
    return false;
  }
}
export function forgetQuestionForm(
  storage: SessionDraftStorage | undefined,
  scope: string,
  request: PendingUserInputRequest,
): void {
  try {
    storage?.removeItem(
      `${storagePrefix(scope)}${encodeURIComponent(questionKey(request))}`,
    );
  } catch {
    /* private storage may be denied */
  }
}
export function readQuestionForms(
  storage:
    | (SessionDraftStorage & {
        length: number;
        key(index: number): string | null;
      })
    | undefined,
  scope: string,
): QuestionForm[] {
  if (!storage || !scope) return [];
  const forms: QuestionForm[] = [];
  try {
    const prefix = storagePrefix(scope);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix) || key.startsWith(prefix + "legacy:"))
        continue;
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > 150000) continue;
        const form = JSON.parse(raw) as QuestionForm;
        if (
          !form.request ||
          !Array.isArray(form.request.questions) ||
          !Array.isArray(form.answers) ||
          typeof form.title !== "string" ||
          form.title.length > 4000 ||
          !Number.isSafeInteger(form.request.thread_generation) ||
          form.request.thread_generation < 1 ||
          ![
            form.request.request_id,
            form.request.context_id,
            form.request.session_id,
            form.request.thread_id,
          ].every(
            (value) =>
              typeof value === "string" &&
              value.length > 0 &&
              value.length <= 256,
          ) ||
          key !== `${prefix}${encodeURIComponent(questionKey(form.request))}` ||
          !validQuestionDraft(form)
        )
          continue;
        if (form.command) {
          if (
            typeof form.command.client_message_id !== "string" ||
            form.command.client_message_id.length > 256
          )
            continue;
          const expected = questionCommand(
            form.request,
            form.answers,
            form.command.client_message_id,
          );
          if (
            !expected ||
            JSON.stringify(expected) !== JSON.stringify(form.command)
          )
            continue;
        } else if (form.answers.length !== form.request.questions.length)
          continue;
        forms.push(form);
      } catch {
        /* one malformed draft does not hide other questions */
      }
    }
  } catch {
    /* corrupt/inaccessible drafts are not execution instructions */
  }
  return forms;
}

export function saveLegacyQuestionForm(
  storage: SessionDraftStorage | undefined,
  scope: string,
  form: LegacyQuestionForm,
): void {
  try {
    storage?.setItem(
      `${storagePrefix(scope)}legacy:${encodeURIComponent(legacyQuestionKey(form))}`,
      JSON.stringify(form),
    );
  } catch {
    /* retain the in-memory form */
  }
}
export function forgetLegacyQuestionForm(
  storage: SessionDraftStorage | undefined,
  scope: string,
  form: LegacyQuestionForm,
): void {
  try {
    storage?.removeItem(
      `${storagePrefix(scope)}legacy:${encodeURIComponent(legacyQuestionKey(form))}`,
    );
  } catch {
    /* inaccessible private storage */
  }
}
export function readLegacyQuestionForms(
  storage:
    | (SessionDraftStorage & {
        length: number;
        key(index: number): string | null;
      })
    | undefined,
  scope: string,
): LegacyQuestionForm[] {
  const forms: LegacyQuestionForm[] = [];
  if (!storage || !scope) return forms;
  try {
    const prefix = `${storagePrefix(scope)}legacy:`;
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const raw = storage.getItem(key);
        if (!raw || raw.length > 100000) continue;
        const form = JSON.parse(raw) as LegacyQuestionForm;
        if (
          ![
            form.objectiveId,
            form.requestId,
            form.sessionId,
            form.contextId,
          ].every(
            (value) =>
              typeof value === "string" && !!value && value.length <= 256,
          ) ||
          typeof form.title !== "string" ||
          form.title.length > 4000 ||
          typeof form.body !== "string" ||
          Array.from(form.body).length > 8000 ||
          form.body.includes("\0") ||
          !Number.isSafeInteger(form.generation) ||
          form.generation < 1 ||
          key !== `${prefix}${encodeURIComponent(legacyQuestionKey(form))}`
        )
          continue;
        if (
          form.command &&
          (typeof form.command.client_message_id !== "string" ||
            !form.command.client_message_id ||
            form.command.text !== form.body.trim() ||
            form.command.dispatch_mode !== "parallel" ||
            form.command.input_destination.kind !== "objective" ||
            form.command.input_destination.objective_id !== form.objectiveId ||
            form.command.input_destination.generation !== form.generation ||
            form.command.input_destination.reply_to_request_id !==
              form.requestId)
        )
          continue;
        forms.push(form);
      } catch {
        /* one corrupt form must not hide independent drafts */
      }
    }
  } catch {
    /* storage may be unavailable */
  }
  return forms;
}
