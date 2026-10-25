import { z } from "zod";

const localIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const boundedText = (limit: number) =>
  z
    .string()
    .refine(
      (value) =>
        !!value.trim() &&
        Array.from(value).length <= limit &&
        !value.includes("\0"),
      "Expected nonempty bounded text",
    );
export const userInputOptionSchema = z
  .object({
    id: localIdentifier,
    label: boundedText(200),
    description: boundedText(1000).optional(),
  })
  .strict();
export const userInputQuestionSchema = z
  .object({
    id: localIdentifier,
    question: boundedText(2000),
    options: z.array(userInputOptionSchema).max(8).default([]),
    multi_select: z.boolean().default(false),
  })
  .strict()
  .refine(
    (question) =>
      new Set(question.options.map((option) => option.id)).size ===
        question.options.length &&
      (!question.multi_select || question.options.length >= 2),
    "Invalid question choices",
  );
export const userInputQuestionsSchema = z
  .array(userInputQuestionSchema)
  .min(1)
  .max(3)
  .refine(
    (questions) =>
      new Set(questions.map((question) => question.id)).size ===
      questions.length,
    "Question IDs must be unique",
  )
  .refine(
    (questions) =>
      new TextEncoder().encode(JSON.stringify({ questions })).byteLength <=
      32 * 1024,
    "Question request exceeds 32 KiB",
  );
export const pendingUserInputRequestSchema = z
  .object({
    request_id: z.string().min(1).max(256),
    thread_id: z.string().min(1).max(256),
    thread_generation: z.number().int().positive().safe(),
    session_id: z.string().min(1).max(256),
    context_id: z.string().min(1).max(256),
    requested_at: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value))),
    questions: userInputQuestionsSchema,
    reply_allowed: z.boolean().optional(),
  })
  .strict();
export const userInputAnswerSchema = z
  .object({
    question_id: localIdentifier,
    selected_option_ids: z.array(localIdentifier).max(8).default([]),
    text: z
      .string()
      .refine(
        (value) => Array.from(value).length <= 8000 && !value.includes("\0"),
      )
      .default(""),
  })
  .strict();
export const userInputAnswersSchema = z
  .array(userInputAnswerSchema)
  .min(1)
  .max(3)
  .refine(
    (answers) =>
      new TextEncoder().encode(JSON.stringify(answers)).byteLength <= 32 * 1024,
    "Answer exceeds 32 KiB",
  );

export type PendingUserInputRequest = z.infer<
  typeof pendingUserInputRequestSchema
>;
export type UserInputQuestion = z.infer<typeof userInputQuestionSchema>;
export type UserInputAnswer = z.infer<typeof userInputAnswerSchema>;

/** Form validation and preview only; Runtime independently validates against
 * its immutable request and owns the accepted answer text. */
export function userInputAnswerText(
  questions: readonly UserInputQuestion[],
  answers: readonly UserInputAnswer[],
): string | null {
  if (
    !userInputQuestionsSchema.safeParse(questions).success ||
    !userInputAnswersSchema.safeParse(answers).success ||
    answers.length !== questions.length ||
    new Set(answers.map((answer) => answer.question_id)).size !== answers.length
  )
    return null;
  const result: string[] = [];
  for (const question of questions) {
    const answer = answers.find((answer) => answer.question_id === question.id);
    if (
      !answer ||
      (!question.multi_select && answer.selected_option_ids.length > 1) ||
      new Set(answer.selected_option_ids).size !==
        answer.selected_option_ids.length
    )
      return null;
    const labels = answer.selected_option_ids.map(
      (id) => question.options.find((option) => option.id === id)?.label,
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
