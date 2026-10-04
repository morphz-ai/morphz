import media from "../lib/homepage-media.json" with { type: "json" };

/** @typedef {{ size: number, httpEtag: string, uploaded: Date, body?: ReadableStream<Uint8Array>, writeHttpMetadata: (headers: Headers) => void }} MediaObject */
/** @typedef {{ head: (key: string) => Promise<MediaObject | null>, get: (key: string, options?: { range: { offset: number, length: number } }) => Promise<MediaObject | null> }} MediaBucket */

/** @param {string} value @param {number} size */
function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  if (!match[1]) {
    if (last === 0) return null;
    const offset = Math.max(0, size - last);
    return { offset, length: size - offset };
  }
  const end = match[2] ? Math.min(last, size - 1) : size - 1;
  if (first >= size || end < first) return null;
  return { offset: first, length: end - first + 1 };
}

/** Serve only the two published homepage assets, never arbitrary bucket keys.
 * @param {Request} request
 * @param {MediaBucket | undefined} bucket
 * @returns {Promise<Response | null>}
 */
export async function serveHomepageVideo(request, bucket) {
  const path = new URL(request.url).pathname;
  const asset = Object.values(media.videos).find((video) => video.src === path);
  if (!asset) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!bucket) return new Response("Media unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  const metadata = await bucket.head(asset.key);
  if (!metadata) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const headers = new Headers();
  metadata.writeHttpMetadata(headers);
  headers.set("Content-Type", "video/mp4");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", metadata.httpEtag);
  headers.set("Last-Modified", metadata.uploaded.toUTCString());
  headers.set("X-Content-Type-Options", "nosniff");
  const etags = request.headers.get("If-None-Match")?.split(",").map((etag) => etag.trim().replace(/^W\//, ""));
  if (etags?.includes("*") || etags?.includes(metadata.httpEtag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(metadata.size));
  if (request.method === "HEAD") return new Response(null, { headers });
  const ifRange = request.headers.get("If-Range");
  const matchesRange = !ifRange || ifRange === metadata.httpEtag ||
    (Number.isFinite(Date.parse(ifRange)) && Date.parse(ifRange) >= Math.floor(metadata.uploaded.getTime() / 1000) * 1000);
  const rangeHeader = matchesRange ? request.headers.get("Range") : null;
  const range = rangeHeader ? byteRange(rangeHeader, metadata.size) : null;
  if (rangeHeader && !range) {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  const object = await bucket.get(asset.key, range ? { range } : undefined);
  if (!object?.body) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    headers.set("Content-Length", String(range.length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
