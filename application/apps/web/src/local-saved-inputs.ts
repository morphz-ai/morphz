import { z } from "zod";
import { applicationStoragePrefix } from "../../../packages/core/src/application-names.js";
import {
  operationSchema,
  type Operation,
  type Workspace,
} from "../../../packages/core/src/model.js";

type InputOperation = Extract<Operation, { type: "record-input" }>;
const savedInputSchema = z
  .object({
    commandId: z.uuid(),
    createdAt: z.iso.datetime(),
    operation: operationSchema,
  })
  .strict();
export type LocalSavedInput = {
  commandId: string;
  createdAt: string;
  operation: InputOperation;
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

/** Presentation only. Platform and Runtime remain the sole authorities for
 * conversations and sent messages; these records never enter their stores. */
export function withSavedInputs(
  workspace: Workspace,
  saved: LocalSavedInput[],
  author: { principalId: string; actantId: string },
) {
  const projects = new Set(workspace.projects.map((project) => project.id));
  const knownInputs = new Set(workspace.inputs.map((input) => input.id));
  const inputs = [...workspace.inputs];
  for (const entry of saved) {
    const op = entry.operation;
    if (!projects.has(op.projectId)) continue;
    if (knownInputs.has(entry.commandId)) continue;
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
      author,
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
    localInputIds: saved.map((entry) => entry.commandId),
  };
}
