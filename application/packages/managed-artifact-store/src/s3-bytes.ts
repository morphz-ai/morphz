import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const digestPattern = /^[a-f0-9]{64}$/;
const prefixPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}$/;

export type S3ByteLocation = {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
};

export type S3StoreBinding = {
  format: 2;
  backend: "s3";
  storeId: string;
  schema: string;
  database: string;
  bindingId: string;
  bucket: string;
  prefix: string;
};

export type ListedCloudObject = {
  key: string;
  relative: string;
  byteLength: number;
  modifiedAt: number;
  etag: string;
};

function status(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode ?? null;
}

async function collect(
  body: AsyncIterable<Uint8Array> | undefined,
  maximum: number,
) {
  if (!body) throw new Error("云对象字节缺失。");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const piece of body) {
    length += piece.byteLength;
    if (length > maximum) throw new Error("云对象字节超出预期长度。");
    chunks.push(Buffer.from(piece));
  }
  return Buffer.concat(chunks, length);
}

/** An S3-compatible immutable byte plane. The PostgreSQL manifest remains the
 * only authority for versions; these objects are never a Platform catalog.
 */
export class S3BlobBytes {
  readonly location: S3ByteLocation;
  readonly locatorSha256: string;
  private readonly client: S3Client;
  private readonly ownsClient: boolean;

  constructor(location: S3ByteLocation, client?: S3Client) {
    if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(location.bucket))
      throw new Error("云 Store bucket 无效。");
    if (
      !prefixPattern.test(location.prefix) ||
      location.prefix.startsWith("/") ||
      location.prefix.endsWith("/") ||
      location.prefix
        .split("/")
        .some((part) => part === "." || part === ".." || !part)
    )
      throw new Error("云 Store prefix 无效。");
    if (!location.region) throw new Error("云 Store region 缺失。");
    if (location.endpoint) {
      const endpoint = new URL(location.endpoint);
      if (
        endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
        )
      )
        throw new Error(
          "云 Store 自定义端点必须使用 HTTPS，或为本机测试地址。",
        );
    }
    this.location = { ...location };
    this.locatorSha256 = createHash("sha256")
      .update(
        JSON.stringify({
          bucket: location.bucket,
          prefix: location.prefix,
        }),
      )
      .digest("hex");
    this.client =
      client ??
      new S3Client({
        region: location.region,
        ...(location.endpoint ? { endpoint: location.endpoint } : {}),
        forcePathStyle: location.forcePathStyle ?? false,
        maxAttempts: 3,
      });
    this.ownsClient = !client;
  }

  close() {
    if (this.ownsClient) this.client.destroy();
  }

  private key(name: string) {
    return `${this.location.prefix}/${name}`;
  }

  private blobKey(sha256: string) {
    if (!digestPattern.test(sha256)) throw new Error("Blob 摘要无效。");
    return this.key(`blobs/${sha256.slice(0, 2)}/${sha256}`);
  }

  async *listObjects(section: "blobs" | "quarantine") {
    const prefix = this.key(`${section}/`);
    let continuation: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.location.bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (
          !object.Key ||
          !object.Key.startsWith(prefix) ||
          object.Size === undefined ||
          !Number.isSafeInteger(object.Size) ||
          !object.LastModified ||
          !object.ETag
        )
          throw new Error("云 Store 对象列表包含不完整的对象元数据。");
        yield {
          key: object.Key,
          relative: object.Key.slice(prefix.length),
          byteLength: object.Size,
          modifiedAt: object.LastModified.getTime(),
          etag: object.ETag,
        } satisfies ListedCloudObject;
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw new Error("云 Store 对象列表缺少下一页游标。");
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
  }

  private async binding() {
    const key = this.key("store-binding.json");
    let head;
    try {
      head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.location.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      if (status(error) === 404) return null;
      throw error;
    }
    if (head.ContentLength === undefined || head.ContentLength > 4096)
      throw new Error("云 Store 身份标记无效。");
    const object = await this.client.send(
      new GetObjectCommand({
        Bucket: this.location.bucket,
        Key: key,
      }),
    );
    const bytes = await collect(
      object.Body as AsyncIterable<Uint8Array> | undefined,
      4096,
    );
    if (bytes.byteLength !== head.ContentLength)
      throw new Error("云 Store 身份标记读取不完整。");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("云 Store 身份标记损坏。");
    }
    return { value: parsed, etag: object.ETag ?? head.ETag };
  }

  private matchesBinding(actual: unknown, expected: object) {
    return (
      !!actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, value]) => (actual as Record<string, unknown>)[key] === value,
      )
    );
  }

  /** Only initialization uses v1: it validates the same exact manifest identity
   * and must publish v2 before a Store can expose byte operations. */
  private v1Binding(expected: S3StoreBinding) {
    return { ...expected, format: 1, nodeId: null };
  }

  async validateBinding(expected: S3StoreBinding, allowCreate: boolean) {
    const current = await this.binding();
    if (!current && !allowCreate)
      throw new Error("Store manifest 已有业务数据，但云字节身份标记缺失。");
    if (
      current &&
      !this.matchesBinding(current.value, expected) &&
      !this.matchesBinding(current.value, this.v1Binding(expected))
    )
      throw new Error("云 Store 与 manifest 身份不匹配。");
  }

  async bind(expected: S3StoreBinding, allowCreate: boolean) {
    const current = await this.binding();
    if (current && this.matchesBinding(current.value, expected)) return;
    if (
      current &&
      !this.matchesBinding(current.value, this.v1Binding(expected))
    )
      throw new Error("云 Store 与 manifest 身份不匹配。");
    if (!current && !allowCreate)
      throw new Error("Store manifest 已有业务数据，但云字节身份标记缺失。");
    if (current && !current.etag)
      throw new Error("云 Store v1 升级缺少条件发布身份，拒绝覆盖。");
    const bytes = Buffer.from(JSON.stringify(expected), "utf8");
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.location.bucket,
          Key: this.key("store-binding.json"),
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: "application/json",
          ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
          ...(current ? { IfMatch: current.etag } : { IfNoneMatch: "*" }),
        }),
      );
    } catch (error) {
      if (status(error) !== 412) throw error;
    }
    if (!this.matchesBinding((await this.binding())?.value, expected))
      throw new Error("云 Store 身份标记被并发绑定到其他 manifest。");
  }

  private async verifyKey(key: string, sha256: string, byteLength: number) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.location.bucket,
        Key: key,
      }),
    );
    if (response.ContentLength !== byteLength || !response.Body)
      throw new Error("Artifact 云字节缺失或长度损坏。");
    const hash = createHash("sha256");
    let read = 0;
    for await (const part of response.Body as AsyncIterable<Uint8Array>) {
      read += part.byteLength;
      if (read > byteLength)
        throw new Error("Artifact 云字节超出 manifest 长度。");
      hash.update(part);
    }
    if (read !== byteLength || hash.digest("hex") !== sha256)
      throw new Error("Artifact 云字节摘要损坏。");
  }

  async verify(sha256: string, byteLength: number) {
    await this.verifyKey(this.blobKey(sha256), sha256, byteLength);
  }

  async quarantineOrphan(
    sha256: string,
    byteLength: number,
    etag: string,
    name: string,
  ) {
    if (!/^\d{13,16}-[a-f0-9]{64}-[0-9a-f-]{36}$/.test(name))
      throw new Error("云 Store 隔离对象名称无效。");
    const source = this.blobKey(sha256);
    const destination = this.key(`quarantine/${name}`);
    await this.verifyKey(source, sha256, byteLength);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.location.bucket,
        Key: destination,
        CopySource: `${encodeURIComponent(this.location.bucket)}/${source
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        CopySourceIfMatch: etag,
        IfNoneMatch: "*",
      }),
    );
    await this.verifyKey(destination, sha256, byteLength);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.location.bucket,
        Key: source,
        IfMatch: etag,
      }),
    );
  }

  async purgeQuarantine(name: string, etag: string) {
    if (!/^\d{13,16}-[a-f0-9]{64}-[0-9a-f-]{36}$/.test(name))
      throw new Error("云 Store 隔离对象名称无效。");
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.location.bucket,
        Key: this.key(`quarantine/${name}`),
        IfMatch: etag,
      }),
    );
  }

  async assertLength(sha256: string, byteLength: number) {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.location.bucket,
        Key: this.blobKey(sha256),
      }),
    );
    if (response.ContentLength !== byteLength)
      throw new Error("Artifact 云字节缺失或长度损坏。");
  }

  async publish(
    stage: string,
    sha256: string,
    byteLength: number,
    mayAlreadyExist = false,
  ) {
    const key = this.blobKey(sha256);
    if (mayAlreadyExist) {
      try {
        await this.verify(sha256, byteLength);
        return;
      } catch (error) {
        // A committed receipt may outlive its bytes. Only an actually missing
        // object can be repaired; altered bytes must remain an integrity error.
        if (status(error) !== 404) throw error;
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.location.bucket,
            Key: key,
            Body: createReadStream(stage),
            ContentLength: byteLength,
            ContentType: "application/octet-stream",
            ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
            IfNoneMatch: "*",
          }),
        );
        break;
      } catch (error) {
        if (status(error) === 412) break;
        if (status(error) === 409 && attempt < 2) continue;
        throw error;
      }
    }
    // A conditional collision is acceptable only when the existing bytes
    // really have the same digest. Never trust ETag as a content digest.
    await this.verify(sha256, byteLength);
  }

  async readChunk(
    sha256: string,
    start: number,
    length: number,
    totalLength: number,
  ) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 1 ||
      length > 1024 * 1024 ||
      start + length > totalLength
    )
      throw new Error("云 Store 分块范围无效。");
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.location.bucket,
        Key: this.blobKey(sha256),
        Range: `bytes=${start}-${start + length - 1}`,
      }),
    );
    if (
      result.ContentRange !==
        `bytes ${start}-${start + length - 1}/${totalLength}` ||
      result.ContentLength !== length
    )
      throw new Error("云 Store 返回的分块范围与 manifest 不一致。");
    const bytes = await collect(
      result.Body as AsyncIterable<Uint8Array> | undefined,
      length,
    );
    if (bytes.byteLength !== length) throw new Error("云 Store 分块被截断。");
    return bytes;
  }

  /** Used by a consistent manifest snapshot; does not publish an unchecked
   * backup file. The caller verifies chunk records before marking it complete.
   */
  async downloadVerified(sha256: string, byteLength: number, target: string) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.location.bucket,
        Key: this.blobKey(sha256),
      }),
    );
    if (response.ContentLength !== byteLength || !response.Body)
      throw new Error("Artifact 云字节缺失或长度损坏。");
    const file = await open(target, "wx", 0o600);
    const hash = createHash("sha256");
    let read = 0;
    try {
      for await (const part of response.Body as AsyncIterable<Uint8Array>) {
        read += part.byteLength;
        if (read > byteLength)
          throw new Error("Artifact 云字节超出 manifest 长度。");
        hash.update(part);
        await file.writeFile(part);
      }
      if (read !== byteLength || hash.digest("hex") !== sha256)
        throw new Error("Artifact 云字节摘要损坏。");
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
