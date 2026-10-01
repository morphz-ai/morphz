import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  DomainError,
  type AccessContext,
} from "../../../packages/core/src/model.js";
import {
  browserActionSchema,
  pageStateSchema,
  type BrowserReceipt,
  type BrowserPageState,
} from "../../../packages/core/src/browser.js";
import type { WorkspaceStore } from "./store.js";
import type { HostInvocation } from "./agent-tools.js";
import type { openApplicationDomainsHost } from "./application-domains-host.js";
import { stableId } from "./stable-id.js";
import type { BrowserControlJournal } from "./browser-control-journal.js";

type Page = {
  state: BrowserPageState;
  principalId: string;
  projectId: string;
  key: Buffer;
  seen: number;
};
export type BrowserPageAuthority = {
  authorizeProject(projectId: string, access: AccessContext): Promise<void>;
  readWebsite(
    contentId: string,
    access: AccessContext,
  ): Promise<{ projectId: string }>;
};
type ApplicationDomains = Awaited<
  ReturnType<typeof openApplicationDomainsHost>
>;
type BrowserDomains = {
  work: ApplicationDomains["work"];
  content: Pick<
    ApplicationDomains["content"],
    "authority" | "platform" | "objects" | "instanceIds"
  >;
};

/** Browser pages use the same live Platform membership and Objects original
 * as the rest of the application. The renderer's project or URL is not proof.
 */
export function platformBrowserPageAuthority(
  domains: BrowserDomains,
): BrowserPageAuthority {
  return {
    authorizeProject: (projectId, access) =>
      domains.work.authority.withSession(
        access,
        () => {},
        async (actor) => {
          const project = await domains.work.service.getProject(actor, {
            projectId,
          });
          if (project.deletedAt)
            throw new DomainError("forbidden", "项目已删除，不能打开浏览器。");
        },
      ),
    readWebsite: (contentId, access) =>
      domains.content.authority.withSession(
        access,
        () => {},
        async (actor) => {
          const entry = await domains.content.platform.content(
            actor,
            contentId,
          );
          if (entry.instance_id !== domains.content.instanceIds.objects)
            throw new DomainError("invalid", "所选内容不是网站对象。");
          const original = await domains.content.objects.readObject({
            credential: actor.credential,
            objectId: entry.app_object_id,
          });
          if (original.content.kind !== "website")
            throw new DomainError("invalid", "所选内容不是网站对象。");
          return { projectId: original.projectId };
        },
      ),
  };
}
const updateSchema = z
  .object({
    state: pageStateSchema,
    receipts: z
      .array(
        z
          .object({
            id: z.uuid(),
            status: z.enum(["executing", "succeeded", "rejected", "unknown"]),
            result: z.string().max(45000).nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export const browserToolSchema = z
  .object({
    pageId: z.uuid().optional(),
    epoch: z.uuid().optional(),
    requestId: z.uuid().optional(),
    action: browserActionSchema.optional(),
  })
  .strict();

/** Host-local at-most-once control; live grants never survive a Host restart. */
export class BrowserBroker {
  private pages = new Map<string, Page>();
  private readonly journal: BrowserControlJournal;
  private readonly receiptWaiters = new Map<string, Set<() => void>>();
  constructor(
    store: Pick<WorkspaceStore, "browserControlJournal">,
    private readonly authority: BrowserPageAuthority,
    private now = () => Date.now(),
  ) {
    this.journal = store.browserControlJournal();
    this.journal.expireInFlight();
  }
  private expire() {
    for (const [id, page] of this.pages)
      if (this.now() - page.seen > 10000) {
        this.invalidate(id, "桌面连接已断开。");
        this.pages.delete(id);
      }
  }
  private invalidate(pageId: string, message: string) {
    this.journal.invalidatePage(pageId, message);
    this.notifyReceiptWaiters();
  }
  private notifyReceiptWaiters() {
    for (const waiters of this.receiptWaiters.values())
      for (const wake of [...waiters]) wake();
  }
  /** Wait inside the original Runtime tool call, not by fabricating a Human
   * message. A slow approval stays pending and can be read by request ID. */
  async waitForResult(id: string, timeoutMs = 12_000): Promise<BrowserReceipt> {
    const read = () => this.journal.read(id)?.receipt;
    const current = read();
    if (!current) throw new DomainError("not_found", "浏览器操作不存在。");
    if (["succeeded", "rejected", "unknown"].includes(current.status))
      return current;
    return new Promise<BrowserReceipt>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        const receipt = read();
        if (
          receipt &&
          ["succeeded", "rejected", "unknown"].includes(receipt.status)
        ) {
          clearTimeout(timer);
          const waiters = this.receiptWaiters.get(id);
          waiters?.delete(finish);
          if (!waiters?.size) this.receiptWaiters.delete(id);
          resolve(receipt);
        }
      };
      const waiters = this.receiptWaiters.get(id) ?? new Set<() => void>();
      waiters.add(finish);
      this.receiptWaiters.set(id, waiters);
      timer = setTimeout(() => {
        clearTimeout(timer);
        waiters.delete(finish);
        if (!waiters.size) this.receiptWaiters.delete(id);
        resolve(read() ?? current);
      }, timeoutMs);
    });
  }
  async register(raw: unknown, key: string, access: AccessContext) {
    const state = pageStateSchema.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new DomainError("forbidden", "桌面连接凭据无效。");
    const website = state.artifactId
      ? await this.authority.readWebsite(state.artifactId, access)
      : null;
    const projectId = website?.projectId ?? state.projectId;
    if (!projectId) throw new DomainError("invalid", "浏览器缺少工作空间。");
    if (state.projectId && state.projectId !== projectId)
      throw new DomainError("forbidden", "页面不能关联另一项目的对象。");
    await this.authority.authorizeProject(projectId, access);
    if (this.pages.has(state.pageId))
      throw new DomainError("conflict", "页面已登记，请刷新状态而非重复登记。");
    this.pages.set(state.pageId, {
      state: { ...state, granted: false },
      principalId: access.principalId,
      projectId,
      key: createHash("sha256").update(key).digest(),
      seen: this.now(),
    });
    return { registered: true };
  }
  async exchange(raw: unknown, key: string, access: AccessContext) {
    this.expire();
    const update = updateSchema.parse(raw),
      page = this.pages.get(update.state.pageId);
    const hash = createHash("sha256").update(key).digest();
    if (
      !page ||
      page.principalId !== access.principalId ||
      !timingSafeEqual(page.key, hash)
    )
      throw new DomainError("forbidden", "桌面页面连接已失效，请重新打开。");
    await this.authority.authorizeProject(page.projectId, access);
    if (page.state.artifactId) {
      const website = await this.authority.readWebsite(
        page.state.artifactId,
        access,
      );
      if (website.projectId !== page.projectId)
        throw new DomainError(
          "forbidden",
          "网站对象已移到另一项目，请重新打开。",
        );
    }
    if (
      update.state.artifactId !== page.state.artifactId ||
      update.state.projectId !== page.state.projectId
    )
      throw new DomainError("forbidden", "页面不能更换关联对象。");
    // Persist results before invalidating the old epoch: a click may cause navigation.
    for (const result of update.receipts) {
      const r = this.journal.read(result.id)?.receipt;
      if (!r || r.pageId !== page.state.pageId) continue;
      if (["succeeded", "rejected"].includes(r.status)) continue;
      if (result.status === "executing" && r.status !== "queued") continue;
      if (
        result.status === "succeeded" &&
        !["executing", "unknown"].includes(r.status)
      )
        continue;
      this.journal.updateStatus(r.id, result.status, result.result);
      this.notifyReceiptWaiters();
    }
    if (
      page.state.epoch !== update.state.epoch ||
      !update.state.granted ||
      !update.state.visible
    )
      this.invalidate(page.state.pageId, "页面变化或人已接管，旧操作失效。");
    page.state = update.state;
    page.seen = this.now();
    return {
      requests:
        page.state.granted && page.state.visible
          ? [
              this.journal.firstQueued(page.state.pageId, page.state.epoch),
            ].filter((r): r is BrowserReceipt => !!r)
          : [],
    };
  }
  /** Caller must first prove the Runtime input and recheck Platform project
   * membership. No legacy Workspace object or membership is consulted. */
  callAuthorized(
    raw: unknown,
    route: HostInvocation,
    projectId: string,
    ownerPrincipalId: string,
  ) {
    this.expire();
    const args = browserToolSchema.parse(raw);
    if (args.requestId) {
      const stored = this.journal.read(args.requestId);
      if (
        !stored ||
        stored.receipt.projectId !== projectId ||
        (stored.receipt.sourceSessionId &&
          stored.receipt.sourceSessionId !== route.session_id) ||
        stored.ownerPrincipalId !== ownerPrincipalId
      )
        throw new DomainError("not_found", "浏览器操作不存在。");
      return stored.receipt;
    }
    if (!args.action)
      return {
        pages: [...this.pages.values()]
          .filter(
            (p) =>
              p.projectId === projectId &&
              p.principalId === ownerPrincipalId &&
              p.state.granted &&
              p.state.visible,
          )
          .map((p) => p.state),
      };
    const requestId = stableId(
      "browser",
      route.context_id,
      route.session_id,
      route.job_id,
      route.tool_call_id,
    );
    const previous = this.journal.read(requestId);
    if (previous) {
      if (
        previous.receipt.projectId !== projectId ||
        previous.ownerPrincipalId !== ownerPrincipalId ||
        previous.receipt.pageId !== args.pageId ||
        previous.receipt.epoch !== args.epoch ||
        JSON.stringify(previous.receipt.action) !== JSON.stringify(args.action)
      )
        throw new DomainError("conflict", "同一操作标识不能更换内容。");
      return previous.receipt;
    }
    const page = args.pageId && this.pages.get(args.pageId);
    if (
      !page ||
      page.projectId !== projectId ||
      page.principalId !== ownerPrincipalId ||
      !page.state.granted ||
      !page.state.visible ||
      page.state.epoch !== args.epoch
    )
      throw new DomainError(
        "conflict",
        "尚未授权或页面已变化，请等待人允许并重新读取页面。",
      );
    if (args.action.type !== "snapshot") {
      if (
        this.journal.requiresReconciliation(page.state.pageId, page.state.epoch)
      )
        throw new DomainError(
          "conflict",
          "上次操作结果未知，请先重新读取页面核对。",
        );
    }
    if (this.journal.hasInFlight(page.state.pageId))
      throw new DomainError("conflict", "该页面有未完成操作，请先读取其结果。");
    const receipt: BrowserReceipt = {
      id: requestId,
      projectId,
      artifactId: page.state.artifactId,
      sourceSessionId: route.session_id,
      pageId: page.state.pageId,
      epoch: page.state.epoch,
      action: args.action,
      status: "queued",
      createdAt: new Date(this.now()).toISOString(),
      result: null,
    };
    this.journal.insert(receipt, ownerPrincipalId ?? null);
    return receipt;
  }
}
