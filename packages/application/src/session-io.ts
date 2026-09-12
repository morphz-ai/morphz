import type { Workspace } from "../../../packages/core/src/model.js";
import {
  objectToolName,
  legacyObjectToolName,
} from "../../../packages/core/src/application-names.js";
import {
  legacyWorkInputFormatV1,
  legacyWorkInputFormatV2,
} from "./compat/legacy-input-formats.js";
export {
  legacyWorkInputFormatV1 as workInputFormatV1,
  legacyWorkInputFormatV2,
} from "./compat/legacy-input-formats.js";

/** New inputs use the unified name. Registered legacy definitions stay immutable. */
export const workInputFormat = {
  ...legacyWorkInputFormatV2,
  id: "morphz.application.input",
  version: "1",
  publisher: "Morphz application",
  contract: legacyWorkInputFormatV2.contract.replaceAll(
    legacyObjectToolName,
    objectToolName,
  ),
} as const;
export const workInputFormats = [
  workInputFormat,
  legacyWorkInputFormatV2,
  legacyWorkInputFormatV1,
];

export function workInputData(input: Workspace["inputs"][number]) {
  return {
    text: input.body,
    input_id: input.id,
    workspace_id: input.projectId,
    author_actant_id: input.author.actantId,
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.selection ? { selection: input.selection } : {}),
    ...(input.browser ? { browser: input.browser } : {}),
    ...(input.artifactId
      ? {
          object: {
            artifact_id: input.artifactId,
            revision: input.artifactRevision,
          },
        }
      : {}),
  };
}

export function workInputRequest(
  input: Workspace["inputs"][number],
  model?: string | null,
) {
  return {
    io_version: "1",
    client_message_id: input.id,
    message: {
      format: { id: workInputFormat.id, version: workInputFormat.version },
      content: { encoding: "json", value: workInputData(input) },
    },
    activation: {
      mode: "evaluate",
      dispatch_mode: "parallel",
      ...(input.application?.harness
        ? { harness: input.application.harness }
        : {}),
      ...(model ? { model_alias: model } : {}),
      ...(input.reasoningEffort
        ? { reasoning_effort: input.reasoningEffort }
        : {}),
    },
    delivery: {
      accept_formats: [{ id: "morphz.chat", version: "1", encoding: "json" }],
    },
  };
}
