import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type AccessContext,
  DomainError,
} from "../../../packages/core/src/model.js";
import type { PlatformActor, PlatformStore } from "../../platform/src/store.js";
import type { HumanPlatformAuthority } from "./human-platform-authority.js";
export const notificationControlSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("settings"),
      mode: z.enum(["all", "off"]),
      commandId: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read"),
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200),
      commandId: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
type Saved = Awaited<ReturnType<PlatformStore["readNotificationState"]>>;
export class Notifications {
  constructor(
    private platform: PlatformStore,
    private authority: HumanPlatformAuthority,
  ) {}
  private async projection(actor: PlatformActor, saved: Saved) {
    const read = new Set(saved.read);
    const candidates = await this.platform.notificationCandidates(actor);
    const items = candidates.map((candidate) => {
      const current =
        candidate.phase_kind === "human"
          ? [
              "human",
              candidate.assignment,
              candidate.execution === "waiting" ? "waiting" : "ready",
              candidate.assignee_id,
              candidate.run_requested,
            ]
          : ["delivery", candidate.run_requested, candidate.result_ids];
      const id = createHash("sha256")
        .update(
          JSON.stringify([
            candidate.task_id,
            candidate.entered_revision,
            current,
          ]),
        )
        .digest("hex");
      return {
        id,
        artifactId: candidate.task_id,
        title: candidate.title,
        date: candidate.entered_at,
        reason:
          candidate.phase_kind === "delivery"
            ? "有交付等待你核对"
            : "需要你参与的事项",
        read: read.has(id),
      };
    });
    return { items };
  }
  private async view(actor: PlatformActor, saved: Saved) {
    const { items } = await this.projection(actor, saved);
    return {
      mode: saved.mode,
      revision: saved.revision,
      items,
      unread:
        saved.mode === "all" ? items.filter((item) => !item.read).length : 0,
    };
  }
  async snapshot(access: AccessContext, assertActive: () => void = () => {}) {
    return this.authority.withSession(access, assertActive, async (actor) =>
      this.view(actor, await this.platform.readNotificationState(actor)),
    );
  }
  async control(
    access: AccessContext,
    input: unknown,
    assertActive: () => void = () => {},
  ) {
    const command = notificationControlSchema.parse(input);
    return this.authority.withSession(access, assertActive, async (actor) => {
      const saved = await this.platform.readNotificationState(actor);
      if (command.action === "read") {
        const { items } = await this.projection(actor, saved);
        const visible = new Set(items.map((item) => item.id));
        if (
          command.ids.some((id) => !visible.has(id) && !saved.read.includes(id))
        )
          throw new DomainError("forbidden", "通知已变化或无权访问。");
        await this.platform.updateNotificationState(actor, {
          ...command,
        });
      } else await this.platform.updateNotificationState(actor, command);
      return this.view(actor, await this.platform.readNotificationState(actor));
    });
  }
}
