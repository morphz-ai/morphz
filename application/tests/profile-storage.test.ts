import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  PlatformStore,
  type PlatformAuthorityVerifier,
} from "../packages/platform/src/store.js";
import { ProfileService } from "../packages/application/src/profile-service.js";
import { RuntimePlatformAuthority } from "../packages/application/src/runtime-platform-authority.js";
import type { HostInvocation } from "../packages/application/src/agent-tools.js";
import { hostOperations } from "../packages/application/src/agent-tools.js";
import { defaultHumanProfile } from "../packages/core/src/profile.js";

test("Agent Profile请求经过持久根输入来源校验，仅提议并明确待用户确认，不直接改ROM/头像", async () => {
  let active = true;
  const route: HostInvocation = {
    job_id: "job",
    tool_call_id: "call",
    session_id: "session",
    context_id: "context",
    principal_id: "runtime-alice",
    agent_id: "kernel-agent",
    thread_id: "thread",
    target_id: "target",
  };
  const authority = new RuntimePlatformAuthority(
    {
      async readThread() {
        return {
          snapshot: {
            thread: {
              id: "thread",
              session_id: "session",
              context_id: "context",
              root_turn_id: "root",
              initiating_principal_id: "runtime-alice",
              agent_id: "kernel-agent",
              executor_kind: "agent",
              executor_id: null,
            },
          },
        };
      },
      async readSessionEvent() {
        return {
          id: "root",
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: "session",
            context_id: "context",
            principal_id: "runtime-alice",
            client_message_id: "input",
            session_io: {
              request: {
                io_version: "1",
                client_message_id: "input",
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: {
                      type: "object",
                      value: {
                        input_id: { type: "string", value: "input" },
                        workspace_id: { type: "string", value: "project" },
                        author_actant_id: {
                          type: "string",
                          value: "alice-human",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        };
      },
    },
    async (principal, agent) =>
      active && principal === "runtime-alice" && agent === "kernel-agent"
        ? {
            tenantId: "tenant",
            principalId: "alice",
            humanActantId: "alice-human",
            agentActantId: "agent",
          }
        : null,
  );
  const remaining: Omit<PlatformAuthorityVerifier, "resolveActor"> = {
    async resolveActant() {
      return { principalId: "morphz-service", kind: "agent" };
    },
    async resolveProjectAgent() {
      return { principalId: "morphz-service", actantId: "agent" };
    },
    async verifyApplicationObject() {
      return false;
    },
  };
  const agentVerifier = authority.verifier(remaining);
  const platform = await PlatformStore.sqlite(":memory:", {
    ...agentVerifier,
    async resolveActor(actor) {
      return actor.credential === "setup"
        ? {
            tenantId: "tenant",
            principalId: "alice",
            actantId: "alice-human",
            kind: "human",
            runtimeInputId: null,
          }
        : agentVerifier.resolveActor(actor);
    },
  });
  try {
    await platform.provisionTenant("tenant");
    await platform.createProject(
      { credential: "setup" },
      {
        commandId: "project-create",
        projectId: "project",
        title: "真实授权测试",
      },
    );
    let presentationReads = 0;
    const profile = new ProfileService(
      () => undefined,
      platform,
      undefined,
      (access) => {
        presentationReads++;
        assert.equal(access.principalId, "alice");
        assert.equal(access.actantId, "alice-human");
        return "原有身份名";
      },
    );
    const initial = await profile.read({ credential: "setup" });
    assert.equal(initial.human.data.name, null);
    assert.equal(initial.human.revision, 0);
    assert.equal(initial.human.available, false);
    assert.equal(initial.human.enabled, false);
    assert.equal(presentationReads, 0); // Identity display name is not optional ROM data.
    const agentRead = await authority.withInvocation(route, (actor) =>
      profile.agentOperation(actor, { action: "read" }),
    );
    assert.equal((agentRead as typeof initial).human.data.name, null);
    const params = {
      change: {
        subject: "human",
        expectedRevision: 0,
        data: { ...defaultHumanProfile, name: "小谢" },
      },
    };
    const invoked = hostOperations.invoke("profile.propose", params) as {
      action: string;
      profile: unknown;
    };
    assert.equal(invoked.action, "profile");
    const result = await authority.withInvocation(route, (actor) =>
      profile.agentOperation(actor, invoked.profile),
    );
    assert.deepEqual(result, {
      ok: false,
      code: "requires_human_confirmation",
      saved: false,
      proposal: params.change,
      message: "请用户在个人资料中确认后保存；此建议尚未修改 Profile。",
    });
    await authority.withInvocation(route, async (actor) => {
      await assert.rejects(
        profile.update(actor, { ...params.change, commandId: "no-direct-rom" }),
        /用户确认/,
      );
      await assert.rejects(
        platform.updateProfileAvatar(actor, {
          subject: "human",
          commandId: "no-direct-avatar",
          expectedRevision: 0,
          media: null,
        }),
        /用户确认/,
      );
      assert.deepEqual(await platform.readProfileAvatar(actor, "human"), {
        revision: 0,
        media: null,
      });
    });
    assert.throws(() =>
      hostOperations.invoke("profile.propose", {
        change: { ...params.change, principalId: "bob" },
      }),
    );
    assert.throws(() => hostOperations.invoke("profile.update", params));
    await assert.rejects(
      authority.withInvocation(
        { ...route, principal_id: "runtime-bob" },
        (actor) => profile.agentOperation(actor, invoked.profile),
      ),
    );
    active = false;
    await assert.rejects(
      authority.withInvocation(route, (actor) =>
        profile.agentOperation(actor, invoked.profile),
      ),
    );
  } finally {
    await platform.close();
  }
});

const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
test(
  "Profile PostgreSQL与SQLite相同：本人隔离、并发CAS、幂等回执、Team Agent只读",
  { skip: !postgresUrl },
  async () => {
    const tenantId = randomUUID(),
      schema = "profile_" + randomUUID().replaceAll("-", "");
    const pool = new Pool({ connectionString: postgresUrl! });
    const capabilities: PlatformAuthorityVerifier = {
      async resolveActor(actor) {
        if (!["alice", "bob"].includes(actor.credential)) return null;
        return {
          tenantId,
          principalId: actor.credential,
          actantId: actor.credential + "-human",
          kind: "human",
          runtimeInputId: null,
        };
      },
      async resolveActant() {
        return null;
      },
      async resolveProjectAgent() {
        return null;
      },
      async verifyApplicationObject() {
        return false;
      },
      async resolveProfileAgent() {
        return { agentId: "kernel-team-agent", editable: false };
      },
      async verifyProfileAvatar() {
        return true;
      }, // Pointer transaction test; real two-byte Store is tested by profile-domain.
    };
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const first = await PlatformStore.postgres(
      { connectionString: postgresUrl!, schema },
      capabilities,
    );
    let second: PlatformStore | undefined;
    try {
      await first.provisionTenant(tenantId);
      second = await PlatformStore.postgres(
        { connectionString: postgresUrl!, schema },
        capabilities,
      );
      const alice = { credential: "alice" },
        bob = { credential: "bob" };
      const command = {
        subject: "human" as const,
        commandId: "clear-first",
        expectedRevision: 0,
        media: null,
      };
      assert.deepEqual(await first.updateProfileAvatar(alice, command), {
        revision: 1,
        media: null,
      });
      assert.deepEqual(await second.updateProfileAvatar(alice, command), {
        revision: 1,
        media: null,
      });
      const reference = {
        storeId: "fixture-store",
        artifactId: "fixture-original",
        revision: 1,
        sha256: "a".repeat(64),
        byteLength: 10,
        mime: "image/png" as const,
      };
      const media = {
        original: reference,
        poster: { ...reference, artifactId: "fixture-poster" },
        width: 128,
        height: 128,
        frames: 1,
        durationMs: 0,
      };
      const saved = await first.updateProfileAvatar(alice, {
        ...command,
        commandId: "bind-media",
        expectedRevision: 1,
        media,
      });
      assert.deepEqual(saved, { revision: 2, media });
      assert.deepEqual(await second.readProfileAvatar(alice, "human"), saved);
      await assert.rejects(
        first.updateProfileAvatar(alice, {
          ...command,
          commandId: "bad-poster",
          expectedRevision: 2,
          media: { ...media, poster: { ...media.poster, mime: "image/jpeg" } },
        }),
        /字节版本未经核验/,
      );
      await assert.rejects(
        first.updateProfileAvatar(alice, {
          ...command,
          expectedRevision: 2,
          media,
        }),
        /标识已经用于/,
      );
      assert.deepEqual(await second.readProfileAvatar(bob, "human"), {
        revision: 0,
        media: null,
      });
      const concurrent = await Promise.allSettled([
        first.updateProfileAvatar(alice, {
          ...command,
          commandId: "change-a",
          expectedRevision: 2,
        }),
        second.updateProfileAvatar(alice, {
          ...command,
          commandId: "change-b",
          expectedRevision: 2,
        }),
      ]);
      assert.equal(
        concurrent.filter((r) => r.status === "fulfilled").length,
        1,
      );
      assert.equal(concurrent.filter((r) => r.status === "rejected").length, 1);
      assert.deepEqual(await first.readProfileAvatar(alice, "human"), {
        revision: 3,
        media: null,
      });
      assert.deepEqual(await second.updateProfileAvatar(alice, command), {
        revision: 1,
        media: null,
      });
      await assert.rejects(
        first.updateProfileAvatar(alice, {
          ...command,
          subject: "agent",
          commandId: "team-agent-edit",
        }),
        /只读/,
      );
      await assert.rejects(
        first.updateProfileAvatar({ credential: "revoked" }, command),
        /失效/,
      );
      const count = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${schema}".profile_avatar_versions`,
      );
      assert.equal(Number(count.rows[0]!.n), 3);
    } finally {
      await second?.close();
      await first.close();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  },
);
