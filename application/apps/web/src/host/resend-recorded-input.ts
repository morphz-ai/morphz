import type {
  Operation,
  RecordedInput,
} from "../../../../packages/core/src/model.js";

/** An explicit new Human request, not a retry of transport or an old Thread.
 * Use only the recorded scope; the current reader/composer never replaces it.
 * The normal domain operation rechecks membership, grants and source versions.
 */
export function resendRecordedInput(
  input: RecordedInput,
): Extract<Operation, { type: "record-input" }> {
  if (input.continuation) throw new Error("定向补充不能作为原请求重新发送。");
  return {
    type: "record-input",
    projectId: input.projectId,
    conversationId: input.conversationId,
    artifactId: input.artifactId,
    artifactRevision: input.artifactRevision,
    selection: input.selection,
    body: input.body,
    targetActantId: input.targetActantId,
    ...(input.reading ? { reading: input.reading } : {}),
    ...(input.textQuotes ? { textQuotes: input.textQuotes } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.browser ? { browser: input.browser } : {}),
    ...(input.localFile ? { localFile: input.localFile } : {}),
    ...(input.directories ? { directories: input.directories } : {}),
    ...(input.cognitiveObject
      ? { cognitiveObject: input.cognitiveObject }
      : {}),
    ...(input.cognitiveApplication
      ? { cognitiveApplication: input.cognitiveApplication }
      : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.scriptGeneration
      ? { scriptGeneration: input.scriptGeneration }
      : {}),
    ...(input.dispatchMode ? { dispatchMode: input.dispatchMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    ...(input.application
      ? {
          application: {
            id: input.application.id,
            version: input.application.version,
            ...(input.application.terminalId !== undefined
              ? { terminalId: input.application.terminalId }
              : {}),
          },
        }
      : {}),
  };
}
