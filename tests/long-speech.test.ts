import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  readingChunks,
  readingChapters,
  readingProgress,
} from "../packages/core/src/reading.js";
import { ReadAloud } from "../apps/web/src/read-aloud.js";
import { SpeechQueue } from "../apps/web/src/speech-queue.js";
import { documentTextIssue } from "../packages/core/src/sources.js";
import { WorkspaceStore } from "../apps/service/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { randomUUID } from "node:crypto";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("百万字小说完整分段，章节对齐，不丢字、不拆分代理对，完整对象可保存", () => {
  const text =
    "第一章 起点\n" +
    "新的故事🦋继续。".repeat(120000) +
    "\n第二章 终点\n全文结束。";
  assert.ok(text.length > 1000000);
  assert.equal(documentTextIssue(text), null);
  const chunks = readingChunks(text);
  assert.equal(chunks.map((c) => text.slice(c.start, c.end)).join(""), text);
  assert.ok(chunks.every((c) => c.end - c.start <= 2000));
  assert.ok(
    chunks.every((c) => !/[\ud800-\udbff]$/.test(text.slice(c.start, c.end))),
  );
  const chapters = readingChapters(text, chunks);
  assert.equal(chapters.length, 2);
  assert.ok(text.slice(chunks[chapters[1]!.chunk]!.start).startsWith("第二章"));
  const store = new WorkspaceStore(":memory:");
  try {
    const receipt = store.execute(
      {
        commandId: randomUUID(),
        operation: {
          type: "import-document",
          projectId: "first-project",
          relativePath: "novel.txt",
          text,
        },
      },
      localAccess,
    );
    const document = store
      .snapshot()
      .artifacts.find((a) => a.id === receipt.entityId)!;
    assert.equal(document.content.kind, "document");
    assert.equal(
      document.content.kind === "document" && document.content.markdown,
      text,
    );
  } finally {
    store.close();
  }
});

class FakeAudio {
  src = "";
  currentTime = 0;
  duration = 30;
  playbackRate = 1;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  async play() {
    this.paused = false;
    this.onloadedmetadata?.();
  }
  pause() {
    this.paused = true;
  }
}
test("长文只预加载下一段，暂停续听不重新合成当前段，自动接续与重开进度", async () => {
  const source = "这是一篇很长的文章。".repeat(1000),
    chunks = readingChunks(source);
  const calls: string[] = [],
    players: FakeAudio[] = [],
    saved: unknown[] = [];
  const reader = new ReadAloud({
    source,
    chunks,
    progress: null,
    synthesize: async (text) => {
      calls.push(text);
      return new Blob(["wav"]);
    },
    changed: () => {},
    save: (value) => saved.push(value),
    audio: () => {
      const p = new FakeAudio();
      players.push(p);
      return p as unknown as HTMLAudioElement;
    },
  });
  assert.equal(calls.length, 0);
  await reader.play();
  await tick();
  assert.equal(calls.length, 2);
  players[0]!.currentTime = 8;
  players[0]!.ontimeupdate!();
  reader.pause();
  assert.equal(players[0]!.paused, true);
  assert.equal(reader.state.seconds, 8);
  await reader.play();
  assert.equal(calls.length, 2);
  players[0]!.onended!();
  await tick();
  assert.equal(reader.state.index, 1);
  assert.equal(reader.state.phase, "playing");
  reader.seek(5);
  assert.equal(reader.state.seconds, 0);
  assert.equal(reader.state.phase, "paused");
  reader.dispose();
  assert.equal(readingProgress(saved.at(-1), chunks.length).index, 5);
  const priorCalls = calls.length;
  await tick();
  assert.equal(calls.length, priorCalls);
});
test("合成中关闭或跳转，迟到结果不播放；预加载失败不会自动重试付费请求", async () => {
  const source = "正文。".repeat(1200),
    chunks = readingChunks(source);
  let deliver!: (b: Blob) => void,
    calls = 0,
    played = 0;
  const reader = new ReadAloud({
    source,
    chunks,
    progress: null,
    synthesize: () => {
      calls++;
      return new Promise((resolve) => {
        deliver = resolve;
      });
    },
    changed: () => {},
    save: () => {},
    audio: () => {
      played++;
      return new FakeAudio() as unknown as HTMLAudioElement;
    },
  });
  const pending = reader.play();
  reader.seek(1);
  deliver(new Blob());
  await pending;
  assert.equal(played, 0);
  assert.equal(reader.state.index, 1);
  assert.equal(calls, 1);
  reader.dispose();
  const audio: FakeAudio[] = [];
  let requests = 0;
  const failing = new ReadAloud({
    source,
    chunks,
    progress: null,
    synthesize: async () => {
      if (++requests > 1) throw new Error("断线");
      return new Blob();
    },
    changed: () => {},
    save: () => {},
    audio: () => {
      const p = new FakeAudio();
      audio.push(p);
      return p as unknown as HTMLAudioElement;
    },
  });
  await failing.play();
  await tick();
  audio[0]!.onended!();
  await tick();
  assert.equal(requests, 2);
  assert.equal(failing.state.phase, "error");
  assert.equal(failing.state.index, 1);
  failing.dispose();
});
test("连续采集超过 60 秒，分段逐样本无丢失；结束保留不足一段的尾音", () => {
  let Processor: any;
  const messages: { pcm?: ArrayBuffer; finished?: boolean }[] = [];
  runInNewContext(
    readFileSync(
      new URL("../apps/web/src/speech-capture.worklet.js", import.meta.url),
      "utf8",
    ),
    {
      sampleRate: 16000,
      Int16Array,
      Math,
      AudioWorkletProcessor: class {
        port = {
          postMessage: (value: any) => messages.push(value),
          onmessage: null,
        };
      },
      registerProcessor: (_name: string, value: any) => {
        Processor = value;
      },
    },
  );
  const processor = new Processor({ processorOptions: { segmentSeconds: 10 } });
  const total = 16000 * 65 + 71;
  for (let offset = 0; offset < total; offset += 257) {
    const samples = new Float32Array(Math.min(257, total - offset));
    for (let i = 0; i < samples.length; i++)
      samples[i] = ((offset + i) % 100) / 100;
    assert.equal(processor.process([[samples]]), true);
  }
  processor.port.onmessage({ data: "finish" });
  const audio = messages
    .filter((m) => m.pcm)
    .map((m) => new Int16Array(m.pcm!));
  assert.equal(audio.length, 7);
  assert.equal(
    audio.reduce((n, a) => n + a.length, 0),
    total,
  );
  let offset = 0;
  for (const chunk of audio)
    for (const value of chunk) {
      assert.equal(
        value,
        Math.round(Math.fround((offset++ % 100) / 100) * 32767),
      );
    }
  assert.equal(messages.at(-1)!.finished, true);
  assert.equal(processor.process([]), false);
});
test("识别串行保序、断线保留待处理段、显式重试不重复已完成文字、取消无迟到文字", async () => {
  const text: string[] = [];
  let fail = true;
  let pressures = 0;
  const queue = new SpeechQueue({
    transcribe: async (wav) => {
      const value = await wav.text();
      if (value === "2" && fail) throw new Error("网络断开");
      return value;
    },
    text: (value) => text.push(value),
    changed: () => {},
    pressure: () => pressures++,
  });
  for (const value of ["1", "2", "3"]) queue.enqueue(new Blob([value]));
  await tick();
  await tick();
  assert.deepEqual(text, ["1"]);
  assert.equal(queue.length, 2);
  assert.ok(pressures > 0);
  fail = false;
  queue.retry();
  await tick();
  await tick();
  assert.deepEqual(text, ["1", "2", "3"]);
  assert.equal(queue.length, 0);
  queue.cancel();
  let resolve!: (text: string) => void;
  const cancelled = new SpeechQueue({
    transcribe: () =>
      new Promise((r) => {
        resolve = r;
      }),
    text: (value) => text.push(value),
    changed: () => {},
    pressure: () => {},
  });
  cancelled.enqueue(new Blob());
  cancelled.cancel();
  resolve("不应出现");
  await tick();
  assert.deepEqual(text, ["1", "2", "3"]);
});
