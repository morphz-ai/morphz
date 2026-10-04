// Independently captured complete original algorithms from committed Git.
// Ordinary CI neither reads Git nor freezes the complete current Client.
export const fixedReaderInteractions = {
  git: "21cb34dc4d3c975247feda810d4d15f70c678737",
  path: "application/apps/web/src/client.ts",
  sourceSha256:
    "e46367774b907c3625bf5609f31de8ab3cba00dbffada96e3cf3b8bf0ab222e0",
  functions: [
    {
      name: "importReading",
      raw: 'async function importReading(\n    file: File,\n    projectId: string,\n  ): Promise<{ entityId: string }> {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    const data = new Uint8Array(await file.arrayBuffer());\n    return runPendingFileImport(\n      {\n        method: "reader.import",\n        projectId,\n        relativePath: file.name,\n        bytes: data,\n      },\n      scopedStorage(`${identity.centerId}:${identity.principalId}`),\n      (commandId) => {\n        if (current.current?.csrfToken !== identity.csrfToken)\n          throw new Error("身份已切换，文件未发送。");\n        return applicationCall(\n          "reader.import",\n          {\n            commandId,\n            projectId,\n            relativePath: file.name,\n            data,\n          },\n          {\n            identityGeneration: identity.csrfToken,\n            signal: AbortSignal.timeout(35000),\n          },\n        ) as Promise<{ entityId: string }>;\n      },\n      async () => {\n        if (!(await refreshAfterMutation()))\n          throw new Error("导入已提交，但内容目录尚未刷新；请重试同一文件。");\n        if (current.current?.csrfToken !== identity.csrfToken)\n          throw new Error("身份已切换，导入结果尚未确认。");\n      },\n    );\n  }',
      sha256:
        "adee3f5dfdf52b3c906d17935bde229474204a8b752057d4c05d8bf8e7b176ba",
    },
    {
      name: "readingOcr",
      raw: 'async function readingOcr(\n    request: import("../../../packages/core/src/reader-ocr.js").ReaderOcrRequest,\n    signal?: AbortSignal,\n    identityGeneration?: string,\n  ): Promise<\n    import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus\n  > {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    if (identityGeneration && identityGeneration !== identity.csrfToken)\n      throw new Error("阅读权限已变化，请重新读取。");\n    const result = (await applicationCall("reader.ocr", request, {\n      identityGeneration: identity.csrfToken,\n      signal,\n    })) as import("../../../packages/core/src/reader-ocr.js").ReaderOcrStatus;\n    if (signal?.aborted || current.current?.csrfToken !== identity.csrfToken)\n      throw new Error("阅读权限已变化，请重新读取。");\n    return result;\n  }',
      sha256:
        "5d8d1004710ab9d77a82afa9973577b8476d852ad10ba6396bb6d45c9d4c9819",
    },
    {
      name: "readerCommand",
      raw: 'async function readerCommand(\n    artifactId: string,\n    revision: number,\n    command: ReaderCommand,\n  ): Promise<{ id: string; revision: number }> {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    const scope = `${identity.centerId}:${identity.principalId}`;\n    const { readLocal, writeLocal } = scopedStorage(scope);\n    const hash = await crypto.subtle.digest(\n      "SHA-256",\n      new TextEncoder().encode(\n        JSON.stringify({ artifactId, revision, command }),\n      ),\n    );\n    const key = draftKey(\n      "pending:reader:" +\n        Array.from(new Uint8Array(hash), (value) =>\n          value.toString(16).padStart(2, "0"),\n        ).join(""),\n    );\n    const pending = readLocal<{ commandId: string } | null>(key, null) ?? {\n      commandId: crypto.randomUUID(),\n    };\n    writeLocal(key, pending);\n    try {\n      if (current.current?.csrfToken !== identity.csrfToken)\n        throw new Error("身份已切换，阅读操作未发送。");\n      const receipt = (await applicationCall(\n        "reader.command",\n        {\n          commandId: pending.commandId,\n          artifactId,\n          revision,\n          command,\n        },\n        {\n          identityGeneration: identity.csrfToken,\n          signal: AbortSignal.timeout(12000),\n        },\n      )) as { id: string; revision: number };\n      writeLocal(key, null);\n      return receipt;\n    } catch (error) {\n      if (\n        error instanceof RequestError &&\n        error.status < 500 &&\n        error.status !== 408\n      )\n        writeLocal(key, null);\n      throw error;\n    }\n  }',
      sha256:
        "728313aeaa62f3f450f974dfe13762fcbc858acb0aa47cc44c9364b92bb1b4ef",
    },
  ],
} as const;
