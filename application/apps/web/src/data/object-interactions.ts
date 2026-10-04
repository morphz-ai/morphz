import { z } from "zod";
import {
  stateSchema,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../../../packages/core/src/model.js";
import type { PlatformClient } from "../platform-client.js";

export type ObjectInteractionPorts = {
  current: { readonly current: { csrfToken: string } | null };
  platform: {
    readonly current: Pick<
      PlatformClient,
      "boot" | "listObjectAnnotations" | "allWorkRelations"
    > | null;
  };
};

/** Borrow Client's original refs without reading them during construction.
 * Each read retains its own captured-source, schema and pagination contract.
 */
export function createObjectInteractions(options: ObjectInteractionPorts) {
  const { current, platform } = options;
  async function listObjectAnnotations(
    contentId: string,
    signal?: AbortSignal,
  ) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，批注未读取。");
    const annotations: Workspace["annotations"] = [];
    let afterOrdinal: number | undefined;
    for (let page = 0; page < 100; page++) {
      const rows = z
        .array(
          z.object({
            ordinal: z.number().int().nonnegative(),
            annotation: stateSchema.shape.annotations.element,
          }),
        )
        .parse(
          await source.listObjectAnnotations(
            contentId,
            {
              limit: 100,
              ...(afterOrdinal === undefined ? {} : { afterOrdinal }),
            },
            signal,
          ),
        );
      annotations.push(...rows.map((row) => row.annotation));
      if (rows.length < 100) return annotations;
      const last = rows.at(-1)!.ordinal;
      if (afterOrdinal !== undefined && last <= afterOrdinal)
        throw new Error("批注分页游标未推进。");
      afterOrdinal = last;
    }
    throw new Error("批注数量超过当前可读取范围。");
  }
  async function workRelationsFor(objectId: string, signal?: AbortSignal) {
    const identity = current.current;
    const source = platform.current;
    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)
      throw new Error("身份已变化，关联未读取。");
    return source.allWorkRelations(objectId, signal);
  }
  return { listObjectAnnotations, workRelationsFor };
}

/** Called only from the existing typed dispatch slot. Client retains the
 * captured receipt closure and the exact unsent-error constructor.
 */
export async function annotateObjectOperation(
  source: Pick<PlatformClient, "getContent" | "annotateObject">,
  op: Extract<Operation, { type: "annotate" }>,
  commandId: string,
  done: (entityId: string) => Receipt,
  UnsentOperationError: new (message: string) => Error,
): Promise<Receipt> {
  const entry = await source.getContent(op.artifactId);
  if (entry.appId !== "morphz.objects" || entry.availability !== "available")
    throw new UnsentOperationError("所选内容不是可批注的原件，未保存批注。");
  await source.annotateObject({
    commandId,
    contentId: entry.id,
    revision: op.artifactRevision,
    quote: op.quote,
    ...(op.page === undefined ? {} : { page: op.page }),
    body: op.body,
  });
  return done(commandId);
}

export async function linkWorkOperation(
  source: Pick<PlatformClient, "linkWork">,
  op: Extract<Operation, { type: "link-artifacts" }>,
  commandId: string,
  done: (entityId: string) => Receipt,
): Promise<Receipt> {
  const relationId = await source.linkWork({
    commandId,
    fromId: op.fromId,
    toId: op.toId,
    kind: op.relation,
  });
  return done(relationId);
}
