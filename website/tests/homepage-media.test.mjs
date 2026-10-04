import assert from "node:assert/strict";
import test from "node:test";
import { stat, readFile } from "node:fs/promises";
import media from "../lib/homepage-media.json" with { type: "json" };
import { serveHomepageVideo } from "../worker/homepage-media.mjs";

const src = media.videos.zh.src;
function fixture() {
  const gets = [];
  const metadata = {
    size: 10,
    httpEtag: '"fixed-etag"',
    uploaded: new Date("2026-10-04T00:00:00Z"),
    writeHttpMetadata(headers) { headers.set("Content-Type", "video/mp4"); },
  };
  const bucket = {
    async head(key) { assert.equal(key, media.videos.zh.key); return metadata; },
    async get(key, options) {
      gets.push({ key, options });
      const value = options?.range
        ? "abcdefghij".slice(options.range.offset, options.range.offset + options.range.length)
        : "abcdefghij";
      return { ...metadata, body: new Response(value).body };
    },
  };
  return { bucket, gets };
}
function request(method = "GET", headers = {}) {
  return new Request(`https://morphz.ai${src}`, { method, headers });
}

test("published media stays outside static assets and records immutable versions", async () => {
  for (const [locale, video] of Object.entries(media.videos)) {
    assert.match(video.src, new RegExp(`^/video/morphz-promo-${locale}-20261004-v1\\.mp4$`));
    assert.match(video.sha256, /^[0-9a-f]{64}$/);
    assert.ok(video.bytes > 0);
    await assert.rejects(stat(new URL(`../public${video.src}`, import.meta.url)), { code: "ENOENT" });
    assert.ok((await stat(new URL(`../public${video.poster}`, import.meta.url))).size > 0);
    const captions = await readFile(new URL(`../public${video.captions}`, import.meta.url), "utf8");
    assert.match(captions, /^WEBVTT/);
    assert.match(captions, /01:17\.333/);
  }
});

test("full requests stream the published object with type, caching, and range metadata", async () => {
  const { bucket, gets } = fixture();
  const response = await serveHomepageVideo(request(), bucket);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.equal(response.headers.get("Content-Length"), "10");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.match(response.headers.get("Cache-Control"), /immutable/);
  assert.equal(await response.text(), "abcdefghij");
  assert.equal(gets[0].key, media.videos.zh.key);
});

test("HEAD and matching ETags do not read the video body", async () => {
  const { bucket, gets } = fixture();
  const head = await serveHomepageVideo(request("HEAD"), bucket);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), "10");
  assert.equal(await head.text(), "");
  for (const etag of ['"fixed-etag"', 'W/"fixed-etag"', '"other", "fixed-etag"', "*"]) {
    const response = await serveHomepageVideo(request("GET", { "If-None-Match": etag }), bucket);
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("Content-Length"), null);
  }
  assert.equal(gets.length, 0);
});

test("byte, open-ended, and suffix ranges read only the requested portion", async () => {
  for (const [range, text, contentRange] of [
    ["bytes=2-4", "cde", "bytes 2-4/10"],
    ["bytes=7-", "hij", "bytes 7-9/10"],
    ["bytes=-3", "hij", "bytes 7-9/10"],
    ["bytes=8-100", "ij", "bytes 8-9/10"],
  ]) {
    const { bucket } = fixture();
    const response = await serveHomepageVideo(request("GET", { Range: range }), bucket);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(text.length));
    assert.equal(await response.text(), text);
  }
});

test("invalid and out-of-bounds ranges fail without fetching the body", async () => {
  const { bucket, gets } = fixture();
  for (const range of ["bytes=10-", "bytes=7-3", "bytes=-0", "bytes=-", "bytes=1-2,4-5", "bytes=999999999999999999999999-"]) {
    const response = await serveHomepageVideo(request("GET", { Range: range }), bucket);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), "bytes */10");
    assert.equal(response.headers.get("Content-Length"), "0");
  }
  assert.equal(gets.length, 0);
});

test("If-Range mismatches serve the full object instead of combining versions", async () => {
  const { bucket } = fixture();
  const response = await serveHomepageVideo(request("GET", { Range: "bytes=2-4", "If-Range": '"old-version"' }), bucket);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "abcdefghij");
});

test("private keys, absent objects, absent bindings, and unsupported methods are not exposed", async () => {
  assert.equal(await serveHomepageVideo(new Request("https://morphz.ai/video/private.mp4"), undefined), null);
  assert.equal((await serveHomepageVideo(request(), undefined)).status, 503);
  assert.equal((await serveHomepageVideo(request(), { head: async () => null })).status, 404);
  assert.equal((await serveHomepageVideo(request("POST"), undefined)).status, 405);
});

test("the built Worker routes homepage video requests to the bound bucket", async () => {
  const { default: worker } = await import("../dist/server/index.js");
  const { bucket } = fixture();
  const response = await worker.fetch(request("GET", { Range: "bytes=2-4" }), { MORPHZ_MEDIA: bucket }, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "cde");
});
