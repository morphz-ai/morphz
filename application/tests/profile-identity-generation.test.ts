import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, type Page } from "@playwright/test";

type Call = {
  method: string;
  generation?: string;
  subject?: string;
  variant?: string;
  revision?: number;
  allowed: boolean;
};
type Report = {
  ready: boolean;
  authority: string;
  transportIdentity: string;
  scope: string;
  calls: Call[];
  writes: { generation: string; method: string; name?: string | null }[];
  error: string;
  mediaError: string;
  accessDenied: boolean;
  b: { name: string | null; revision: number; avatarRevision: number };
};
type Outcome = { ok: boolean; status?: number; message?: string };
type FixtureWindow = Window &
  typeof globalThis & {
    profileGenerationFixture: {
      report(): Report;
      run(action: string): Promise<Outcome>;
    };
  };

// Actual React hook + actual applicationCall module; only the bridge's scoped
// authority/store is a fixture. This is not an additional real Host/ROM test.
// Its positive controls parse commands, enforce CAS, persist the fixture head
// and return matching receipts/read-backs; unsupported calls never succeed.
const fixtureModule = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useProfile } from '/src/useProfile.ts';
import { applicationCall, applicationIdentity, RequestError } from '/src/application-transport.ts';
import {
  defaultAgentProfile, defaultHumanProfile, profileSnapshotSchema,
  profileUpdateSchema, profileAvatarCommandSchema, profileAvatarReadSchema,
  profileHasConfiguredFields,
} from '__PROFILE_CORE__';
import type { ProfileSnapshot } from '__PROFILE_CORE__';
import type { WorkspaceClient } from '/src/client.ts';
type Invocation = { method: string; identityGeneration?: string; params?: unknown };
type Reply = { ok: true; value: unknown } | { ok: false; error: { status: number; message: string } };
const generations = { A: 'generation-A', B: 'generation-B' };
let authority: 'A' | 'B' = 'A';
const boot = (actor: 'A' | 'B') => ({ centerId: 'fixture-center', principalId: 'human-' + actor, csrfToken: generations[actor] });
const snapshot = (actor: string): ProfileSnapshot => profileSnapshotSchema.parse({
  human: { data: structuredClone(defaultHumanProfile), revision: 0, available: true, enabled: false, editable: true, avatar: { revision: 0, media: null } },
  agent: { id: 'agent-' + actor, data: structuredClone(defaultAgentProfile), revision: 0, available: true, enabled: false, editable: true, avatar: { revision: 0, media: null } },
  avatarUploadAvailable: true,
});
const heads = { A: snapshot('A'), B: snapshot('B') };
const calls: { method: string; generation?: string; subject?: string; variant?: string; revision?: number; allowed: boolean }[] = [];
const writes: { generation: string; method: string; name?: string | null }[] = [];
const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVioAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const version = (kind: string) => ({ storeId: 'fixture-store-A', artifactId: 'avatar-' + kind, revision: 1, sha256: 'a'.repeat(64), byteLength: imageBytes.length, mime: 'image/png' as const });
const media = { original: version('original'), poster: version('poster'), width: 1, height: 1, frames: 1, durationMs: 0 };
let holdRead = false;
let releaseRead: (() => void) | undefined;
let lateRead: Promise<unknown> | undefined;
const failure = (status: number, message: string): Reply => ({ ok: false, error: { status, message } });
async function invoke(request: Invocation): Promise<Reply> {
  if (request.method === 'platform.bootstrap') return { ok: true, value: boot(authority) };
  const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {};
  const allowed = request.identityGeneration === generations[authority];
  calls.push({ method: request.method, generation: request.identityGeneration, subject: typeof params.subject === 'string' ? params.subject : undefined, variant: typeof params.variant === 'string' ? params.variant : undefined, revision: typeof params.revision === 'number' ? params.revision : undefined, allowed });
  if (!allowed) return failure(403, '身份已切换，旧凭据不能读写当前资料。');
  if (request.method === 'profile.read') {
    const value = structuredClone(heads[authority]);
    if (holdRead) {
      holdRead = false;
      await new Promise<void>(resolve => { releaseRead = resolve; });
    }
    return { ok: true, value };
  }
  if (request.method === 'profile.update') {
    const command = profileUpdateSchema.parse(request.params);
    const subject = heads[authority][command.subject];
    if (subject.revision !== command.expectedRevision) return failure(409, '设定版本冲突。');
    Object.assign(subject, { revision: subject.revision + 1, data: structuredClone(command.data), enabled: command.enabled === true && profileHasConfiguredFields(command.data) });
    writes.push({ generation: generations[authority], method: request.method, name: command.data.name });
    return { ok: true, value: { subject: command.subject, commandId: command.commandId, revision: subject.revision, enabled: subject.enabled, data: structuredClone(subject.data) } };
  }
  if (request.method === 'profile.avatar.read') {
    const command = profileAvatarReadSchema.parse(request.params);
    const avatar = heads[authority][command.subject].avatar;
    if (!avatar.media || avatar.revision !== command.revision) return failure(404, '该头像版本不存在。');
    return { ok: true, value: { bytes: imageBytes.slice(), mime: 'image/png' } };
  }
  if (request.method === 'profile.avatar.set' || request.method === 'profile.avatar.clear') {
    const { data, ...fields } = params;
    const command = profileAvatarCommandSchema.parse(fields);
    const subject = heads[authority][command.subject];
    if (subject.avatar.revision !== command.expectedRevision) return failure(409, '头像版本冲突。');
    if (request.method === 'profile.avatar.set' && !(data instanceof Uint8Array)) return failure(400, '缺少头像字节。');
    subject.avatar = { revision: subject.avatar.revision + 1, media: request.method === 'profile.avatar.set' ? structuredClone(media) : null };
    writes.push({ generation: generations[authority], method: request.method });
    return { ok: true, value: structuredClone(subject.avatar) };
  }
  return failure(501, 'Fixture 不支持该操作。');
}
Object.assign(window, { morphzDesktop: { application: { invoke, cancel() {} } } });
let current: ReturnType<typeof useProfile>;
let mountB: (() => void) | undefined;
function Fixture() {
  const [actor, setActor] = useState<'A' | 'B'>('A');
  // Deliberately do not observe global bootstrap in this fixture client. Only
  // mountB renders the next client, exposing the old-hook/new-global interval.
  const client = { boot: boot(actor), online: true } as WorkspaceClient;
  current = useProfile(client);
  mountB = () => setActor('B');
  return <output data-scope={current.scope}>{current.loading ? 'loading' : 'ready'}</output>;
}
const outcome = async (operation: () => unknown): Promise<{ ok: boolean; status?: number; message?: string }> => {
  try { await operation(); return { ok: true }; }
  catch (error) { return { ok: false, status: error instanceof RequestError ? error.status : undefined, message: error instanceof Error ? error.message : String(error) }; }
};
function queueName(name: string, delay: number) {
  current.edit('agent', { ...current.snapshot!.agent.data, name }, true, delay);
}
Object.assign(window, { profileGenerationFixture: {
  report() {
    return { ready: Boolean(current?.snapshot && !current.loading), authority, transportIdentity: applicationIdentity(), scope: current?.scope, calls: structuredClone(calls), writes: structuredClone(writes), error: current?.autosave.agent.error ?? '', mediaError: current?.media.error ?? '', accessDenied: current?.accessDenied ?? false, b: { name: heads.B.agent.data.name, revision: heads.B.agent.revision, avatarRevision: heads.B.agent.avatar.revision } };
  },
  async run(action: string) {
    if (action === 'positive-save') return outcome(() => { queueName('Confirmed A', 60000); return current.flush('agent'); });
    if (action === 'prepare-late-avatar-read') {
      heads.A.agent.avatar = { revision: 1, media: structuredClone(media) };
      holdRead = true;
      lateRead = current.refresh();
      return { ok: true };
    }
    if (action === 'queue-timer') { queueName('Old A timer', 180); return { ok: true }; }
    if (action === 'queue-flush') { queueName('Old A flush', 60000); return { ok: true }; }
    if (action === 'switch-global-to-B') { authority = 'B'; await applicationCall('platform.bootstrap'); return { ok: true }; }
    if (action === 'release-avatar-read') return outcome(async () => { if (!releaseRead) throw new Error('No held authorized read'); releaseRead(); await lateRead; });
    if (action === 'flush') return outcome(() => current.flush('agent'));
    if (action === 'refresh') return outcome(() => current.refresh());
    if (action === 'set-avatar') return outcome(() => current.setAvatar('agent', new File([imageBytes], 'fixture.png', { type: 'image/png' }), 'fixture-avatar-set', current.snapshot?.agent.avatar.revision ?? 0));
    if (action === 'clear-avatar') return outcome(() => current.clearAvatar('agent', 'fixture-avatar-clear', current.snapshot?.agent.avatar.revision ?? 0));
    if (action === 'mount-B') { mountB!(); return { ok: true }; }
    if (action === 'new-B-save') return outcome(() => { queueName('New B only', 60000); return current.flush('agent'); });
    throw new Error('Unknown fixture action: ' + action);
  },
} });
await applicationCall('platform.bootstrap');
createRoot(document.getElementById('root')!).render(<Fixture/>);
`;

async function report(page: Page): Promise<Report> {
  return page.evaluate(() =>
    (window as FixtureWindow).profileGenerationFixture.report(),
  );
}
async function run(page: Page, action: string): Promise<Outcome> {
  return page.evaluate(
    (value) => (window as FixtureWindow).profileGenerationFixture.run(value),
    action,
  );
}
function assertOldGeneration(calls: Call[]) {
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.generation === "generation-A"));
  assert.ok(calls.every((call) => !call.allowed));
}

const browserExecutable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
test(
  "Profile hook 的旧身份请求不能借用 bootstrap 已更新的全局 generation",
  {
    timeout: 45000,
    skip:
      !browserExecutable && !existsSync(chromium.executablePath())
        ? "No matching Playwright browser; set MORPHZ_TEST_BROWSER_EXECUTABLE for this isolated hook fixture"
        : false,
  },
  async (context) => {
    const source = fixtureModule.replaceAll(
      "__PROFILE_CORE__",
      `/@fs${resolve("packages/core/src/profile.ts")}`,
    );
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      plugins: [
        react(),
        {
          name: "profile-generation-isolated-hook",
          resolveId(id) {
            if (id === "/__profile-generation.tsx")
              return "\0profile-generation.tsx";
          },
          async load(id) {
            if (id === "\0profile-generation.tsx")
              return transformWithOxc(source, "profile-generation.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__profile-generation") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<html><head></head><body><div id="root"></div><script type="module" src="/__profile-generation.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [resolve(".")] },
      },
      logLevel: "error",
    });
    context.after(() => server.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable || undefined,
    });
    context.after(() => browser.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/__profile-generation`;
    async function openFixture() {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(
        () =>
          (window as FixtureWindow).profileGenerationFixture?.report().ready,
      );
      const initial = await report(page);
      assert.equal(initial.scope, "fixture-center:human-A:generation-A");
      assert.equal(initial.transportIdentity, initial.scope);
      return { page, errors };
    }

    await context.test(
      "旧文本 timer、迟到头像读取及 refresh/set/clear 均捕获 A，B 的 head 零写入",
      async () => {
        const { page, errors } = await openFixture();
        try {
          assert.deepEqual(await run(page, "positive-save"), { ok: true });
          const positive = await report(page);
          assert.deepEqual(positive.writes, [
            {
              generation: "generation-A",
              method: "profile.update",
              name: "Confirmed A",
            },
          ]);
          assert.deepEqual(await run(page, "prepare-late-avatar-read"), {
            ok: true,
          });
          await run(page, "queue-timer");
          const beforeSwitch = (await report(page)).calls.length;
          await run(page, "switch-global-to-B");
          const switched = await report(page);
          assert.equal(switched.authority, "B");
          assert.equal(
            switched.transportIdentity,
            "fixture-center:human-B:generation-B",
          );
          assert.equal(switched.scope, "fixture-center:human-A:generation-A");
          await page.waitForFunction(() => {
            const value = (
              window as FixtureWindow
            ).profileGenerationFixture.report();
            return value.calls.some(
              (call) => call.method === "profile.update" && !call.allowed,
            );
          });
          assert.match((await report(page)).error, /旧凭据/);
          assert.deepEqual(await run(page, "release-avatar-read"), {
            ok: true,
          });
          await page.waitForFunction(() => {
            const value = (
              window as FixtureWindow
            ).profileGenerationFixture.report();
            return (
              value.calls.filter(
                (call) =>
                  call.method === "profile.avatar.read" && !call.allowed,
              ).length === 2
            );
          });
          for (const action of ["refresh", "set-avatar", "clear-avatar"]) {
            const rejected = await run(page, action);
            assert.equal(rejected.ok, false, action);
            assert.equal(rejected.status, 403, action);
          }
          const final = await report(page);
          const oldCalls = final.calls.slice(beforeSwitch);
          assertOldGeneration(oldCalls);
          assert.deepEqual(
            oldCalls
              .filter((call) => call.method === "profile.avatar.read")
              .map((call) => ({
                subject: call.subject,
                revision: call.revision,
                variant: call.variant,
              })),
            [
              { subject: "agent", revision: 1, variant: "original" },
              { subject: "agent", revision: 1, variant: "poster" },
            ],
          );
          assert.deepEqual(
            new Set(oldCalls.map((call) => call.method)),
            new Set([
              "profile.update",
              "profile.avatar.read",
              "profile.read",
              "profile.avatar.set",
              "profile.avatar.clear",
            ]),
          );
          assert.equal(final.accessDenied, true);
          assert.deepEqual(final.writes, positive.writes);
          assert.deepEqual(final.b, {
            name: null,
            revision: 0,
            avatarRevision: 0,
          });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );

    await context.test(
      "显式 flush 也拒绝借 B 写旧草稿，真实重绘到 B 后才允许新 B 保存",
      async () => {
        const { page, errors } = await openFixture();
        try {
          await run(page, "queue-flush");
          const beforeSwitch = (await report(page)).calls.length;
          await run(page, "switch-global-to-B");
          const rejected = await run(page, "flush");
          assert.equal(rejected.ok, false);
          assert.equal(rejected.status, 403);
          const old = await report(page);
          assertOldGeneration(old.calls.slice(beforeSwitch));
          assert.equal(old.calls.slice(beforeSwitch).length, 1);
          assert.equal(old.calls.at(-1)?.method, "profile.update");
          assert.equal(old.writes.length, 0);
          assert.deepEqual(old.b, {
            name: null,
            revision: 0,
            avatarRevision: 0,
          });
          await run(page, "mount-B");
          await page.waitForFunction(() => {
            const value = (
              window as FixtureWindow
            ).profileGenerationFixture.report();
            return (
              value.ready &&
              value.scope === "fixture-center:human-B:generation-B"
            );
          });
          assert.deepEqual(await run(page, "new-B-save"), { ok: true });
          const confirmed = await report(page);
          assert.deepEqual(confirmed.writes, [
            {
              generation: "generation-B",
              method: "profile.update",
              name: "New B only",
            },
          ]);
          assert.equal(confirmed.b.name, "New B only");
          assert.equal(confirmed.b.revision, 1);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
  },
);
