import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assembleReadingOcrModel,
  downloadReadingOcrModel,
  readingOcrModels,
  verifiedOcrBytes,
} from "../packages/application/src/reader-ocr-models.js";

const model = readingOcrModels[0];
const signal = () => new AbortController().signal;
const mockedFetch = (
  call: (url: string, init: RequestInit) => Response | Promise<Response>,
) => ((url, init) => Promise.resolve(call(String(url), init!))) as typeof fetch;

test("the official source changes neither installed archive identity nor the engine's model", () => {
  assert.deepEqual(
    readingOcrModels.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    [
      {
        name: "PP-OCRv6_small_det",
        size: 9_891_840,
        sha256:
          "d218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4",
      },
      {
        name: "PP-OCRv6_small_rec",
        size: 21_319_680,
        sha256:
          "d267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1",
      },
    ],
  );
  for (const entry of readingOcrModels) {
    assert.match(entry.revision, /^[a-f0-9]{40}$/);
    assert.deepEqual(
      entry.files.map((file) => file.name),
      ["inference.onnx", "inference.yml"],
    );
    for (const file of entry.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
});

test("integrity is exact length AND SHA-256; no normalized or truncated contents", () => {
  const bytes = Buffer.from("TEST exact bytes\n");
  const pinned = {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.ok(verifiedOcrBytes(bytes, pinned));
  assert.ok(!verifiedOcrBytes(bytes, { ...pinned, size: bytes.length + 1 }));
  assert.ok(!verifiedOcrBytes(Buffer.from("TEST Exact bytes\n"), pinned));
  assert.throws(() => assembleReadingOcrModel(model, []), /完整性校验失败/);
  assert.throws(
    () => assembleReadingOcrModel(model, [bytes, bytes]),
    /完整性校验失败/,
  );
});

test("public fixed-revision download omits credentials and reports HTTP status without retry/fallback", async () => {
  const calls: string[] = [];
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch((url, init) => {
        calls.push(url);
        assert.equal(
          url,
          `https://huggingface.co/PaddlePaddle/${model.name}_onnx/resolve/${model.revision}/inference.onnx`,
        );
        assert.equal(init.credentials, "omit");
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers, undefined);
        assert.ok(init.signal);
        return new Response("AccessDenied", { status: 403 });
      }),
    ),
    /HTTP 403/,
  );
  assert.equal(calls.length, 1);
});

for (const destination of [
  "http://huggingface.co/model",
  "https://huggingface.co.evil.invalid/model",
  "https://127.0.0.1/model",
  "https://huggingface.co:444/model",
  "https://secret@huggingface.co/model",
  "file:///tmp/model",
  "https://other.invalid/model",
])
  test(`redirect cannot broaden the public download boundary: ${destination}`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadReadingOcrModel(
        model,
        signal(),
        mockedFetch(() => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: destination },
          });
        }),
      ),
      /不在允许/,
    );
    assert.equal(calls, 1, "the redirected address is never contacted");
  });

test("official CDN redirects retain the exact byte check, with a finite hop count", async () => {
  const calls: string[] = [];
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch((url) => {
        calls.push(url);
        if (calls.length === 1)
          return new Response(null, {
            status: 302,
            headers: { location: "https://us.aws.cdn.hf.co/test-model" },
          });
        return new Response("wrong model");
      }),
    ),
    /完整性校验失败/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://us.aws.cdn.hf.co/test-model");
  let redirects = 0;
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch(() => {
        redirects++;
        return new Response(null, {
          status: 302,
          headers: { location: "/loop" },
        });
      }),
    ),
    /重定向次数超限/,
  );
  assert.equal(redirects, 5);
});

test("missing redirects and bodies are diagnostic failures, not successful model installation", async () => {
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch(() => new Response(null, { status: 302 })),
    ),
    /重定向缺少地址/,
  );
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch(() => new Response(null, { status: 204 })),
    ),
    /HTTP 204/,
  );
});

test("oversized streamed payload is cancelled before another file or archive can be accepted", async () => {
  let cancelled = false,
    calls = 0;
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      signal(),
      mockedFetch(() => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(model.files[0].size + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }),
    ),
    /模型大小与固定版本不符/,
  );
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test("cancellation before request and after receipt cannot publish a model", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("TEST cancelled before network"));
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      cancelled.signal,
      mockedFetch(() => {
        assert.fail("cancelled work must not contact a download host");
      }),
    ),
    /TEST cancelled before network/,
  );
  const during = new AbortController();
  let bodyCancelled = false;
  await assert.rejects(
    downloadReadingOcrModel(
      model,
      during.signal,
      mockedFetch(() => {
        during.abort(new Error("TEST cancelled during response"));
        return new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
        );
      }),
    ),
    /TEST cancelled during response/,
  );
  assert.ok(bodyCancelled);
});
