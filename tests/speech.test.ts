import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { wavFromPCM, readSpeechWav } from "../packages/core/src/audio.js";
import {
  SpeechService,
  asrFrame,
  asrResponse,
} from "../apps/service/src/speech.js";
test("语音输入校验声道、采样率、长度；拒绝伪装文件和超长录音", () => {
  const wav = wavFromPCM(new Uint8Array(3200));
  assert.equal(readSpeechWav(wav).length, 3200);
  for (const bytes of [new Uint8Array(10), wavFromPCM(new Uint8Array(1920002))])
    assert.throws(() => readSpeechWav(bytes));
  wav[24] = 0;
  assert.throws(() => readSpeechWav(wav));
});
test("语音识别二进制帧的序列、压缩和最终结果解析", () => {
  const request = asrFrame(Buffer.from("payload"), 2, true, true);
  assert.equal(request.readInt32BE(4), -2);
  assert.equal(request[1], 0x23);
  assert.equal(gunzipSync(request.subarray(12)).toString(), "payload");
  const payload = gzipSync(JSON.stringify({ result: { text: "合成测试" } }));
  const response = Buffer.alloc(12 + payload.length);
  response.set([0x11, 0x93, 0x11, 0]);
  response.writeInt32BE(-3, 4);
  response.writeUInt32BE(payload.length, 8);
  payload.copy(response, 12);
  assert.deepEqual(asrResponse(response), { last: true, text: "合成测试" });
  assert.throws(() => asrResponse(response.subarray(0, 10)));
});
test("TTS 接受分片 JSON，密钥仅在官方请求头，错误不能回传密钥", async () => {
  const service = new SpeechService(
    "private-test-key",
    async (url, options) => {
      assert.equal(
        url,
        "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
      );
      assert.equal(
        new Headers(options!.headers).get("X-Api-Key"),
        "private-test-key",
      );
      assert.equal(options!.redirect, "error");
      const data = JSON.stringify({
        code: 0,
        message: "x{y}",
        data: Buffer.alloc(3200).toString("base64"),
      });
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(data.slice(0, 20)));
            c.enqueue(
              new TextEncoder().encode(
                data.slice(20) +
                  '\n{"code":0,"data":null}\n{"code":20000000,"data":null}\n',
              ),
            );
            c.close();
          },
        }),
      );
    },
  );
  const wav = await service.synthesize(
    "p",
    "合成测试",
    new AbortController().signal,
  );
  assert.equal(readSpeechWav(wav).length, 3200);
  const incomplete = new SpeechService(
    "private-test-key",
    async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: Buffer.alloc(3200).toString("base64"),
        }),
      ),
  );
  await assert.rejects(
    () => incomplete.synthesize("p", "测试", new AbortController().signal),
    /响应中断/,
  );
  const failed = new SpeechService("private-test-key", async () => {
    throw new Error("private-test-key");
  });
  await assert.rejects(
    () => failed.synthesize("p", "测试", new AbortController().signal),
    (e) => e instanceof Error && !e.message.includes("private-test-key"),
  );
  await assert.rejects(
    () =>
      new SpeechService(undefined).synthesize(
        "p",
        "测试",
        new AbortController().signal,
      ),
    /未配置/,
  );
});
