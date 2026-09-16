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
      mode: z.enum(["all", "off"]),
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
  private projection(access: AccessContext) {
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
                ]
              : c.delivery === "ready" &&
                  a.createdBy.principalId === access.principalId
                ? ["delivery", c.runRequested, c.resultIds]
                : null;
        const current = phase(a.content);
        if (!current || a.content.kind !== "task") return [];
        const signature = JSON.stringify(current);
        // A priority-only edit was once a new notification. Collapse those
        // segments, but honor both saved and still-pending legacy receipts.
        const versions = [];
        for (const v of [...a.versions].reverse()) {
          if (JSON.stringify(phase(v.content)) !== signature) break;
          versions.push(v);
        }
        versions.reverse();
        const entered = versions[0]?.revision ?? a.revision;
        const hash = (revision: number, value: unknown) =>
          createHash("sha256")
            .update(JSON.stringify([a.id, revision, value]))
            .digest("hex");
        const id = hash(entered, current);
        const aliases: string[] = [];
        let previous = "";
        for (const v of versions) {
          if (v.content.kind !== "task") continue;
          const legacy = [...current, v.content.priority];
          const value = JSON.stringify(legacy);
          if (value !== previous) aliases.push(hash(v.revision, legacy));
          previous = value;
        }
        return [
          {
            id,
            aliases,
            artifactId: a.id,
            title: a.title,
            date:
              a.versions.find((v) => v.revision === entered)?.createdAt ??
              a.updatedAt,
            reason:
              current[0] === "delivery"
                ? "有交付等待你核对"
                : "需要你参与的事项",
            read: [id, ...aliases].some((value) => saved.read.includes(value)),
          },
        ];
      })
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      .slice(0, 200);
    return { saved, items };
  }
  snapshot(access: AccessContext) {
    const { saved, items } = this.projection(access);
    // Do not silently broaden a person's old, restricted notification choice.
    // Keep it in storage until they explicitly choose one of the new modes.
    const mode = saved.mode === "high" ? "off" : saved.mode;
    return {
      mode,
      needsReview: saved.mode === "high",
      items: items.map(({ aliases, ...item }) => ({
        ...item,
        readAliases: aliases,
      })),
      unread: mode === "all" ? items.filter((i) => !i.read).length : 0,
    };
  }
  control(access: AccessContext, input: unknown) {
    const command = notificationControlSchema.parse(input),
      { saved, items } = this.projection(access);
    if (command.action === "settings") saved.mode = command.mode;
    else {
      const visible = new Map(
        items.flatMap((i) =>
          [i.id, ...i.aliases].map((id) => [id, i.id] as const),
        ),
      );
      if (command.ids.some((id) => !visible.has(id)))
        throw new DomainError("forbidden", "通知已变化或无权访问。");
      saved.read = [
        ...new Set([
          ...saved.read,
          ...command.ids.map((id) => visible.get(id)!),
        ]),
      ].slice(-2000);
    }
    this.store.saveServiceState(this.key(access), saved);
    return this.snapshot(access);
  }
}
