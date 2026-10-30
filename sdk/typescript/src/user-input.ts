/** Runtime-owned questions. Reading a request does not grant reply authority. */
export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  options?: UserInputOption[];
  multi_select?: boolean;
}

export interface PendingUserInputRequest {
  request_id: string;
  thread_id: string;
  thread_generation: number;
  session_id: string;
  context_id: string;
  requested_at: string;
  questions: UserInputQuestion[];
  /** Read-only availability hint; not authorization for ingress. */
  reply_allowed?: boolean;
}

export interface UserInputAnswer {
  question_id: string;
  selected_option_ids: string[];
  text: string;
}

/** Explicit answer to one saved request, never a Session-wide wake. */
export interface UserInputDestination {
  kind: "user_input";
  request_id: string;
  thread_id: string;
  generation: number;
  answers: UserInputAnswer[];
}

/** Client-side preview only. The Runtime validates again against its saved
 * question, not labels or authority supplied by a renderer. */
export function userInputAnswerText(
  questions: readonly UserInputQuestion[],
  answers: readonly UserInputAnswer[],
): string | null {
  if (
    !questions.length ||
    questions.length > 3 ||
    answers.length !== questions.length ||
    new Set(questions.map((question) => question.id)).size !==
      questions.length ||
    new Set(answers.map((answer) => answer.question_id)).size !==
      answers.length ||
    new TextEncoder().encode(JSON.stringify(answers)).byteLength > 32 * 1024 ||
    answers.some(
      (answer) =>
        !questions.some((question) => question.id === answer.question_id),
    )
  )
    return null;
  const result: string[] = [];
  for (const question of questions) {
    const answer = answers.find((value) => value.question_id === question.id);
    if (
      !answer ||
      typeof answer.text !== "string" ||
      !Array.isArray(answer.selected_option_ids) ||
      answer.selected_option_ids.length > 8 ||
      Array.from(answer.text).length > 8000 ||
      answer.text.includes("\0") ||
      (!question.multi_select && answer.selected_option_ids.length > 1) ||
      new Set(answer.selected_option_ids).size !==
        answer.selected_option_ids.length
    )
      return null;
    const labels = answer.selected_option_ids.map(
      (id) =>
        (question.options ?? []).find((option) => option.id === id)?.label,
    );
    if (
      labels.some((label) => label === undefined) ||
      (!labels.length && !answer.text.trim())
    )
      return null;
    const body = [...labels, ...(answer.text.trim() ? [answer.text] : [])].join(
      "\n",
    );
    result.push(questions.length > 1 ? `${question.question}\n${body}` : body);
  }
  return result.join("\n\n").trim();
}
