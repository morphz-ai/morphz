import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type AccessContext,
  type Content,
  DomainError,
} from "../../../packages/core/src/model.js";
import type { WorkspaceStore } from "./store.js";
export const notificationControlSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("settings"),
      mode: z.enum(["all", "high", "off"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200),
    })
    .strict(),
]);
const savedSchema = z.object({
  mode: z.enum(["all", "high", "off"]).default("all"),
  read: z.array(z.string()).max(2000).default([]),
});
export class Notifications {
  constructor(private store: WorkspaceStore) {}
  private key(access: AccessContext) {
    return (
      "notifications-" +
      createHash("sha256").update(access.principalId).digest("hex")
    );
  }
  private saved(access: AccessContext) {
    return savedSchema.parse(this.store.serviceState(this.key(access)) ?? {});
  }
  snapshot(access: AccessContext) {
    const state = this.store.snapshot(),
      saved = this.saved(access);
    if (
      !state.actants.some(
        (a) => a.id === access.actantId && a.principalId === access.principalId,
      )
    )
      throw new DomainError("forbidden", "参与者身份无效。");
    const projects = new Set(
      state.projects
        .filter((p) => p.members.includes(access.principalId))
        .map((p) => p.id),
    );
    const items = state.artifacts
      .filter((a) => projects.has(a.projectId))
      .flatMap((a) => {
        const phase = (c: Content) =>
          c.kind !== "task"
            ? null
            : c.assigneeId === access.actantId &&
                !["completed", "cancelled"].includes(c.execution) &&
                c.assignment !== "declined"
              ? [
                  "human",
                  c.assignment,
                  c.execution === "waiting" ? "waiting" : "ready",
                  c.assigneeId,
                  c.runRequested,
                  c.priority,
                ]
              : c.delivery === "ready" &&
                  a.createdBy.principalId === access.principalId
                ? ["delivery", c.runRequested, c.resultIds, c.priority]
                : null;
        const current = phase(a.content);
        if (!current || a.content.kind !== "task") return [];
        const signature = JSON.stringify(current);
        let entered = a.revision;
        for (const v of [...a.versions].reverse()) {
          if (JSON.stringify(phase(v.content)) !== signature) break;
          entered = v.revision;
        }
        const id = createHash("sha256")
          .update(JSON.stringify([a.id, entered, current]))
          .digest("hex");
        return [
          {
            id,
            artifactId: a.id,
            title: a.title,
            priority: a.content.priority,
            date:
              a.versions.find((v) => v.revision === entered)?.createdAt ??
              a.updatedAt,
            reason:
              current[0] === "delivery"
                ? "有交付等待你核对"
                : "需要你参与的事项",
            read: saved.read.includes(id),
          },
        ];
      })
      .sort(
        (a, b) =>
          ({ high: 0, normal: 1, low: 2 })[a.priority] -
            { high: 0, normal: 1, low: 2 }[b.priority] ||
          b.date.localeCompare(a.date),
      )
      .slice(0, 200);
    return {
      mode: saved.mode,
      items,
      unread: items.filter(
        (i) =>
          !i.read &&
          saved.mode !== "off" &&
          (saved.mode !== "high" || i.priority === "high"),
      ).length,
    };
  }
  control(access: AccessContext, input: unknown) {
    const command = notificationControlSchema.parse(input),
      saved = this.saved(access);
    if (command.action === "settings") saved.mode = command.mode;
    else {
      const visible = new Set(this.snapshot(access).items.map((i) => i.id));
      if (command.ids.some((id) => !visible.has(id)))
        throw new DomainError("forbidden", "通知已变化或无权访问。");
      saved.read = [...new Set([...saved.read, ...command.ids])].slice(-2000);
    }
    this.store.saveServiceState(this.key(access), saved);
    return this.snapshot(access);
  }
}
