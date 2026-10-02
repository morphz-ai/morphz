import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { Application } from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import {
  backupCenterStorage,
  restoreCenterStorage,
} from "../packages/application/src/center-backup.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  compileProfileRom,
  parseProfileRom,
  defaultAgentProfile,
  defaultHumanProfile,
  profileHasConfiguredFields,
  profileContract,
  profileRom,
  profileAvatarBytesSchema,
  profileAvatarSnapshotSchema,
  profileSnapshotSchema,
} from "../packages/core/src/profile.js";

test("Profile ROM 单一编译/读取保留中文、引号与反斜线，不把风格当权限", () => {
  const data = {
    ...defaultAgentProfile,
    name: '小智 "朋友"',
    customStyle: "简洁\\准确\n自然",
    traits: { humor: 0, rigor: 0, warmth: 5, verbosity: 5 },
  };
  assert.deepEqual(
    parseProfileRom("agent", compileProfileRom("agent", data)),
    data,
  );
  const human = { name: "谢先生", preferredAddress: "老谢" };
  assert.deepEqual(
    parseProfileRom("human", compileProfileRom("human", human)),
    human,
  );
  assert.throws(() =>
    parseProfileRom("human", '(human-profile (name "我") (name "你"))'),
  );
  assert.throws(() =>
    parseProfileRom("agent", '(agent-profile (identity (name "x")))'),
  );
  assert.throws(() =>
    parseProfileRom(
      "human",
      '(human-profile (name "我") (preferred-address "你")) (extra x)',
    ),
  );
  assert.throws(() =>
    compileProfileRom("agent", {
      ...data,
      traits: { ...data.traits, rigor: 6 },
    }),
  );
});

test("Profile v2每项null完全省略、0保持明确设置，全未设置不附偏好指令", () => {
  assert.equal(profileHasConfiguredFields(defaultAgentProfile), false);
  assert.equal(profileHasConfiguredFields(defaultHumanProfile), false);
  assert.equal(
    compileProfileRom("agent", defaultAgentProfile),
    "(agent-profile (version 2))",
  );
  assert.equal(
    compileProfileRom("human", defaultHumanProfile),
    "(human-profile (version 2))",
  );
  const nameOnly = compileProfileRom("agent", {
    ...defaultAgentProfile,
    name: "阿芷",
  });
  assert.equal(
    /humor|rigor|warmth|verbosity|0–5|value\/5/.test(nameOnly),
    false,
  );
  const humorOnly = compileProfileRom("agent", {
    ...defaultAgentProfile,
    traits: { ...defaultAgentProfile.traits, humor: 5 },
  });
  assert.equal(/rigor|warmth|verbosity/.test(humorOnly), false);
  assert.equal(
    compileProfileRom("agent", { ...defaultAgentProfile, customStyle: "   " }),
    "(agent-profile (version 2))",
  );
  assert.equal(
    compileProfileRom("human", {
      ...defaultHumanProfile,
      preferredAddress: "   ",
    }),
    "(human-profile (version 2))",
  );
  for (const key of ["humor", "rigor", "warmth", "verbosity"] as const) {
    const data = {
      ...defaultAgentProfile,
      traits: { ...defaultAgentProfile.traits, [key]: 0 },
    };
    const body = compileProfileRom("agent", data);
    assert.equal(profileHasConfiguredFields(data), true);
    assert.ok(body.includes(`(${key} 0)`));
    for (const other of ["humor", "rigor", "warmth", "verbosity"].filter(
      (other) => other !== key,
    ))
      assert.equal(body.includes(`(${other} `), false);
    assert.equal(body.includes("(identity "), false);
    assert.equal(body.includes("(speech "), false);
    assert.match(body, /0–5 scale, not model parameters/);
    assert.match(body, /exact selected value as value\/5, not value\/100/);
    assert.deepEqual(
      parseProfileRom("agent", body, profileRom.agent.schemaTag),
      data,
    );
  }
  const partial = { name: null, preferredAddress: "朋友" };
  assert.equal(
    compileProfileRom("human", partial),
    '(human-profile (version 2) (preferred-address "朋友"))',
  );
  assert.deepEqual(
    parseProfileRom("human", compileProfileRom("human", partial)),
    partial,
  );
  assert.deepEqual(
    parseProfileRom("agent", compileProfileRom("agent", defaultAgentProfile)),
    defaultAgentProfile,
  );
  assert.deepEqual(
    parseProfileRom("human", compileProfileRom("human", defaultHumanProfile)),
    defaultHumanProfile,
  );
  assert.throws(() =>
    parseProfileRom(
      "agent",
      "(agent-profile (version 2) (personality (humor 0)))",
    ),
  );
  assert.throws(() =>
    parseProfileRom("agent", "(agent-profile (version 2) (speech))"),
  );
  assert.throws(() =>
    parseProfileRom("human", "(human-profile (version 2) (name x) (name y))"),
  );
  assert.throws(() =>
    parseProfileRom(
      "human",
      "(human-profile (version 2))",
      profileRom.human.legacySchemaTag,
    ),
  );
  const legacy = `(agent-profile (identity (name Morphz)) (personality (humor 2) (rigor 3) (warmth 3) (verbosity 2)) (speech (style natural) (custom "")) (contract ${JSON.stringify(profileContract)}))`;
  assert.deepEqual(
    parseProfileRom("agent", legacy, profileRom.agent.legacySchemaTag),
    {
      name: "Morphz",
      traits: { humor: 2, rigor: 3, warmth: 3, verbosity: 2 },
      speechStyle: "natural",
      customStyle: null,
    },
  );
  assert.deepEqual(
    parseProfileRom(
      "human",
      '(human-profile (name 我) (preferred-address ""))',
      profileRom.human.legacySchemaTag,
    ),
    { name: "我", preferredAddress: "" },
  );
});

test("头像真实 embedded/HTTP Client 共用双版本CAS，重试不覆盖新值并成套恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "morphz-profile-domain-")),
    source = join(root, "source");
  mkdirSync(source);
  const workspace = new WorkspaceStore(join(source, "workspace.sqlite"), {
    mode: "transport",
  });
  let domains:
    Awaited<ReturnType<typeof openApplicationDomainsHost>> | undefined;
  let server: ReturnType<typeof createAppServer> | undefined;
  let local: LocalApplicationConnection | undefined;
  const png = await sharp({
    create: { width: 360, height: 200, channels: 4, background: "#31b4bb" },
  })
    .png()
    .toBuffer();
  let committed:
    ReturnType<typeof profileAvatarSnapshotSchema.parse> | undefined;
  try {
    domains = await openApplicationDomainsHost(source, workspace);
    const application = new Application(workspace, {
      profiles: domains.profiles,
    });
    local = new LocalApplicationConnection(application);
    const boot = (await local.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const embeddedOptions = { identityGeneration: boot.csrfToken };
    const original = profileSnapshotSchema.parse(
      await local.call("profile.read", {}, embeddedOptions),
    );
    assert.equal(original.human.avatar.revision, 0);
    assert.equal(original.human.available, false); // No fake Runtime fixture.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    server = createAppServer(workspace, {
      port,
      webRoot: "/nonexistent",
      profiles: domains.profiles,
    });
    await new Promise<void>((resolve) =>
      server!.listen(port, "127.0.0.1", resolve),
    );
    const http = new HttpApplicationClient(`http://127.0.0.1:${port}`);
    const httpBoot = (await http.call("platform.bootstrap")) as {
      csrfToken: string;
    };
    const httpOptions = { identityGeneration: httpBoot.csrfToken };
    const command = {
      subject: "human",
      commandId: randomUUID(),
      expectedRevision: 0,
      data: png,
    };
    committed = profileAvatarSnapshotSchema.parse(
      await http.call("profile.avatar.set", command, httpOptions),
    );
    assert.equal(committed.revision, 1);
    assert.equal(committed.media?.poster.mime, "image/png");
    assert.equal(committed.media?.width, 360);
    assert.equal(committed.media?.frames, 1);
    assert.deepEqual(
      await local.call("profile.avatar.set", command, embeddedOptions),
      committed,
    );
    const exact = profileAvatarBytesSchema.parse(
      await http.call(
        "profile.avatar.read",
        { subject: "human", revision: 1, variant: "original" },
        httpOptions,
      ),
    );
    assert.deepEqual(Buffer.from(exact.bytes), png);
    const poster = profileAvatarBytesSchema.parse(
      await local.call(
        "profile.avatar.read",
        { subject: "human", revision: 1, variant: "poster" },
        embeddedOptions,
      ),
    );
    const metadata = await sharp(poster.bytes).metadata();
    assert.equal(metadata.width, 256);
    assert.ok(metadata.height! <= 256);
    assert.deepEqual(
      profileSnapshotSchema.parse(
        await http.call("profile.read", {}, httpOptions),
      ).human.avatar,
      committed,
    );
    await assert.rejects(
      http.call(
        "profile.avatar.set",
        { ...command, principalId: "someone-else", commandId: randomUUID() },
        httpOptions,
      ),
    );
    await assert.rejects(
      local.call(
        "profile.avatar.set",
        { ...command, commandId: randomUUID() },
        embeddedOptions,
      ),
      /头像已更新/,
    );
    await assert.rejects(
      http.call(
        "profile.avatar.read",
        { subject: "human", revision: 0, variant: "original" },
        httpOptions,
      ),
      /头像已更新/,
    );
    const cleared = profileAvatarSnapshotSchema.parse(
      await local.call(
        "profile.avatar.clear",
        { subject: "human", commandId: randomUUID(), expectedRevision: 1 },
        embeddedOptions,
      ),
    );
    assert.deepEqual(cleared, { revision: 2, media: null });
    assert.deepEqual(
      await http.call("profile.avatar.set", command, httpOptions),
      committed,
    );
    assert.equal(
      profileSnapshotSchema.parse(
        await http.call("profile.read", {}, httpOptions),
      ).human.avatar.revision,
      2,
    );
    await assert.rejects(
      local.call(
        "profile.avatar.read",
        { subject: "human", revision: 2, variant: "original" },
        embeddedOptions,
      ),
      /尚未设置头像/,
    );
    const database = new DatabaseSync(join(source, "platform.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          database
            .prepare("SELECT COUNT(*) AS n FROM profile_avatar_versions")
            .get() as { n: number }
        ).n,
        2,
      );
      assert.equal(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM command_receipts WHERE operation='profile-avatar'",
            )
            .get() as { n: number }
        ).n,
        2,
      );
      assert.equal(
        (
          database
            .prepare(
              "SELECT changed_by_principal_id FROM profile_avatar_versions WHERE revision=1",
            )
            .get() as { changed_by_principal_id: string }
        ).changed_by_principal_id,
        localAccess.principalId,
      );
    } finally {
      database.close();
    }
  } finally {
    local?.close();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await domains?.close();
    workspace.close();
  }
  try {
    const backup = await backupCenterStorage({
      sourceDirectory: source,
      backupDirectory: join(root, "backups"),
      writersStopped: true,
    });
    assert.ok(backup.files.includes("profile-avatars"));
    const restored = await restoreCenterStorage({
      backupDirectory: backup.destination,
      destinationDirectory: join(root, "restored"),
      writersStopped: true,
    });
    assert.ok(restored.files.includes("profile-avatars"));
    const db = new DatabaseSync(join(restored.destination, "platform.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          db
            .prepare(
              "SELECT revision FROM profile_avatar_heads WHERE subject_kind='human'",
            )
            .get() as { revision: number }
        ).revision,
        2,
      );
    } finally {
      db.close();
    }
    const restoredWorkspace = new WorkspaceStore(
      join(restored.destination, "workspace.sqlite"),
      { mode: "transport" },
    );
    const reopened = await openApplicationDomainsHost(
      restored.destination,
      restoredWorkspace,
    );
    try {
      assert.deepEqual(
        (
          await new Application(restoredWorkspace, {
            profiles: reopened.profiles,
          })
            .session(localAccess)
            .readProfile()
        ).human.avatar,
        { revision: 2, media: null },
      );
    } finally {
      await reopened.close();
      restoredWorkspace.close();
    }
    // A clear pointer retains recoverable history, so even this cleared head
    // must not cause Host startup or backup to fabricate an empty byte Store.
    const avatarRoot = join(source, "profile-avatars"),
      offlineAvatarRoot = join(source, "profile-avatars-offline");
    renameSync(avatarRoot, offlineAvatarRoot);
    const offlineWorkspace = new WorkspaceStore(
      join(source, "workspace.sqlite"),
      { mode: "transport" },
    );
    try {
      await assert.rejects(
        openApplicationDomainsHost(source, offlineWorkspace),
        /头像原件 Store 缺失/,
      );
      assert.equal(existsSync(avatarRoot), false);
      await assert.rejects(
        backupCenterStorage({
          sourceDirectory: source,
          backupDirectory: join(root, "missing-avatar-backups"),
          writersStopped: true,
        }),
        /头像/,
      );
    } finally {
      offlineWorkspace.close();
      renameSync(offlineAvatarRoot, avatarRoot);
    }
    // Exact subject + variant ownership is part of the pointer, not merely a
    // matching hash in any managed asset. A valid poster cannot pose as original.
    const corrupted = new DatabaseSync(
      join(restored.destination, "platform.sqlite"),
    );
    try {
      corrupted.exec(
        "UPDATE profile_avatar_versions SET original_artifact_id=poster_artifact_id,original_sha256=poster_sha256,original_byte_length=poster_byte_length WHERE revision=1",
      );
    } finally {
      corrupted.close();
    }
    await assert.rejects(
      backupCenterStorage({
        sourceDirectory: restored.destination,
        backupDirectory: join(root, "invalid-variant-backups"),
        writersStopped: true,
      }),
      /头像原件或静态预览与 Store 不一致/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
