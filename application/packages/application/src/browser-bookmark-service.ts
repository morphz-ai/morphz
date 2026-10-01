import { z } from "zod";
import { bookmarkOperations, type Bookmark } from "../../core/src/bookmarks.js";
import { commandSchema } from "../../core/src/model.js";
import { websiteURL } from "../../core/src/browser.js";
import {
  BrowserStore,
  type BrowserBookmarkAuthority,
  type BookmarkCommandReceipt,
} from "../../browser/src/store.js";
import {
  PlatformStore,
  type ApplicationProviderRoute,
  type PlatformActor,
} from "../../platform/src/store.js";

const bookmarkOperation = z.union(bookmarkOperations);
const bookmarkQuery = z
  .object({
    deleted: z.boolean().optional(),
    query: z.string().optional(),
    url: websiteURL.optional(),
    offset: z.number().int().optional(),
    limit: z.number().int().optional(),
  })
  .strict();

/** Resolve Browser's personal owner from the same live Platform authority on
 * every operation, including the final check made by BrowserStore itself.
 */
export function platformBrowserBookmarkAuthority(
  platform: PlatformStore,
  instanceId: string,
  provider: () => ApplicationProviderRoute,
): BrowserBookmarkAuthority {
  return {
    async authorize({ credential, originInputId }) {
      const actor = await platform.authorizePersonalApplicationAtRoute(
        { credential },
        instanceId,
        "morphz.browser",
        provider(),
      );
      if (actor.runtimeInputId !== originInputId) return null;
      return { ...actor, ownerPrincipalId: actor.principalId };
    },
  };
}

/** One Host operation path for UI and Agent. Platform checks the initiating
 * identity; Browser owns bookmark writes and their idempotent receipts.
 */
export class BrowserBookmarkService {
  constructor(
    private readonly platform: PlatformStore,
    private readonly browser: BrowserStore,
  ) {}

  private async access(actor: PlatformActor) {
    const identity = await this.platform.authorizePersonalApplication(actor);
    return {
      credential: actor.credential,
      originInputId: identity.runtimeInputId,
      expectedActor: {
        ...identity,
        ownerPrincipalId: identity.principalId,
      },
    };
  }

  async list(actor: PlatformActor, request: unknown = {}): Promise<Bookmark[]> {
    const filters = bookmarkQuery.parse(request);
    return this.browser.listBookmarks({
      ...filters,
      ...(await this.access(actor)),
    });
  }

  async page(actor: PlatformActor, request: unknown = {}) {
    const filters = bookmarkQuery.parse(request);
    return this.browser.listBookmarkPage({
      ...filters,
      ...(await this.access(actor)),
    });
  }

  async read(actor: PlatformActor, bookmarkId: string) {
    return this.browser.readBookmark({
      ...(await this.access(actor)),
      bookmarkId,
    });
  }

  async command(
    actor: PlatformActor,
    raw: unknown,
  ): Promise<{ source: "browser"; receipt: BookmarkCommandReceipt }> {
    const command = commandSchema.parse(raw);
    const operation = bookmarkOperation.parse(command.operation);
    const access = await this.access(actor);
    return {
      source: "browser",
      receipt: await this.browser.command({
        ...access,
        commandId: command.commandId,
        operation,
      }),
    };
  }
}
