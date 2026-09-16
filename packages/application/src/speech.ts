import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { z } from "zod";
import { DomainError } from "../../../packages/core/src/model.js";
import {
  maxTtsSegmentCharacters,
  readSpeechWav,
  wavFromPCM,
} from "../../../packages/core/src/audio.js";

export const ttsRequestSchema = z
  .object({ text: z.string().trim().min(1).max(maxTtsSegmentCharacters) })
  .strict();
const audioLimit = 8 * 1024 * 1024;
function failure(message: string) {
  return new DomainError("invalid", message);
}
export function asrFrame(
  payload: Uint8Array,
  sequence: number,
  audio: boolean,
  last = false,
): Buffer {
  const compressed = gzipSync(payload),
    b = Buffer.alloc(12 + compressed.length);
  b[0] = 0x11;
  b[1] = (audio ? 0x20 : 0x10) | (last ? 3 : 1);
  b[2] = (audio ? 0 : 0x10) | 1;
  b.writeInt32BE(last ? -sequence : sequence, 4);
  b.writeUInt32BE(compressed.length, 8);
  compressed.copy(b, 12);
  return b;
}
export function asrResponse(raw: Uint8Array) {
  const b = Buffer.from(raw);
  if (b.length < 8 || b[0]! >> 4 !== 1) throw failure("语音服务响应格式无效。");
  const type = b[1]! >> 4,
    flags = b[1]! & 15,
    serialization = b[2]! >> 4,
    compression = b[2]! & 15;
  let cursor = (b[0]! & 15) * 4;
  if (cursor < 4) throw failure("语音响应头无效。");
  const integer = () => {
    if (cursor + 4 > b.length) throw failure("语音响应不完整。");
    const v = b.readInt32BE(cursor);
    cursor += 4;
    return v;
  };
  if (flags & 1) integer();
  if (flags & 4) integer();
  if (type === 15) {
    const code = integer();
    throw failure(
      `语音识别服务拒绝请求（${code}）。请检查语音模型权限及额度。`,
    );
  }
  if (type !== 9) throw failure("语音服务返回了不支持的消息。");
  const length = integer();
  if (length < 0 || length > audioLimit || cursor + length !== b.length)
    throw failure("语音响应大小无效。");
  let payload = b.subarray(cursor);
  if (compression === 1)
    payload = gunzipSync(payload, { maxOutputLength: 1000000 });
  else if (compression !== 0) throw failure("不支持的语音压缩格式。");
  if (serialization !== 1) throw failure("语音响应不是 JSON。");
  const decoded = z
    .object({
      result: z
        .object({ text: z.string().max(30000).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .parse(JSON.parse(payload.toString("utf8")));
  return { last: !!(flags & 2), text: decoded.result?.text ?? "" };
}
/** The host depends on speech capability, not a vendor SDK or client-side key. */
export interface SpeechProvider {
  readonly provider: { id: string; label: string };
  configured(): boolean;
  synthesize(
    principal: string,
    text: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
  transcribe(
    principal: string,
    wav: Uint8Array,
    signal: AbortSignal,
  ): Promise<string>;
}

/** Current Doubao adapter. Credentials and transport stay in the center process. */
export class SpeechService implements SpeechProvider {
  readonly provider = { id: "doubao", label: "豆包" };
  private active = new Set<string>();
  constructor(
    private key: string | undefined,
    private fetcher: typeof fetch = fetch,
  ) {}
  configured() {
    return !!this.key?.trim();
  }
  private async run<T>(
    principal: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ) {
    if (!this.configured())
      throw failure("尚未配置语音服务，请先完成服务配置。");
    if (this.active.has(principal))
      throw failure("已有语音请求正在处理，请等待完成或取消。");
    signal.throwIfAborted();
    this.active.add(principal);
    try {
      return await work();
    } catch (e) {
      if (signal.aborted) throw failure("语音操作已取消。");
      if (e instanceof DomainError) throw e;
      if (e instanceof z.ZodError) throw failure("语音服务响应格式无效。");
      throw failure("语音连接失败，未自动重试。请检查网络、模型权限与额度。");
    } finally {
      this.active.delete(principal);
    }
  }
  synthesize(principal: string, text: string, signal: AbortSignal) {
    const request = ttsRequestSchema.parse({ text });
    return this.run(principal, signal, async () => {
      const response = await this.fetcher(
        // The supplied credential is an Agent Plan key, like the ASR route below.
        // The general speech endpoint uses a different credential scope.
        "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "X-Api-Key": this.key!,
            "X-Api-Resource-Id": "seed-tts-2.0",
            "X-Api-Request-Id": randomUUID(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            req_params: {
              text: request.text,
              speaker: "zh_female_vv_uranus_bigtts",
              audio_params: { format: "pcm", sample_rate: 16000 },
            },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(
          response.status === 401
            ? "语音服务鉴权未通过（HTTP 401）。请检查 API Key 是否有效且适用于语音服务。"
            : `语音合成请求未成功（HTTP ${response.status}）。请检查语音模型权限与额度。`,
        );
      }
      if (!response.body) throw failure("语音合成未返回音频。");
      let finished = false;
      let pending = "",
        total = 0,
        depth = 0,
        inString = false,
        escape = false,
        start = -1,
        scan = 0;
      const audio: Buffer[] = [];
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > audioLimit) throw failure("语音响应超过长度限制。");
        pending += decoder.decode(chunk, { stream: true });
        for (; scan < pending.length; scan++) {
          const c = pending[scan];
          if (start < 0) {
            if (/\s/.test(c!)) continue;
            if (c !== "{") throw failure("语音响应格式无效。");
            start = scan;
            depth = 1;
            continue;
          }
          if (inString) {
            if (escape) escape = false;
            else if (c === "\\") escape = true;
            else if (c === '"') inString = false;
            continue;
          }
          if (c === '"') inString = true;
          else if (c === "{") depth++;
          else if (c === "}") depth--;
          if (depth === 0) {
            const data = z
              .object({ code: z.number(), data: z.string().nullish() })
              .passthrough()
              .parse(JSON.parse(pending.slice(start, scan + 1)));
            if (![0, 20000000].includes(data.code))
              throw failure(
                `语音合成服务拒绝请求（${data.code}）。请检查语音模型权限与额度。`,
              );
            if (data.code === 20000000) finished = true;
            if (data.data) {
              if (
                !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data) ||
                data.data.length % 4
              )
                throw failure("语音音频编码无效。");
              audio.push(Buffer.from(data.data, "base64"));
            }
            pending = pending.slice(scan + 1);
            scan = -1;
            start = -1;
          }
        }
        if (finished) break;
      }
      if (!finished || pending.trim())
        throw failure("语音响应中断，未返回完整内容。");
      const pcm = Buffer.concat(audio);
      if (!pcm.length || pcm.length % 2)
        throw failure("语音合成未返回有效音频。");
      return Buffer.from(wavFromPCM(pcm));
    });
  }
  transcribe(principal: string, wav: Uint8Array, signal: AbortSignal) {
    try {
      readSpeechWav(wav);
    } catch (e) {
      throw failure(e instanceof Error ? e.message : "录音无效。");
    }
    return this.run(
      principal,
      signal,
      () =>
        new Promise<string>((resolve, reject) => {
          const connection = randomUUID();
          let done = false,
            sent = false,
            latest = "";
          let sendTimer: ReturnType<typeof setTimeout> | undefined;
          const ws = new WebSocket(
            "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async",
            {
              headers: {
                "X-Api-Key": this.key!,
                "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
                "X-Api-Request-Id": connection,
                "X-Api-Connect-Id": connection,
                "X-Api-Sequence": "-1",
              },
              followRedirects: false,
              handshakeTimeout: 10000,
              maxPayload: 1000000,
            },
          );
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(sendTimer);
            signal.removeEventListener("abort", abort);
            ws.terminate();
            error ? reject(error) : resolve(latest);
          };
          const abort = () => finish(failure("语音识别已取消。"));
          const timer = setTimeout(
            () => finish(failure("语音识别超时，未自动重试。")),
            90000,
          );
          ws.on("error", () => finish(failure("无法连接语音识别服务。")));
          ws.on("close", () => {
            if (!done) finish(failure("语音识别连接提前关闭，结果未确认。"));
          });
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          ws.on("open", () =>
            ws.send(
              asrFrame(
                Buffer.from(
                  JSON.stringify({
                    user: { uid: connection },
                    audio: {
                      format: "wav",
                      codec: "raw",
                      rate: 16000,
                      bits: 16,
                      channel: 1,
                    },
                    request: {
                      model_name: "bigmodel",
                      enable_itn: true,
                      enable_punc: true,
                      enable_ddc: true,
                      show_utterances: true,
                      enable_nonstream: false,
                    },
                  }),
                ),
                1,
                false,
              ),
            ),
          );
          ws.on("message", (data) => {
            try {
              const response = asrResponse(Buffer.from(data as Buffer));
              if (response.text) latest = response.text;
              if (response.last) {
                if (!latest.trim())
                  finish(failure("没有识别到语音，请重试或直接输入。"));
                else finish();
                return;
              }
              if (!sent) {
                sent = true;
                let sequence = 2,
                  offset = 0;
                const bytes = Buffer.from(wav);
                const send = () => {
                  if (done) return;
                  const last = offset + 6400 >= bytes.length;
                  ws.send(
                    asrFrame(
                      bytes.subarray(offset, offset + 6400),
                      sequence++,
                      true,
                      last,
                    ),
                  );
                  offset += 6400;
                  if (!last) sendTimer = setTimeout(send, 200);
                };
                send();
              }
            } catch (e) {
              finish(
                e instanceof DomainError ? e : failure("语音服务响应无效。"),
              );
            }
          });
          ws.on("unexpected-response", (_req, res) => {
            res.resume();
            finish(
              failure(
                `语音识别鉴权或连接失败（HTTP ${res.statusCode}）。请检查语音模型权限与额度。`,
              ),
            );
          });
        }),
    );
  }
}
