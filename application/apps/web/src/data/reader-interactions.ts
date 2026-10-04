import { RequestError } from "../application-transport.js";
import type { applicationCall } from "../application-transport.js";
import { draftKey, scopedStorage } from "../local-preferences.js";
import { runPendingFileImport } from "../pending-file-import.js";
import type { ReaderCommand } from "../../../../packages/core/src/reader.js";

export type ReaderInteractionIdentity = {
  centerId: string;
  principalId: string;
  csrfToken: string;
};

export type ReaderInteractionPorts = {
  current: { readonly current: ReaderInteractionIdentity | null };
  call: typeof applicationCall;
  refreshAfterMutation: () => Promise<boolean>;
};

/** Own the original Reader import, OCR and durable reading-command lifecycles.
 * Borrow Client's identity ref and mutation confirmation; construction is inert.
 * Each method keeps its own cancellation, retry and receipt policy.
 */
export function createReaderInteractions(options: ReaderInteractionPorts) {
  const { current, call: applicationCall, refreshAfterMutation } = options;
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
    request: import("../../../../packages/core/src/reader-ocr.js").ReaderOcrRequest,
    signal?: AbortSignal,
    identityGeneration?: string,
  ): Promise<
    import("../../../../packages/core/src/reader-ocr.js").ReaderOcrStatus
  > {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (identityGeneration && identityGeneration !== identity.csrfToken)
      throw new Error("阅读权限已变化，请重新读取。");
    const result = (await applicationCall("reader.ocr", request, {
      identityGeneration: identity.csrfToken,
      signal,
    })) as import("../../../../packages/core/src/reader-ocr.js").ReaderOcrStatus;
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
