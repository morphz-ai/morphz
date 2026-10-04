// Independently captured actual Git 2877c03dff859f1f5c0d67d38c835efc4012996a; not generated from candidate.
// Only two complete original algorithms and their finite identity/scope recipes.
// Ordinary CI does not read Git, /tmp or a whole current Client snapshot.
import { z } from "zod";
import {
  bookmarkSchema,
  type BookmarkOperation,
} from "../../packages/core/src/bookmarks.js";
import {
  RequestError,
  type applicationCall,
} from "../../apps/web/src/application-transport.js";
import {
  draftKey,
  scopedStorage,
} from "../../apps/web/src/local-preferences.js";

export const originalBookmarkMetadata = {
  git: "2877c03dff859f1f5c0d67d38c835efc4012996a",
  path: "application/apps/web/src/client.ts",
  sourceSha256:
    "fa2a03f46588f8d35ac1725b63a9f6bc0c7eb46de46086c0b8aedc3adf04a300",
  sourceBytes: 65127,
  functions: [
    {
      name: "bookmarkList",
      sha256:
        "b6afe72666808b3bbb5e3ea0a869d8a207d69c4f71eacd78a9244f7fda5b0f91",
      start: 52970,
      end: 53536,
      line: 1541,
    },
    {
      name: "bookmarkCommand",
      sha256:
        "22b5b2602f8fcb52008ec5113097a16838e640ddb405942e4b1dd6cedd4c631c",
      start: 53539,
      end: 54948,
      line: 1561,
    },
  ],
  definitions: {
    savedInputScope:
      "70112e31949794a24a6ed4d71588d81e1f1ca767328ffa0e80a3eee9b50f9bdf",
    currentRef:
      "7a4486103d3411745bc217e30586502556c941292147c30f5d9e56a403e171ba",
    clearProtectedProjection:
      "ef7b6fa6cc40c9c56a175bf317c9c6233f3891e6763a74c3e4e85777b26983f5",
  },
  neighbors: [
    {
      path: "application/apps/web/src/local-preferences.ts",
      sha256:
        "505dff560588587948f1b0f067af97c2c41967c4dec414250a3a335e2d13963f",
      bytes: 1977,
    },
    {
      path: "application/apps/web/src/application-transport.ts",
      sha256:
        "75996dc15b8c26f5c51ac7b7db581e1e5d49c9ec238f50fccdd3e2ad0f5555f3",
      bytes: 9590,
    },
    {
      path: "application/packages/core/src/bookmarks.ts",
      sha256:
        "ab85e27af9ae1b908e1419ed22fd7c52e61b2dcbf02f06a930ae51f54c221af2",
      bytes: 2652,
    },
    {
      path: "application/apps/web/src/BrowserBookmarks.tsx",
      sha256:
        "d598536a23ad43e82cc201fadfbb3269bcc6d0b119368334d50d2dceb0999598",
      bytes: 13540,
    },
    {
      path: "application/apps/web/src/BrowserHost.tsx",
      sha256:
        "d73650e82db58f2cd22b35990b3dbdd9c783b5b68727605cddf37b384691bbc5",
      bytes: 18140,
    },
  ],
} as const;
export const originalBookmarkDeclarations = {
  bookmarkList:
    'async function bookmarkList(\n    request: {\n      query?: string;\n      url?: string;\n      deleted?: boolean;\n      offset?: number;\n      limit?: number;\n    } = {},\n  ) {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    if (!identity.capabilities.browserBookmarks)\n      throw new Error("浏览器收藏尚未接通新数据模型。");\n    return z.array(bookmarkSchema).parse(\n      await applicationCall("bookmarks.list", request, {\n        identityGeneration: identity.csrfToken,\n        signal: AbortSignal.timeout(8000),\n      }),\n    );\n  }',
  bookmarkCommand:
    'async function bookmarkCommand(operation: BookmarkOperation) {\n    const identity = current.current;\n    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");\n    if (!identity.capabilities.browserBookmarks)\n      throw new Error("浏览器收藏尚未接通新数据模型。");\n    const scope = savedInputScope(identity);\n    const { readLocal, writeLocal } = scopedStorage(scope);\n    const hash = await crypto.subtle.digest(\n      "SHA-256",\n      new TextEncoder().encode(JSON.stringify(operation)),\n    );\n    const key = draftKey(\n      "pending:bookmark:" +\n        Array.from(new Uint8Array(hash), (value) =>\n          value.toString(16).padStart(2, "0"),\n        ).join(""),\n    );\n    if (current.current?.csrfToken !== identity.csrfToken)\n      throw new Error("身份已切换，操作未发送。");\n    const command = readLocal<{\n      commandId: string;\n      operation: BookmarkOperation;\n    } | null>(key, null) ?? {\n      commandId: crypto.randomUUID(),\n      operation,\n    };\n    writeLocal(key, command);\n    try {\n      const receipt = await applicationCall("bookmarks.command", command, {\n        identityGeneration: identity.csrfToken,\n        signal: AbortSignal.timeout(8000),\n      });\n      writeLocal(key, null);\n      return receipt;\n    } catch (error) {\n      if (\n        error instanceof RequestError &&\n        error.status < 500 &&\n        error.status !== 408\n      )\n        writeLocal(key, null);\n      throw error;\n    }\n  }',
} as const;
export const originalBookmarkDefinitions = {
  savedInputScope:
    "const savedInputScope = (identity: {\n  centerId: string;\n  principalId: string;\n  actantId: string;\n}) => `${identity.centerId}:${identity.principalId}:${identity.actantId}`;",
  currentRef: "current = useRef<Boot | null>(null)",
  clearProtectedProjection:
    'function clearProtectedProjection() {\n    protectedReadGeneration.current++;\n    current.current = null;\n    platform.current = null;\n    conversationHistory.clear();\n    catalogCache.current = null;\n    scriptOverviews.current.clear();\n    pendingScriptOverviews.current.clear();\n    scriptEditorReads.clear();\n    navigationCacheKey.current = "";\n    snapshotText.current = "";\n    setBoot(null);\n    setContentCatalog([]);\n    setContentCounts([]);\n    setTaskCounts([]);\n    setContentCatalogVersion(0);\n  }',
} as const;

export type OriginalBookmarkIdentity = {
  centerId: string;
  principalId: string;
  actantId: string;
  csrfToken: string;
  capabilities: { browserBookmarks: boolean };
};
export type OriginalBookmarkPorts = {
  current: { readonly current: OriginalBookmarkIdentity | null };
  call: typeof applicationCall;
  savedInputScope: (identity: {
    centerId: string;
    principalId: string;
    actantId: string;
  }) => string;
};
export function createOriginalBookmarkInteractions({
  current,
  call: applicationCall,
  savedInputScope,
}: OriginalBookmarkPorts) {
  async function bookmarkList(
    request: {
      query?: string;
      url?: string;
      deleted?: boolean;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (!identity.capabilities.browserBookmarks)
      throw new Error("浏览器收藏尚未接通新数据模型。");
    return z.array(bookmarkSchema).parse(
      await applicationCall("bookmarks.list", request, {
        identityGeneration: identity.csrfToken,
        signal: AbortSignal.timeout(8000),
      }),
    );
  }
  async function bookmarkCommand(operation: BookmarkOperation) {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    if (!identity.capabilities.browserBookmarks)
      throw new Error("浏览器收藏尚未接通新数据模型。");
    const scope = savedInputScope(identity);
    const { readLocal, writeLocal } = scopedStorage(scope);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(operation)),
    );
    const key = draftKey(
      "pending:bookmark:" +
        Array.from(new Uint8Array(hash), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
    );
    if (current.current?.csrfToken !== identity.csrfToken)
      throw new Error("身份已切换，操作未发送。");
    const command = readLocal<{
      commandId: string;
      operation: BookmarkOperation;
    } | null>(key, null) ?? {
      commandId: crypto.randomUUID(),
      operation,
    };
    writeLocal(key, command);
    try {
      const receipt = await applicationCall("bookmarks.command", command, {
        identityGeneration: identity.csrfToken,
        signal: AbortSignal.timeout(8000),
      });
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
  return { bookmarkList, bookmarkCommand };
}
