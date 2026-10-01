import { z } from "zod";
import { applicationStoragePrefix } from "../../../packages/core/src/application-names.js";
import {
  operationSchema,
  type Operation,
  type Workspace,
} from "../../../packages/core/src/model.js";

type InputOperation = Extract<Operation, { type: "record-input" }>;
export const inputSubmissionSchema = z.object({
  state: z.enum(["sending", "accepted", "failed"]),
  error: z.string().optional(),
});
export type InputSubmission = z.infer<typeof inputSubmissionSchema>;
const savedInputSchema = z
  .object({
    commandId: z.uuid(),
    createdAt: z.iso.datetime(),
    operation: operationSchema,
    submission: inputSubmissionSchema.optional(),
  })
  .strict();
export type LocalSavedInput = {
  commandId: string;
  createdAt: string;
  operation: InputOperation;
  submission?: InputSubmission;
};

const prefix = (scope: string) =>
  `${applicationStoragePrefix}${scope}:saved-input:`;

/** One key per input: two windows never overwrite each other's unsent work. */
export function readSavedInputs(storage: Storage, scope: string) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix(scope))) keys.push(key);
  }
  const saved: LocalSavedInput[] = [];
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const value = savedInputSchema.parse(JSON.parse(raw));
      if (
        value.operation.type === "record-input" &&
        key === prefix(scope) + value.commandId
      )
        saved.push(value as LocalSavedInput);
    } catch {
      // A malformed local preference cannot prevent the authorized catalog
      // and Runtime history from opening. It is not a server-side input.
    }
  }
  return saved.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.commandId.localeCompare(b.commandId),
  );
}

export function saveInputLocally(
  storage: Storage,
  scope: string,
  input: LocalSavedInput,
) {
  const parsed = savedInputSchema.parse(input);
  if (parsed.operation.type !== "record-input")
    throw new Error("只能保存未发送的消息。");
  const key = prefix(scope) + parsed.commandId;
  try {
    storage.setItem(key, JSON.stringify(parsed));
  } catch {
    throw new Error("本机暂时无法保存这条消息；编辑框中的内容仍在。");
  }
}

export function removeSavedInput(storage: Storage, scope: string, id: string) {
  storage.removeItem(prefix(scope) + id);
}

/** Remove only the local display overlay, never authoritative history. */
export function withoutSavedInputs(workspace: Workspace, localIds: string[]) {
  const ids = new Set(localIds);
  return {
    ...workspace,
    inputs: workspace.inputs.filter((input) => !ids.has(input.id)),
  };
}

/** Presentation only. A staged message is not an accepted Runtime input. */
export function withSavedInputs(
  workspace: Workspace,
  saved: LocalSavedInput[],
  author: { principalId: string; actantId: string },
  sendingIds: ReadonlySet<string> = new Set(),
) {
  const projects = new Set(workspace.projects.map((project) => project.id));
  const knownInputs = new Set(workspace.inputs.map((input) => input.id));
  const inputs = [...workspace.inputs];
  const localInputIds: string[] = [];
  const submissions: Record<string, InputSubmission> = {};
  for (const entry of saved) {
    const op = entry.operation;
    if (!projects.has(op.projectId)) continue;
    if (knownInputs.has(entry.commandId)) continue;
    localInputIds.push(entry.commandId);
    if (entry.submission) {
      submissions[entry.commandId] =
        entry.submission.state === "sending" && !sendingIds.has(entry.commandId)
          ? { state: "failed", error: "发送结果待确认，点击重试。" }
          : entry.submission;
    }
    const {
      type: _type,
      newConversation: _newConversation,
      applicationInstanceId,
      application: _applicationContext,
      ...fields
    } = op;
    const instance = applicationInstanceId
      ? workspace.applicationInstances.find(
          (value) => value.id === applicationInstanceId,
        )
      : undefined;
    const manifest = instance
      ? workspace.applications.find(
          (value) =>
            value.id === instance.applicationId &&
            value.version === instance.applicationVersion,
        )
      : undefined;
    inputs.push({
      ...fields,
      id: entry.commandId,
      author: { principalId: author.principalId, actantId: author.actantId },
      status: "recorded",
      createdAt: entry.createdAt,
      ...(instance && manifest
        ? {
            application: {
              instanceId: instance.id,
              id: manifest.id,
              version: manifest.version,
              harness: manifest.harness ?? null,
            },
          }
        : {}),
    });
    knownInputs.add(entry.commandId);
  }
  return {
    workspace: { ...workspace, inputs },
    localInputIds,
    submissions,
  };
}
