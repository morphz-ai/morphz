import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Operation } from "../../../packages/core/src/model.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import type {
  PendingUserInputRequest,
  UserInputAnswer,
} from "../../../packages/core/src/user-input.js";
import { userInputAnswerText } from "../../../packages/core/src/user-input.js";
import {
  userInputTargetSchema,
  type UserInputTarget,
} from "../../../packages/core/src/user-input-target.js";
import type { WorkspaceClient } from "./client.js";
import { applicationCall, RequestError } from "./application-transport.js";
import type { ActivityThread } from "./execution-activity.js";
import { UserInputDialog } from "./UserInputDialog.js";
import { LegacyUserInputDialog } from "./LegacyUserInputDialog.js";

type InputOperation = Extract<Operation, { type: "record-input" }>;
function questionFailure(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message : fallback;
  return error instanceof RequestError && [401, 403].includes(error.status)
    ? "当前无权回复此任务，草稿已保留。恢复访问权限后，请关闭并重新打开核对。 " +
        detail
    : detail;
}
export type QuestionObjective = {
  id: string;
  title: string;
  inputId: string;
  projectId: string;
  conversationId: string;
  sessionId: string;
  generation?: number;
  status: string;
  pendingUserInput?: {
    kind: "question" | "legacy";
    requestId: string;
    threadId?: string;
    threadGeneration?: number;
  };
};
type Origin = {
  kind: "question" | "legacy";
  title: string;
  projectId: string;
  conversationId: string;
  requestId: string;
  continuation: InputContinuation;
  question?: PendingUserInputRequest;
  objectiveId?: string;
};
type Draft = {
  answers: UserInputAnswer[];
  legacyBody?: string;
  target?: UserInputTarget;
  command?: { id: string; operation: InputOperation };
  reading?: boolean;
  busy?: boolean;
  error?: string;
};
export type UserInputDialogHandle = {
  open(thread: ActivityThread): void;
  openObjective(goal: QuestionObjective, threads: ActivityThread[]): void;
  close(): void;
};

/** Only form drafts live here. Runtime owns the questions and acceptance.
 * Submitted immutable operations use the existing durable input outbox. */
export const UserInputDialogHost = forwardRef<
  UserInputDialogHandle,
  {
    client: WorkspaceClient;
    container: HTMLElement | null;
    onEngage?(): void;
    onRelease?(): void;
  }
>(function UserInputDialogHost(
  { client, container, onEngage, onRelease },
  ref,
) {
  const [active, setActive] = useState<{
    identity: string;
    key: string;
    origin: Origin;
  } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef(drafts);
  const boot = client.boot!;
  const identity = [boot.centerId, boot.principalId, boot.actantId].join(":");
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    setActive(null);
    draftsRef.current = {};
    setDrafts({});
  }, [identity]);
  function update(key: string, patch: Partial<Draft>) {
    const previous = draftsRef.current;
    if (!previous[key]) return;
    const next = { ...previous, [key]: { ...previous[key]!, ...patch } };
    draftsRef.current = next;
    setDrafts(next);
  }
  function openOrigin(origin: Origin, paused = false) {
    const key = [
      identity,
      origin.continuation.threadId,
      origin.continuation.generation,
      origin.requestId,
    ].join(":");
    setActive({ identity, key, origin });
    onEngage?.();
    const previous = draftsRef.current;
    const next = {
      ...previous,
      [key]: {
        answers:
          origin.question?.questions.map((question) => ({
            question_id: question.id,
            selected_option_ids: [],
            text: "",
          })) ?? [],
        ...previous[key],
        target: undefined,
        reading: true,
        error: undefined,
      },
    };
    draftsRef.current = next;
    setDrafts(next);
    if (paused) {
      update(key, { reading: false });
      return;
    }
    void applicationCall("user-input.read", {
      projectId: origin.projectId,
      conversationId: origin.conversationId,
      requestId: origin.requestId,
      continuation: origin.continuation,
      ...(origin.kind === "legacy" ? { legacy: true } : {}),
    })
      .then((raw) => {
        if (currentIdentity.current !== identity) return;
        const target = userInputTargetSchema.parse(raw);
        if (
          origin.kind === "question"
            ? !target.request ||
              target.request.request_id !== origin.requestId ||
              target.request.thread_id !== origin.continuation.threadId ||
              target.request.thread_generation !==
                origin.continuation.generation
            : target.legacyRequestId !== origin.requestId
        )
          throw new Error("问题的执行身份已变化，未切换到其他问题。");
        const current = draftsRef.current[key]!;
        update(key, {
          target,
          reading: false,
          ...(target.request && !current.answers.length
            ? {
                answers: target.request.questions.map((question) => ({
                  question_id: question.id,
                  selected_option_ids: [],
                  text: "",
                })),
              }
            : {}),
        });
      })
      .catch((error: unknown) => {
        if (currentIdentity.current === identity)
          update(key, {
            reading: false,
            error: questionFailure(
              error,
              "暂时无法读取这个问题，请关闭后重试。",
            ),
          });
      });
  }
  useImperativeHandle(ref, () => ({
    close() {
      setActive(null);
    },
    open(thread) {
      const question = thread.userInputRequest;
      if (
        !question ||
        !thread.continuation ||
        !thread.projectId ||
        !thread.conversationId
      )
        return;
      openOrigin(
        {
          kind: "question",
          title: thread.title,
          projectId: thread.projectId,
          conversationId: thread.conversationId,
          requestId: question.request_id,
          continuation: thread.continuation,
          question,
        },
        thread.controlState === "paused",
      );
    },
    openObjective(goal, threads) {
      const pending = goal.pendingUserInput;
      if (!pending) return;
      let continuation: InputContinuation | undefined;
      if (
        pending.kind === "question" &&
        pending.threadId &&
        pending.threadGeneration
      )
        continuation = {
          mode: "supplement",
          inputId: goal.inputId,
          threadId: pending.threadId,
          generation: pending.threadGeneration,
        };
      else {
        const targets = threads.flatMap((thread) => {
          const target = thread.continuation;
          return thread.sessionId === goal.sessionId &&
            thread.projectId === goal.projectId &&
            thread.conversationId === goal.conversationId &&
            target?.mode === "supplement" &&
            target.objective?.id === goal.id &&
            target.objective.generation === goal.generation
            ? [target]
            : [];
        });
        if (targets.length === 1) continuation = targets[0];
      }
      if (!continuation) return;
      openOrigin(
        {
          kind: pending.kind,
          title: goal.title,
          projectId: goal.projectId,
          conversationId: goal.conversationId,
          requestId: pending.requestId,
          continuation,
          objectiveId: goal.id,
        },
        goal.status !== "active",
      );
    },
  }));
  if (
    !active ||
    active.identity !== identity ||
    !drafts[active.key] ||
    !container
  )
    return null;
  const { key, origin } = active;
  const draft = drafts[key]!;
  const question = draft.target?.request ?? origin.question;
  const currentThread = boot.runtime.activity?.threads.find(
    (thread) =>
      thread.id === origin.continuation.threadId &&
      thread.continuation?.generation === origin.continuation.generation,
  );
  const currentGoal = origin.objectiveId
    ? boot.runtime.activity?.objectives?.find(
        (goal) => goal.id === origin.objectiveId,
      )
    : undefined;
  const pending = currentGoal
    ? currentGoal.status === "active" &&
      currentGoal.pendingUserInput?.requestId === origin.requestId
    : currentThread?.controlState === "active" &&
      currentThread.lifecycle === "open" &&
      currentThread.userInputRequest?.request_id === origin.requestId;
  const available =
    client.online &&
    boot.runtime.connected &&
    !!boot.runtime.activity?.available &&
    !!draft.target &&
    draft.target.request?.reply_allowed !== false &&
    question?.reply_allowed !== false &&
    !!pending;

  async function submit(answers?: UserInputAnswer[]) {
    let latest = draftsRef.current[key];
    if (
      !latest ||
      latest.busy ||
      latest.reading ||
      currentIdentity.current !== identity
    )
      return;
    if (answers && !latest.command) {
      if (!available) return;
      update(key, { answers });
      latest = draftsRef.current[key]!;
    }
    let command = latest.command;
    if (!command) {
      if (!available || !latest.target) return;
      const { source, continuation, request, legacyRequestId } = latest.target;
      const body = request
        ? userInputAnswerText(request.questions, latest.answers)
        : latest.legacyBody?.trim();
      if (
        !body ||
        body.length > 30000 ||
        (!request && Array.from(body).length > 8000)
      )
        return;
      command = {
        id: crypto.randomUUID(),
        operation: {
          type: "record-input",
          projectId: source.projectId,
          conversationId: source.conversationId,
          artifactId: source.artifactId,
          artifactRevision: source.artifactRevision,
          targetActantId: source.targetActantId,
          selection: "",
          body,
          dispatchMode: "parallel",
          continuation: {
            ...continuation,
            mode: "reply",
            reply: request
              ? {
                  kind: "question",
                  requestId: request.request_id,
                  answers: structuredClone(latest.answers),
                }
              : { kind: "legacy", requestId: legacyRequestId! },
          },
        },
      };
    }
    update(key, { command, busy: true, error: undefined });
    try {
      await client.execute(command.operation, true, undefined, command.id);
      if (currentIdentity.current !== identity) return;
      const next = { ...draftsRef.current };
      delete next[key];
      draftsRef.current = next;
      setDrafts(next);
      setActive((value) => (value?.key === key ? null : value));
      if (activeRef.current?.key === key) onRelease?.();
      void client.refresh({ refreshActivity: true });
    } catch (error) {
      if (currentIdentity.current === identity) {
        const definitive =
          error instanceof RequestError &&
          [400, 401, 403, 404, 409, 422].includes(error.status);
        update(key, {
          busy: false,
          ...(definitive
            ? {
                command: undefined,
                ...([400, 422].includes(error.status)
                  ? {}
                  : { target: undefined }),
              }
            : {}),
          error:
            questionFailure(error, "投递结果尚未确认。") +
            (definitive
              ? " 答案已保留。"
              : " 答案和本次投递已保留，核对不会另发一条回复。"),
        });
      }
    }
  }
  function close() {
    setActive(null);
    onRelease?.();
  }
  return createPortal(
    origin.kind === "question" && question ? (
      <UserInputDialog
        key={key}
        title={origin.title || draft.target?.title || "原工作"}
        request={question}
        answers={draft.answers}
        available={!!available}
        busy={!!draft.busy || !!draft.reading}
        frozen={!!draft.command}
        error={draft.error}
        status={
          draft.reading
            ? "正在读取问题…"
            : question.reply_allowed === false
              ? "当前工作不可回复，恢复任务并刷新后再试。"
              : currentThread?.controlState === "paused"
                ? "任务已暂停，恢复任务后可以回复。"
                : undefined
        }
        onChange={(answers) => update(key, { answers })}
        onSubmit={(answers) => void submit(answers)}
        onClose={close}
      />
    ) : (
      <LegacyUserInputDialog
        key={key}
        title={origin.title}
        value={draft.legacyBody ?? ""}
        legacy={origin.kind === "legacy"}
        available={!!available}
        reading={!!draft.reading}
        busy={!!draft.busy}
        frozen={!!draft.command}
        error={draft.error}
        onChange={(legacyBody) => update(key, { legacyBody })}
        onSubmit={() => void submit()}
        onClose={close}
      />
    ),
    container,
  );
});
