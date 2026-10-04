// Four complete original Client algorithms from Git 39cf13cf43b746f3eb1f47c223b6cc90f30d1297.
// Original client.ts SHA256: 74888eb42c5ca575eee39c8064b9e9f9821ba8f6225957101065bf6822d691eb.
// Independent fixed oracle: no production owner import or runtime Git dependency.
import type { z } from "zod";
import {
  readingMarkSchema,
  readingStateSchema,
  readerMarksReadSchema,
  type ReadingSection,
  type ReaderMarksRead,
  type ReadingMarksPage,
} from "../../packages/core/src/reader.js";
import type { applicationCall } from "../../apps/web/src/application-transport.js";

export type FixedReaderReadPorts = {
  current: {
    readonly current: { csrfToken: string; principalId: string } | null;
  };
  protectedReadGeneration: { readonly current: number };
  call: typeof applicationCall;
};

export function createFixedReaderReads(options: FixedReaderReadPorts) {
  const { current, protectedReadGeneration, call: applicationCall } = options;
  async function readReading(
    artifactId: string,
    revision: number,
    sectionId: string,
    signal?: AbortSignal,
  ): Promise<ReadingSection> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = protectedReadGeneration.current;
    const result = (await applicationCall(
      "reader.read",
      { artifactId, revision, sectionId },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as ReadingSection;
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    return result;
  }
  async function readingContents(
    artifactId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; title: string; characters: number }>> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    return (await applicationCall(
      "reader.contents",
      { artifactId, revision },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as Array<{ id: string; title: string; characters: number }>;
  }
  async function readingState(
    artifactId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<{
    position: z.infer<typeof readingStateSchema> | null;
  }> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const generation = protectedReadGeneration.current;
    const raw = (await applicationCall(
      "reader.state",
      { artifactId, revision },
      {
        identityGeneration: identity.csrfToken,
        signal,
      },
    )) as {
      position: null | {
        location: unknown;
        preferences: unknown;
        revision: number;
        updatedAt: string;
      };
    };
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    return {
      position: raw.position
        ? readingStateSchema.parse({
            location: raw.position.location,
            preferences: raw.position.preferences,
            revision: raw.position.revision,
            updatedAt: raw.position.updatedAt,
            artifactId,
            artifactRevision: revision,
            ownerPrincipalId: identity.principalId,
          })
        : null,
    };
  }
  async function readingMarks(
    request: ReaderMarksRead,
    signal?: AbortSignal,
  ): Promise<ReadingMarksPage> {
    const identity = current.current;
    if (!identity) throw new Error("应用尚未就绪，请稍后重试。");
    const query = readerMarksReadSchema.parse(request);
    const generation = protectedReadGeneration.current;
    const raw = (await applicationCall("reader.marks", query, {
      identityGeneration: identity.csrfToken,
      signal,
    })) as {
      marks: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    if (
      signal?.aborted ||
      current.current?.csrfToken !== identity.csrfToken ||
      protectedReadGeneration.current !== generation
    )
      throw new Error("阅读权限已变化，请重新读取。");
    if (
      raw.marks.length > 50 ||
      typeof raw.hasMore !== "boolean" ||
      !(raw.nextCursor === null || typeof raw.nextCursor === "string")
    )
      throw new Error("标注分页结果无效。");
    return {
      nextCursor: raw.nextCursor,
      hasMore: raw.hasMore,
      marks: raw.marks.map((mark) =>
        readingMarkSchema.parse({
          id: mark.id,
          location: mark.location,
          quote: mark.quote,
          kind: mark.kind,
          color: mark.color,
          note: mark.note,
          revision: mark.revision,
          createdAt: mark.createdAt,
          updatedAt: mark.updatedAt,
          deletedAt: mark.deletedAt,
          artifactId: query.artifactId,
          artifactRevision: query.revision,
          ownerPrincipalId: identity.principalId,
        }),
      ),
    };
  }
  return { readReading, readingContents, readingState, readingMarks };
}
