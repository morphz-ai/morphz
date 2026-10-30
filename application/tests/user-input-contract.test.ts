import assert from "node:assert/strict";
import test from "node:test";
import {
  continuationSchema,
  inputDestination,
  isDirectedContinuation,
} from "../packages/core/src/continuation.js";
import {
  pendingUserInputRequestSchema,
  userInputAnswerText,
  userInputQuestionsSchema,
} from "../packages/core/src/user-input.js";
import { objectiveWaitKinds } from "../packages/application/src/objective-wait-projection.js";
import { executionWaitLabel } from "../apps/web/src/execution-wait-label.js";
import { userInputAnswerText as sdkAnswerText } from "../../sdk/typescript/src/user-input.js";

const questions = userInputQuestionsSchema.parse([
  {
    id: "preview",
    question: "Enable the preview?",
    options: [
      { id: "yes", label: "Enable" },
      { id: "no", label: "Keep it off" },
    ],
  },
]);
const answer = (ids: string[] = [], text = "") => ({
  question_id: "preview",
  selected_option_ids: ids,
  text,
});

test("an accepted answer is shown as resuming its owner, while unrelated waits remain explicit", () => {
  const value = {
    objective: { id: "goal", generation: 2 },
    readiness: { state: "waiting", dependency_ids: ["question", "group"] },
    dependencies: [
      {
        id: "question",
        owner_kind: "objective",
        owner_id: "goal",
        owner_generation: 2,
        dependency_kind: "user_input",
        dependency_id: "request",
        required: true,
        status: "pending",
        metadata: {
          source: "request_user_input",
          request_event_id: "request",
          accepted_answer_event_id: "answer",
        },
      },
      {
        id: "group",
        owner_kind: "objective",
        owner_id: "goal",
        owner_generation: 2,
        dependency_kind: "thread_group",
        dependency_id: "group-1",
        required: true,
        status: "pending",
      },
    ],
  };
  assert.deepEqual(objectiveWaitKinds(value), [
    "user_input_delivery",
    "thread_group",
  ]);
  assert.equal(
    executionWaitLabel(objectiveWaitKinds(value)),
    "等待恢复原线程、子任务结果",
  );
});

test("a structured reply addresses the exact asking Thread rather than its supervising Objective", () => {
  const reply = continuationSchema.parse({
    mode: "reply",
    inputId: "original_input",
    threadId: "asking_thread",
    generation: 3,
    objective: { id: "parent_goal", generation: 2 },
    reply: {
      kind: "question",
      requestId: "user_input_original",
      answers: [answer(["yes"])],
    },
  });
  assert.equal(isDirectedContinuation(reply), true);
  assert.deepEqual(inputDestination(reply), {
    kind: "user_input",
    request_id: "user_input_original",
    thread_id: "asking_thread",
    generation: 3,
    answers: [answer(["yes"])],
  });
  for (const value of [
    { ...reply, mode: "supplement" },
    { ...reply, reply: undefined },
    { ...reply, mode: "follow-up" },
  ])
    assert.equal(continuationSchema.safeParse(value).success, false);
});

test("old question replies retain their exact Runtime request ID without inventing choices", () => {
  const reply = continuationSchema.parse({
    mode: "reply",
    inputId: "original_input",
    threadId: "asking_thread",
    generation: 3,
    objective: { id: "parent_goal", generation: 2 },
    reply: { kind: "legacy", requestId: "legacy:parent_goal:2:17" },
  });
  assert.deepEqual(inputDestination(reply), {
    kind: "objective",
    objective_id: "parent_goal",
    generation: 2,
    reply_to_request_id: "legacy:parent_goal:2:17",
  });
  assert.equal(
    continuationSchema.safeParse({ ...reply, objective: undefined }).success,
    false,
  );
});

test("the message envelope trims outer whitespace while the structured free text stays exact", () => {
  const answers = [answer([], "  original free text  ")];
  assert.equal(userInputAnswerText(questions, answers), "original free text");
  assert.equal(answers[0]!.text, "  original free text  ");
});

test("UTF-8 answer bytes are bounded across otherwise valid questions", () => {
  const batch = userInputQuestionsSchema.parse([
    questions[0],
    { id: "second", question: "Second?" },
    { id: "third", question: "Third?" },
  ]);
  const answers = batch.map((question) => ({
    question_id: question.id,
    selected_option_ids: [],
    text: "中".repeat(4000),
  }));
  assert.ok(answers.every((answer) => Array.from(answer.text).length < 8000));
  assert.equal(userInputAnswerText(batch, answers), null);
});

test("question projection retains exact execution and request identities", () => {
  const value = {
    request_id: "user_input_activation_1",
    thread_id: "thread_original",
    thread_generation: 3,
    session_id: "session_original",
    context_id: "context_original",
    requested_at: "2026-10-25T00:00:00Z",
    questions,
  };
  assert.deepEqual(pendingUserInputRequestSchema.parse(value), value);
  for (const patch of [
    { request_id: "" },
    { thread_generation: 0 },
    { thread_generation: Number.MAX_SAFE_INTEGER + 1 },
    { requested_at: "not a date" },
    { principal_id: "renderer-selected" },
  ])
    assert.equal(
      pendingUserInputRequestSchema.safeParse({ ...value, ...patch }).success,
      false,
    );
});

test("new questions require explicit bounded text and unique local identities", () => {
  for (const value of [
    [],
    [{ id: "x", question: " " }],
    [{ id: "x", question: "a".repeat(2001) }],
    [{ id: "x", question: "A", multi_select: true }],
    [questions[0], questions[0]],
    [
      {
        ...questions[0],
        options: [
          { id: "same", label: "First" },
          { id: "same", label: "Second" },
        ],
      },
    ],
    [{ ...questions[0], authority: "not a model parameter" }],
  ])
    assert.equal(userInputQuestionsSchema.safeParse(value).success, false);
});

test("choice selection uses saved labels and can include additional free text", () => {
  assert.equal(
    userInputAnswerText(questions, [answer(["yes"], "Only locally")]),
    "Enable\nOnly locally",
  );
  assert.equal(
    userInputAnswerText(questions, [answer([], "A different answer")]),
    "A different answer",
  );
  assert.equal(userInputAnswerText(questions, [answer(["no"])]), "Keep it off");
});

test("the independent Host and SDK previews preserve the same accepted answer bytes", () => {
  const batch = userInputQuestionsSchema.parse([
    questions[0],
    { id: "notes", question: "Any constraints?" },
  ]);
  for (const answers of [
    [
      answer(["yes"], "  Keep original whitespace  "),
      {
        question_id: "notes",
        selected_option_ids: [],
        text: "本地验证\n不执行外部操作",
      },
    ],
    [
      answer(["not-saved"]),
      {
        question_id: "notes",
        selected_option_ids: [],
        text: "No external actions",
      },
    ],
    [answer(["no"])],
  ])
    assert.equal(
      userInputAnswerText(batch, answers),
      sdkAnswerText(batch, answers),
    );
});

test("empty, forged, duplicate and incompatible selections cannot submit", () => {
  for (const answers of [
    [],
    [answer()],
    [answer([], " ")],
    [answer(["not-saved"])],
    [answer(["yes", "no"])],
    [answer(["yes", "yes"])],
    [answer(["yes"]), answer(["yes"])],
    [{ ...answer(["yes"]), question_id: "other" }],
    [answer([], "\0")],
    [answer([], "a".repeat(8001))],
  ])
    assert.equal(userInputAnswerText(questions, answers), null);
});

test("a batch must answer every question and follows saved question order", () => {
  const batch = userInputQuestionsSchema.parse([
    questions[0],
    { id: "notes", question: "Any constraints?" },
  ]);
  const notes = {
    question_id: "notes",
    selected_option_ids: [],
    text: "No external actions",
  };
  assert.equal(
    userInputAnswerText(batch, [notes, answer(["no"])]),
    "Enable the preview?\nKeep it off\n\nAny constraints?\nNo external actions",
  );
  assert.equal(userInputAnswerText(batch, [notes]), null);
  assert.equal(userInputAnswerText(batch, [notes, notes]), null);
});

test("multi-select is explicit and custom answers do not require a choice", () => {
  const multiple = userInputQuestionsSchema.parse([
    { ...questions[0], multi_select: true },
  ]);
  assert.equal(
    userInputAnswerText(multiple, [answer(["yes", "no"], "Compare both")]),
    "Enable\nKeep it off\nCompare both",
  );
  const free = userInputQuestionsSchema.parse([
    { id: "preview", question: "What should happen?" },
  ]);
  assert.equal(
    userInputAnswerText(free, [answer([], "Keep the current work")]),
    "Keep the current work",
  );
});
