import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { IdentityCenter } from "../apps/service/src/identity.js";
import { createAppServer } from "../apps/service/src/http.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { localAccess } from "../packages/core/src/model.js";
import { createDocument } from "../packages/application/src/document-service.js";
import { emptyPlatformStream } from "./platform-stream-fixture.js";

test("两个真实 HTTP 身份：登录、文件和对象隔离、共享项目、伪造拒绝及撤销", async () => {
  const directory = mkdtempSync(join(tmpdir(), "morphz-identity-http-"));
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    }),
    other = { principalId: "other", actantId: "other-human" };
  const projectId = "identity-other-project";
  const privateProject = "identity-private-project";
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const tokens = ["a".repeat(64), "b".repeat(64)],
    config = {
      version: 1,
      members: [localAccess, other].map((access, i) => ({
        ...access,
        loginTokenHash: createHash("sha256").update(tokens[i]!).digest("hex"),
        enabled: true,
      })),
    };
  const identity = new IdentityCenter(store, config),
    probe = createServer();
  const domains = await openApplicationDomainsHost(directory, store, identity);
  const platformTaskId = "identity-private-task";
  let privateId = "";
  await domains.content.authority.withSession(
    localAccess,
    () => {},
    async (actor) => {
      await domains.content.platform.createProject(actor, {
        commandId: randomUUID(),
        projectId: privateProject,
        title: "仅本人项目",
      });
      await domains.content.platform.createTask(actor, {
        commandId: randomUUID(),
        taskId: platformTaskId,
        projectId: privateProject,
        title: "仅本人事项",
        assigneeId: localAccess.actantId,
      });
      const document = await createDocument({
        platform: domains.content.platform,
        objects: domains.content.objects,
        instanceId: domains.content.instanceIds.objects,
        actor,
        commandId: randomUUID(),
        objectId: "identity-private-document",
        projectId: privateProject,
        title: "不能共享的资料",
        markdown: "保密内容",
      });
      privateId = document.contentId;
    },
  );
  await domains.work.authority.withSession(
    other,
    () => {},
    (actor) =>
      domains.content.platform.createProject(actor, {
        commandId: randomUUID(),
        projectId,
        title: "另一位成员的项目",
      }),
  );
  const asset = await domains.images.authority.withSession(
    localAccess,
    () => {},
    (actor) => domains.images.service.upload(actor, png),
  );
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const server = createAppServer(store, {
      port,
      webRoot: "/nonexistent",
      identity,
      bookmarkDomain: domains.browser,
      notifications: domains.notifications,
      platformTaskRuns: domains.taskRuns(),
      messageAttachments: domains.messageAttachments,
      platformWork: domains.work,
      platformDocuments: domains.content,
      images: domains.images,
      runtime: emptyPlatformStream(domains),
    }),
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    assert.equal((await fetch(origin + "/api/platform/bootstrap")).status, 401);
    assert.equal((await fetch(origin + "/api/notifications")).status, 401);
    assert.equal((await fetch(origin + "/api/speech/status")).status, 401);
    assert.equal(
      (
        await fetch(
          origin +
            `/api/platform/projects/${privateProject}/conversations/${privateProject}/stream`,
        )
      ).status,
      401,
    );
    const login = async (token: string) => {
      const r = await fetch(origin + "/api/identity/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      assert.equal(r.status, 200);
      const header = r.headers.get("set-cookie")!;
      assert.ok(
        header.includes("HttpOnly") && header.includes("SameSite=Strict"),
      );
      return header.split(";")[0]!;
    };
    const cookieA = await login(tokens[0]!),
      cookieB = await login(tokens[1]!);
    const boot = async (cookie: string) =>
      (
        await fetch(origin + "/api/platform/bootstrap", {
          headers: { Cookie: cookie },
        })
      ).json();
    const a = await boot(cookieA),
      b = await boot(cookieB);
    assert.equal(a.principalId, localAccess.principalId);
    assert.equal(b.principalId, other.principalId);
    const catalogB = await (
      await fetch(origin + "/api/platform/content", {
        headers: { Cookie: cookieB },
      })
    ).json();
    const projectsA = await (
      await fetch(origin + "/api/platform/projects", {
        headers: { Cookie: cookieA },
      })
    ).json();
    assert.ok(!JSON.stringify(catalogB).includes(privateId));
    assert.ok(!JSON.stringify(projectsA).includes("另一位成员的项目"));
    const get = (path: string) =>
      fetch(origin + path, { headers: { Cookie: cookieB } });
    assert.deepEqual(
      (await (await get("/api/notifications")).json()).items,
      [],
    );
    // Originals conceal unauthorized object existence, unlike a project grant.
    assert.equal(
      (await get("/api/platform/documents/" + privateId)).status,
      404,
    );
    assert.equal(
      (
        await get(
          `/api/platform/projects/${privateProject}/conversations/${privateProject}/stream`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await get(
          `/api/platform/projects/${projectId}/conversations/missing-conversation/stream`,
        )
      ).status,
      404,
    );
    assert.equal((await get("/api/assets/" + asset.assetId)).status, 404);
    const privateAttachmentBytes = Buffer.from("alice private attachment");
    const uploadedAttachment = await fetch(origin + "/api/attachments", {
      method: "POST",
      headers: {
        Cookie: cookieA,
        Origin: origin,
        "X-Morphz-Token": a.csrfToken,
        "X-File-Name": encodeURIComponent("private.txt"),
        "Content-Type": "application/octet-stream",
      },
      body: privateAttachmentBytes,
    });
    assert.equal(uploadedAttachment.status, 201);
    const attachmentId = (
      (await uploadedAttachment.json()) as { assetId: string }
    ).assetId;
    assert.equal(
      (await get("/api/attachments/" + attachmentId)).status,
      404,
      "knowing an upload digest does not grant another Human read access",
    );
    const ownerAttachment = await fetch(
      origin + "/api/attachments/" + attachmentId,
      { headers: { Cookie: cookieA } },
    );
    assert.equal(ownerAttachment.status, 200);
    assert.deepEqual(
      Buffer.from(await ownerAttachment.arrayBuffer()),
      privateAttachmentBytes,
    );
    const privateTask = await get("/api/tasks/" + platformTaskId + "/runtime");
    assert.equal(privateTask.status, 403, await privateTask.text());
    const search = await get("/api/search?q=" + encodeURIComponent("保密"));
    assert.equal(search.status, 200);
    assert.deepEqual((await search.json()).hits, []);
    const post = (
      data: unknown,
      token = b.csrfToken,
      path = "/api/platform/documents",
    ) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          Cookie: cookieB,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morphz-Token": token,
        },
        body: JSON.stringify({ commandId: randomUUID(), ...(data as object) }),
      });
    const image = {
      objectId: "forbidden-image",
      projectId,
      title: "试图引用其他人的上传",
      assetId: asset.assetId,
      alt: "",
    };
    const stolenUpload = await post(image, b.csrfToken, "/api/platform/images");
    // Uploads are principal-scoped: the same digest is not an upload by Bob.
    assert.equal(stolenUpload.status, 400);
    assert.match(await stolenUpload.text(), /请先上传/);
    assert.deepEqual(
      await (await get("/api/platform/content")).json(),
      catalogB,
    );
    assert.equal(
      (await post(image, a.csrfToken, "/api/platform/images")).status,
      403,
    );
    assert.equal(
      (
        await post({
          objectId: "forbidden-document",
          projectId: privateProject,
          title: "越权",
          markdown: "不应创建",
        })
      ).status,
      403,
    );
    // After explicit operator provisioning, both people see the same authorized project.
    const operatorMembers = config.members.map((member) => ({
      principalId: member.principalId,
      actantId: member.actantId,
      enabled: member.enabled,
      projectIds:
        member.principalId === other.principalId
          ? [projectId, privateProject]
          : [privateProject],
    }));
    await identity.replaceConfiguration(config, operatorMembers);
    assert.ok(
      JSON.stringify(
        await (await get("/api/platform/documents/" + privateId)).json(),
      ).includes("保密内容"),
    );
    const shared = await post({
      objectId: "shared-document",
      projectId: privateProject,
      title: "真实成员创作",
      markdown: "共同工作",
    });
    assert.equal(shared.status, 200);
    const receipt = await shared.json();
    assert.equal(
      (await (await get("/api/platform/documents/" + receipt.contentId)).json())
        .author.principalId,
      other.principalId,
    );
    const streamResponse = await get(
      `/api/platform/projects/${projectId}/conversations/${projectId}/stream`,
    );
    assert.equal(
      streamResponse.headers.get("content-type"),
      "text/event-stream",
    );
    const reader = streamResponse.body!.getReader();
    assert.ok(!(await reader.read()).done);
    await identity.replaceConfiguration(
      {
        ...config,
        members: config.members.map((m) => ({
          ...m,
          enabled: m.principalId !== other.principalId,
        })),
      },
      operatorMembers.map((member) => ({
        ...member,
        enabled: member.principalId !== other.principalId,
      })),
    );
    assert.equal((await get("/api/platform/bootstrap")).status, 401);
    await Promise.race([
      (async () => {
        while (!(await reader.read()).done) {}
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("撤销后流未关闭")), 3000).unref(),
      ),
    ]);
    assert.equal(
      (await post(image, b.csrfToken, "/api/platform/images")).status,
      401,
    );
    assert.equal(
      (
        await fetch(origin + "/api/platform/bootstrap", {
          headers: { Cookie: cookieA },
        })
      ).status,
      200,
    );
  } finally {
    server.closeStreams();
    await new Promise<void>((r) => server.close(() => r()));
    await domains.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
