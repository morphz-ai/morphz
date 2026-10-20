import { z } from "zod";
import type { PlatformClient } from "../platform-client.js";
import type { ContentReadProjection } from "./content-reads.js";

const versionMetadataSchema = z.object({
  revision: z.number().int().positive(),
  title: z.string(),
  author: z.object({ principalId: z.string(), actantId: z.string() }),
  createdAt: z.string(),
});
const versionPageSchema = z.object({
  objectId: z.string(),
  contentId: z.string(),
  projectId: z.string(),
  versions: z.array(versionMetadataSchema).max(50),
  nextCursor: z.number().int().positive().nullable(),
});
export type ArtifactVersionMetadata = z.infer<typeof versionMetadataSchema>;
export type ArtifactVersionPage = z.infer<typeof versionPageSchema>;

/** History is a bounded, authorized metadata directory, not fabricated bodies.
 * Exact version payloads remain owned by resolveArtifact's existing cold read.
 */
export async function readArtifactVersionPage(
  ports: {
    platform: { readonly current: PlatformClient | null };
    current: { readonly current: ContentReadProjection | null };
    protectedReadGeneration: { readonly current: number };
  },
  contentId: string,
  beforeRevision?: number,
  signal?: AbortSignal,
): Promise<ArtifactVersionPage> {
  const source = ports.platform.current;
  const identity = ports.current.current?.csrfToken;
  const generation = ports.protectedReadGeneration.current;
  if (!source || !identity || source.boot.csrfToken !== identity)
    throw new Error("身份已变化，版本目录未读取。");
  if (
    beforeRevision !== undefined &&
    (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
  )
    throw new Error("版本目录游标无效。");
  const checkRead = () => {
    if (
      signal?.aborted ||
      ports.current.current?.csrfToken !== identity ||
      ports.protectedReadGeneration.current !== generation
    )
      throw new Error("身份或访问范围已变化，版本目录未读取。");
  };
  try {
    const entry = await source.getContent(contentId, signal);
    checkRead();
    if (entry.appId !== "morphz.objects" || entry.availability !== "available")
      throw new Error("内容原件当前不可用，版本目录未读取。");
    const page = versionPageSchema.parse(
      await source.objectVersions(
        contentId,
        { limit: 50, beforeRevision },
        signal,
      ),
    );
    checkRead();
    let previous = beforeRevision ?? Infinity;
    if (
      page.contentId !== contentId ||
      page.objectId !== entry.appObjectId ||
      page.projectId !== entry.projectId ||
      page.versions.some((version) => {
        const invalid = version.revision >= previous;
        previous = version.revision;
        return invalid;
      }) ||
      (page.nextCursor !== null &&
        page.nextCursor !== page.versions.at(-1)?.revision)
    )
      throw new Error("版本目录已变化，请重新打开。");
    return page;
  } catch (error) {
    checkRead();
    throw error;
  }
}
