import type { ReaderCommand } from "../../packages/core/src/reader.js";
import type { ReaderInteractionPorts } from "../../apps/web/src/data/reader-interactions.js";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";
import { runPendingFileImport } from "../../apps/web/src/pending-file-import.js";
import { RequestError } from "../../apps/web/src/application-transport.js";

// Independently captured three complete declarations from actual committed Git.
// Only type-only import paths are relocated in the executable old factory.
export const fixedReaderInteractions = {
  git: "21cb34dc4d3c975247feda810d4d15f70c678737",
  sourceSha256:
    "e46367774b907c3625bf5609f31de8ab3cba00dbffada96e3cf3b8bf0ab222e0",
  methods: {
    importReading: {
      raw: 'async function importReading(\n    file: File,\n    projectId: string,\n  ): Promise<{ entityId: string }> {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    const data = new Uint8Array(await file.arrayBuffer());\n    return runPendingFileImport(\n      {\n        method: "reader.import",\n        projectId,\n        relativePath: file.name,\n        bytes: data,\n      },\n      scopedStorage(`${identity.centerId}:${identity.principalId}`),\n      (commandId) => {\n        if (current.current?.csrfToken !== identity.csrfToken)\n          throw new Error("身份已切换，文件未发送。");\n        return applicationCall(\n          "reader.import",\n          {\n            commandId,\n            projectId,\n            relativePath: file.name,\n            data,\n          },\n          {\n            identityGeneration: identity.csrfToken,\n            signal: AbortSignal.timeout(35000),\n          },\n        ) as Promise<{ entityId: string }>;\n      },\n      async () => {\n        if (!(await refreshAfterMutation()))\n          throw new Error("导入已提交，但内容目录尚未刷新；请重试同一文件。");\n        if (current.current?.csrfToken !== identity.csrfToken)\n          throw new Error("身份已切换，导入结果尚未确认。");\n      },\n    );\n  }',
      sha256:
        "adee3f5dfdf52b3c906d17935bde229474204a8b752057d4c05d8bf8e7b176ba",
    },
    readingOcr: {
      raw: 'async function readingOcr(\n    request: import("../../../packages/core/src/reader-ocr.js").ReaderOcrRequest,\n    signal?: AbortSignal,\n    identityGeneration?: string,\n  ): Promise<\n    import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus\n  > {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    if (identityGeneration && identityGeneration !== identity.csrfToken)\n      throw new Error("阅读权限已变化，请重新读取。");\n    const result = (await applicationCall("reader.ocr", request, {\n      identityGeneration: identity.csrfToken,\n      signal,\n    })) as import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus;\n    if (signal?.aborted || current.current?.csrfToken !== identity.csrfToken)\n      throw new Error("阅读权限已变化，请重新读取。");\n    return result;\n  }',
      sha256:
        "5d8d1004710ab9d77a82afa9973577b8476d852ad10ba6396bb6d45c9d4c9819",
    },
    readerCommand: {
      raw: 'async function readerCommand(\n    artifactId: string,\n    revision: number,\n    command: ReaderCommand,\n  ): Promise<{ id: string; revision: number }> {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    const scope = `${identity.centerId}:${identity.principalId}`;\n    const { readLocal, writeLocal } = scopedStorage(scope);\n    const hash = await crypto.subtle.digest(\n      "SHA-256",\n      new TextEncoder().encode(\n        JSON.stringify({ artifactId, revision, command }),\n      ),\n    );\n    const key = draftKey(\n      "pending:reader:" +\n        Array.from(new Uint8Array(hash), (value) =>\n          value.toString(16).padStart(2, "0"),\n        ).join(""),\n    );\n    const pending = readLocal<{ commandId: string } | null>(key, null) ?? {\n      commandId: crypto.randomUUID(),\n    };\n    writeLocal(key, pending);\n    try {\n      if (current.current?.csrfToken !== identity.csrfToken)\n        throw new Error("身份已切换，阅读操作未发送。");\n      const receipt = (await applicationCall(\n        "reader.command",\n        {\n          commandId: pending.commandId,\n          artifactId,\n          revision,\n          command,\n        },\n        {\n          identityGeneration: identity.csrfToken,\n          signal: AbortSignal.timeout(12000),\n        },\n      )) as { id: string; revision: number };\n      writeLocal(key, null);\n      return receipt;\n    } catch (error) {\n      if (\n        error instanceof RequestError &&\n        error.status < 500 &&\n        error.status !== 408\n      )\n        writeLocal(key, null);\n      throw error;\n    }\n  }',
      sha256:
        "728313aeaa62f3f450f974dfe13762fcbc858acb0aa47cc44c9364b92bb1b4ef",
    },
  },
} as const;

export function createFixedReaderInteractions({
  current,
  call: applicationCall,
  refreshAfterMutation,
}: ReaderInteractionPorts) {
  async function importReading(
    file: File,
    projectId: string,
  ): Promise<{ entityId: string }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const data = new Uint8Array(await file.arrayBuffer());
    return runPendingFileImport(
      {
        method: "reader.import",
        projectId,
        relativePath: file.name,
        bytes: data,
      },
      scopedStorage(`${identity.centerId}:${identity.principalId}`),
      (commandId) => {
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，文件未发送。");
        return applicationCall(
          "reader.import",
          {
            commandId,
            projectId,
            relativePath: file.name,
            data,
          },
          {
            identityGeneration: identity.csrfToken,
            signal: AbortSignal.timeout(35000),
          },
        ) as Promise<{ entityId: string }>;
      },
      async () => {
        if (!(await refreshAfterMutation()))
          throw new Error("导入已提交，但内容目录尚未刷新；请重试同一文件。");
        if (current.current?.csrfToken !== identity.csrfToken)
          throw new Error("身份已切换，导入结果尚未确认。");
      },
    );
  }
  async function readingOcr(
    request: import("../../packages/core/src/reader-ocr.js").ReaderOcrRequest,
    signal?: AbortSignal,
    identityGeneration?: string,
  ): Promise<import("../../packages/core/src/reader-ocr.js").ReaderOcrStatus> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (identityGeneration && identityGeneration !== identity.csrfToken)
      throw new Error("阅读权限已变化，请重新读取。");
    const result = (await applicationCall("reader.ocr", request, {
      identityGeneration: identity.csrfToken,
      signal,
    })) as import("../../packages/core/src/reader-ocr.js").ReaderOcrStatus;
    if (signal?.aborted || current.current?.csrfToken !== identity.csrfToken)
      throw new Error("阅读权限已变化，请重新读取。");
    return result;
  }
  async function readerCommand(
    artifactId: string,
    revision: number,
    command: ReaderCommand,
  ): Promise<{ id: string; revision: number }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const scope = `${identity.centerId}:${identity.principalId}`;
    const { readLocal, writeLocal } = scopedStorage(scope);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({ artifactId, revision, command }),
      ),
    );
    const key = draftKey(
      "pending:reader:" +
        Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
    );
    const pending = readLocal<{ commandId: string } | null>(key, null) ?? {
      commandId: crypto.randomUUID(),
    };
    writeLocal(key, pending);
    try {
      if (current.current?.csrfToken !== identity.csrfToken)
        throw new Error("身份已切换，阅读操作未发送。");
      const receipt = (await applicationCall(
        "reader.command",
        {
          commandId: pending.commandId,
          artifactId,
          revision,
          command,
        },
        {
          identityGeneration: identity.csrfToken,
          signal: AbortSignal.timeout(12000),
        },
      )) as { id: string; revision: number };
      writeLocal(key, null);
      return receipt;
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status < 500 &&
        error.status !== 408
      )
        writeLocal(key, null);
      throw error;
    }
  }
  return { importReading, readingOcr, readerCommand };
}
