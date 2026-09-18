import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket, { WebSocketServer } from "ws";
import {
  SpeechService,
  type SpeechProvider,
} from "../packages/application/src/speech.js";
import { SpeechStreams } from "../packages/application/src/speech-stream.js";
import {
  speechStreamCommandSchema,
  type SpeechStreamCommand,
  type SpeechStreamState,
} from "../packages/core/src/speech-stream.js";
import { Application } from "../packages/application/src/application.js";
import { LocalApplicationConnection } from "../packages/application/src/local-connection.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { createAppServer } from "../apps/service/src/http.js";
import { HttpApplicationClient } from "../packages/core/src/http-application-client.js";
import {
  LiveDictation,
  replaceDictationTail,
} from "../apps/web/src/live-dictation.js";

function response(text: string, final = false) {
  const payload = gzipSync(JSON.stringify({ result: { text } }));
  const frame = Buffer.alloc(12 + payload.length);
  frame.set([0x11, final ? 0x93 : 0x91, 0x11, 0]);
  frame.writeInt32BE(final ? -1 : 1, 4);
  frame.writeUInt32BE(payload.length, 8);
  payload.copy(frame, 12);
  return frame;
}
function fixture() {
  let result!: (text: string, final: boolean) => void;
  let error!: (message: string) => void;
  let closed = 0;
  const writes: Uint8Array[] = [];
  const provider: SpeechProvider = {
    provider: { id: "fixture", label: "Fixture" },
    configured: () => true,
    transcribe: async () => "",
    synthesize: async () => Buffer.alloc(0),
    openStream: (_principal, callback, failed) => {
      result = callback;
      error = failed;
      return {
        ready: Promise.resolve(),
        write: (data) => {
          writes.push(data);
        },
        finish: () => result("最终句子。", true),
        close: () => {
          closed++;
        },
      };
    },
  };
  return {
    provider,
    writes,
    result: (text: string, final = false) => result(text, final),
    error: (text: string) => error(text),
    closed: () => closed,
  };
}

test("真实 WebSocket 协议：不等待首包就发 PCM，停止前收到增量，最终帧负序号", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const frames: Buffer[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const frame = Buffer.from(raw as Buffer);
      frames.push(frame);
      if (frame[1]! >> 4 === 1) {
        const config = JSON.parse(gunzipSync(frame.subarray(12)).toString());
        assert.equal(config.audio.format, "pcm");
        assert.equal(config.request.result_type, "full");
        return; // Deliberately no initial ACK.
      }
      socket.send(
        response(
          frames.length === 2 ? "语音输" : "语音输入。",
          !!(frame[1]! & 2),
        ),
      );
    }),
  );
  const provider = new SpeechService("private-key", fetch, (url, options) => {
    assert.match(url, /\/plan\/sauc\/bigmodel_async$/);
    assert.equal(options.headers?.["X-Api-Key"], "private-key");
    return new WebSocket(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
  });
  const results: Array<[string, boolean]> = [];
  const errors: string[] = [];
  const stream = provider.openStream(
    "human",
    (text, final) => results.push([text, final]),
    (message) => errors.push(message),
  );
  try {
    await stream.ready;
    assert.throws(
      () =>
        provider.openStream(
          "human",
          () => {},
          () => {},
        ),
      /正在处理/,
    );
    stream.write(new Uint8Array(6400));
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (results.length) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
      interval.unref();
    });
    assert.deepEqual(results, [["语音输", false]]);
    stream.finish();
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (results.at(-1)?.[1]) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
      interval.unref();
    });
    assert.deepEqual(results.at(-1), ["语音输入。", true]);
    assert.equal(frames.at(-1)!.readInt32BE(4), -3);
    assert.equal(gunzipSync(frames.at(-1)!.subarray(12)).length, 0);
    assert.deepEqual(errors, []);
    const next = provider.openStream(
      "human",
      () => {},
      () => {},
    );
    next.close();
    await assert.rejects(next.ready);
  } finally {
    stream.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("共享听写状态：增量订阅、幂等帧、最终结果与调用者/来源隔离", async () => {
  const f = fixture(),
    streams = new SpeechStreams(f.provider),
    id = randomUUID();
  const scope = { projectId: "first-project" };
  const call = (action: Record<string, unknown>, owner = "human") =>
    streams.call(
      speechStreamCommandSchema.parse({ id, scope, ...action }),
      owner,
      () => {},
      new AbortController().signal,
    );
  try {
    const initial = await call({ action: "open" });
    const pending = call({ action: "read", after: initial.revision });
    f.result("现在就显示");
    assert.equal((await pending).text, "现在就显示");
    const push = { action: "push", sequence: 1, data: new Uint8Array(6400) };
    await call(push);
    await call(push);
    assert.equal(f.writes.length, 1);
    await assert.rejects(
      call({ action: "read", after: 0 }, "other"),
      /其他身份/,
    );
    await assert.rejects(
      call({ action: "read", scope: { projectId: "other" }, after: 0 }),
      /其他身份/,
    );
    assert.equal(f.closed(), 0);
    const final = await call({ action: "finish" });
    assert.equal(final.status, "complete");
    assert.equal(final.text, "最终句子。");
    assert.equal(f.closed(), 1);
    await assert.rejects(call(push), /听写已停止/);
  } finally {
    streams.close();
  }
});

test("权限撤回、取消订阅与错误帧停止语音，不泄漏迟到结果", async () => {
  for (const scenario of [
    "permission",
    "abort",
    "sequence",
    "provider",
  ] as const) {
    const f = fixture(),
      streams = new SpeechStreams(f.provider),
      id = randomUUID();
    const scope = { projectId: "first-project" },
      controller = new AbortController();
    let allowed = true;
    const call = (action: Record<string, unknown>) =>
      streams.call(
        speechStreamCommandSchema.parse({ id, scope, ...action }),
        "human",
        () => {
          if (!allowed) throw new Error("permission revoked");
        },
        controller.signal,
      );
    try {
      await call({ action: "open" });
      const pending = call({ action: "read", after: 0 });
      if (scenario === "abort") controller.abort();
      if (scenario === "permission") {
        allowed = false;
        f.result("不得显示");
      }
      if (scenario === "sequence")
        await assert.rejects(
          call({ action: "push", sequence: 2, data: [0, 0] }),
          /顺序/,
        );
      if (scenario === "provider") f.error("连接中断");
      if (["abort", "permission"].includes(scenario))
        await assert.rejects(pending);
      else assert.ok(["error", "cancelled"].includes((await pending).status));
      assert.equal(f.closed(), 1);
      f.result("迟到结果", true);
      assert.equal(f.closed(), 1);
    } finally {
      streams.close();
    }
  }
  for (const data of [[], [1], [-1, 0], new Uint8Array(6402)])
    assert.throws(() =>
      speechStreamCommandSchema.parse({
        id: randomUUID(),
        scope: { projectId: "p" },
        action: "push",
        sequence: 1,
        data,
      }),
    );
});

test("Desktop IPC 和 Web HTTP 都调用共享实时听写，身份失效会关连接", async () => {
  const store = new WorkspaceStore(":memory:"),
    f = fixture();
  const application = new Application(store, { speech: f.provider });
  const local = new LocalApplicationConnection(application);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = createAppServer(store, {
    port,
    webRoot: "/nonexistent",
    speech: f.provider,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const remote = new HttpApplicationClient(origin, (url, options) =>
    fetch(url, {
      ...options,
      headers: { ...options?.headers, Origin: origin },
    }),
  );
  const boot = await local.invoke({ id: randomUUID(), method: "workspace" });
  assert.ok(boot.ok);
  const generation = (boot.value as { csrfToken: string }).csrfToken;
  const remoteBoot = (await remote.call("workspace")) as { csrfToken: string };
  const scope = { projectId: "first-project" };
  try {
    for (const mode of ["local", "remote"] as const) {
      const id = randomUUID();
      const call = async (action: Record<string, unknown>) => {
        const params = { id, scope, ...action };
        if (mode === "remote")
          return remote.call("speech.stream", params, {
            identityGeneration: remoteBoot.csrfToken,
          });
        const reply = await local.invoke({
          id: randomUUID(),
          method: "speech.stream",
          params,
          identityGeneration: generation,
        });
        assert.ok(reply.ok, JSON.stringify(reply));
        return reply.value;
      };
      await call({ action: "open" });
      await call({ action: "push", sequence: 1, data: new Uint8Array(6400) });
      f.result("停止前的文字");
      assert.equal(
        ((await call({ action: "read", after: 0 })) as SpeechStreamState).text,
        "停止前的文字",
      );
      assert.equal(
        ((await call({ action: "finish" })) as SpeechStreamState).status,
        "complete",
      );
    }
    const id = randomUUID();
    await local.invoke({
      id: randomUUID(),
      method: "speech.stream",
      params: { id, scope, action: "open" },
      identityGeneration: generation,
    });
    const pending = local.invoke({
      id: randomUUID(),
      method: "speech.stream",
      params: { id, scope, action: "read", after: 0 },
      identityGeneration: generation,
    });
    local.invalidate();
    assert.equal((await pending).ok, false);
    assert.equal(f.closed(), 3);
  } finally {
    local.close();
    application.speechStreams.close();
    server.closeStreams();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("前端累计文本是替换而非叠加；停止前增量可见，手工修改不被覆盖", async () => {
  const f = fixture(),
    streams = new SpeechStreams(f.provider),
    id = randomUUID();
  let body = "原有草稿",
    ended = false;
  const errors: string[] = [];
  const live = new LiveDictation(
    (command, signal) =>
      streams.call(
        { ...command, id, scope: { projectId: "p" } } as SpeechStreamCommand,
        "human",
        () => {},
        signal,
      ),
    (text, previous) => {
      body = replaceDictationTail(body, text, previous);
    },
    (message) => errors.push(message),
    () => {
      ended = true;
    },
  );
  try {
    live.enqueue(new Uint8Array(6400));
    await live.start();
    f.result("现在");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(body, "原有草稿\n现在");
    f.result("现在显示");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(body, "原有草稿\n现在显示");
    await live.finish();
    assert.equal(body, "原有草稿\n最终句子。");
    assert.equal(ended, true);
    assert.deepEqual(errors, []);
    assert.equal(
      replaceDictationTail("手动改过了", "识别结果", "现在显示"),
      "手动改过了",
    );
    assert.equal(
      replaceDictationTail("a".repeat(30000), "新文字", ""),
      "a".repeat(30000),
    );
  } finally {
    live.cancel();
    streams.close();
  }
});

test("前端断流与背压停止上传，取消后不接受迟到识别，也不自动重播音频", async () => {
  const calls: string[] = [],
    errors: string[] = [],
    text: string[] = [];
  const id = randomUUID();
  let release!: (state: SpeechStreamState) => void;
  const live = new LiveDictation(
    async (command) => {
      calls.push(command.action);
      if (command.action === "open")
        return new Promise((resolve) => {
          release = resolve;
        });
      return { id, revision: 0, text: "", status: "cancelled" };
    },
    (value) => text.push(value),
    (message) => errors.push(message),
    () => {},
  );
  const opening = live.start();
  for (let i = 0; i < 26; i++) live.enqueue(new Uint8Array(6400));
  assert.match(errors[0]!, /跟不上/);
  release({ id, revision: 1, text: "不能插入", status: "listening" });
  await opening;
  assert.deepEqual(calls, ["open", "cancel"]);
  assert.deepEqual(text, []);
  live.enqueue(new Uint8Array(6400));
  assert.deepEqual(calls, ["open", "cancel"]);
});

test("没有音频的孤立连接有到期时间；只读订阅不能无限占用服务", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"] });
  const f = fixture(),
    streams = new SpeechStreams(f.provider),
    id = randomUUID();
  const call = (action: Record<string, unknown>) =>
    streams.call(
      speechStreamCommandSchema.parse({
        id,
        scope: { projectId: "p" },
        ...action,
      }),
      "human",
      () => {},
      new AbortController().signal,
    );
  try {
    await call({ action: "open" });
    t.mock.timers.tick(16000);
    const state = await call({ action: "read", after: 0 });
    assert.equal(state.status, "error");
    assert.match(state.error!, /采集中断/);
    assert.equal(f.closed(), 1);
  } finally {
    streams.close();
  }
});
