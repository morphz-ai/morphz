import { z } from "zod";
import {
  bookmarkSchema,
  type BookmarkOperation,
} from "../../../../packages/core/src/bookmarks.js";
import { RequestError } from "../application-transport.js";
import type { applicationCall } from "../application-transport.js";
import { draftKey, scopedStorage } from "../local-preferences.js";

export type BookmarkInteractionIdentity = {
  centerId: string;
  principalId: string;
  actantId: string;
  csrfToken: string;
  capabilities: { browserBookmarks: boolean };
};

export type BookmarkInteractionPorts = {
  current: { readonly current: BookmarkInteractionIdentity | null };
  call: typeof applicationCall;
  savedInputScope: (identity: {
    centerId: string;
    principalId: string;
    actantId: string;
  }) => string;
};

/** The original personal-bookmark list and durable command lifecycles.
 * Borrow Client's identity ref, logical call and saved-input scope function.
 * Construction reads no identity or storage and starts no operation.
 */
export function createBookmarkInteractions(options: BookmarkInteractionPorts) {
  const { current, call: applicationCall, savedInputScope } = options;
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
