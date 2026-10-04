import { z } from "zod";
import {
  stateSchema,
  type Operation,
  type Receipt,
  type Workspace,
} from "../../packages/core/src/model.js";
import type { Boot } from "../../apps/web/src/client.js";
import type { PlatformClient } from "../../apps/web/src/platform-client.js";

// Independently captured actual committed Git. No candidate-derived baseline or CI Git.
export const fixedObjectInteractions = {
  baseline: "57e7d4ce97416bf39fc2a1eb2f00951bca6def8d",
  sourcePath: "application/apps/web/src/client.ts",
  sourceSha256:
    "0c1caa4aca34a01a9f0e024e12b776c301a51cee8fe8a5b814e1b41ff756dff1",
  spans: {
    listObjectAnnotations: {
      raw: 'async function listObjectAnnotations(\n    contentId: string,\n    signal?: AbortSignal,\n  ) {\n    const identity = current.current;\n    const source = platform.current;\n    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)\n      throw new Error("身份已变化，批注未读取。");\n    const annotations: Workspace["annotations"] = [];\n    let afterOrdinal: number | undefined;\n    for (let page = 0; page < 100; page++) {\n      const rows = z\n        .array(\n          z.object({\n            ordinal: z.number().int().nonnegative(),\n            annotation: stateSchema.shape.annotations.element,\n          }),\n        )\n        .parse(\n          await source.listObjectAnnotations(\n            contentId,\n            {\n              limit: 100,\n              ...(afterOrdinal === undefined ? {} : { afterOrdinal }),\n            },\n            signal,\n          ),\n        );\n      annotations.push(...rows.map((row) => row.annotation));\n      if (rows.length < 100) return annotations;\n      const last = rows.at(-1)!.ordinal;\n      if (afterOrdinal !== undefined && last <= afterOrdinal)\n        throw new Error("批注分页游标未推进。");\n      afterOrdinal = last;\n    }\n    throw new Error("批注数量超过当前可读取范围。");\n  }',
      sha256:
        "3f5c2f3c730e74d7399e04df637781574109769cea6b5aa7514a1b5fab1dc65b",
      bytes: 1279,
      start: 51536,
      end: 52743,
      line: 1499,
    },
    workRelationsFor: {
      raw: 'async function workRelationsFor(objectId: string, signal?: AbortSignal) {\n    const identity = current.current;\n    const source = platform.current;\n    if (!identity || !source || source.boot.csrfToken !== identity.csrfToken)\n      throw new Error("身份已变化，关联未读取。");\n    return source.allWorkRelations(objectId, signal);\n  }',
      sha256:
        "5b442d47ae5d76f8ed1992e8db2fd35c37579fe63ff1c6f817f15f4cc8e172f6",
      bytes: 347,
      start: 52746,
      end: 53069,
      line: 1536,
    },
    annotateBranch: {
      raw: 'if (op.type === "annotate") {\n    const entry = await source.getContent(op.artifactId);\n    if (entry.appId !== "morphz.objects" || entry.availability !== "available")\n      throw new UnsentOperationError("所选内容不是可批注的原件，未保存批注。");\n    await source.annotateObject({\n      commandId,\n      contentId: entry.id,\n      revision: op.artifactRevision,\n      quote: op.quote,\n      ...(op.page === undefined ? {} : { page: op.page }),\n      body: op.body,\n    });\n    return done(commandId);\n  }',
      sha256:
        "291ae9c0c554870d803ab3fdf62f58f4e1c5c4a34fadb202376145950d32a379",
      bytes: 524,
      start: 8518,
      end: 9004,
      line: 246,
    },
    linkArtifactsBranch: {
      raw: 'if (op.type === "link-artifacts") {\n    const relationId = await source.linkWork({\n      commandId,\n      fromId: op.fromId,\n      toId: op.toId,\n      kind: op.relation,\n    });\n    return done(relationId);\n  }',
      sha256:
        "cab6f65cd1ccaa0fe79ba9430467d9d5be0bec4d0e863686321923e4b7788390",
      bytes: 211,
      start: 9007,
      end: 9218,
      line: 260,
    },
    done: {
      raw: "done = (entityId: string): Receipt => ({\n    commandId,\n    entityId,\n    workspaceRevision: identity.workspace.revision + 1,\n  })",
      sha256:
        "e8f9c144757fb0d58b6250e4afa729bdf20a0c8b7e3a83ff3f4b904145cae66c",
      bytes: 130,
      start: 5789,
      end: 5919,
      line: 169,
    },
    UnsentOperationError: {
      raw: "class UnsentOperationError extends Error {}",
      sha256:
        "1a5c141470ceb0ef72df401810bcb30c23881c7c0109205b64a62d429d8a9316",
      bytes: 43,
      start: 4834,
      end: 4877,
      line: 136,
    },
  },
} as const;

export function createFixedObjectInteractions({
  current,
  platform,
}: {
  current: { readonly current: { csrfToken: string } | null };
  platform: {
    readonly current: Pick<
      PlatformClient,
      "boot" | "listObjectAnnotations" | "allWorkRelations"
    > | null;
  };
}) {
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

class UnsentOperationError extends Error {}
export async function fixedExecuteObjectOperation(
  source: Pick<PlatformClient, "getContent" | "annotateObject" | "linkWork">,
  identity: Pick<Boot, "workspace">,
  command: {
    commandId: string;
    operation: Extract<Operation, { type: "annotate" | "link-artifacts" }>;
  },
): Promise<Receipt> {
  const { commandId, operation: op } = command;
  const done = (entityId: string): Receipt => ({
    commandId,
    entityId,
    workspaceRevision: identity.workspace.revision + 1,
  });
  if (op.type === "annotate") {
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
  if (op.type === "link-artifacts") {
    const relationId = await source.linkWork({
      commandId,
      fromId: op.fromId,
      toId: op.toId,
      kind: op.relation,
    });
    return done(relationId);
  }
  throw new Error(
    "fixed adapter requires one of the original two object operations",
  );
}
