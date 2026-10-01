import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import {
  ObjectsStore,
  type ObjectsAuthority,
} from "../packages/objects/src/store.js";

export function isolatedCenterDirectory() {
  const { directory } = JSON.parse(
    readFileSync("node_modules/.cache/morphz-e2e-center.json", "utf8"),
  ) as { directory: string };
  if (!isAbsolute(directory) || !basename(directory).startsWith("morphz-e2e-"))
    throw new Error("夹具必须使用隔离的 E2E 中心。");
  return directory;
}

/** Write an Agent original through the app domain and its Platform receipt in
 * an isolated E2E center. This does not simulate Runtime model execution. */
export async function seedAgentOriginal(
  directory: string,
  projectId: string,
  title: string,
  markdown: string,
  inputId = `input_${randomUUID().replaceAll("-", "")}`,
) {
  if (directory !== isolatedCenterDirectory())
    throw new Error("Agent 原件夹具不能写入非本次隔离中心。");
  const transport = new WorkspaceStore(join(directory, "workspace.sqlite"), {
    mode: "transport",
  });
  try {
    const domains = await openApplicationDomainsHost(directory, transport);
    try {
      const tenantId = transport.identity();
      const actor = {
        tenantId,
        principalId: localAccess.principalId,
        actantId: "morphz-agent",
        kind: "agent" as const,
        runtimeInputId: inputId,
      };
      const authority: ObjectsAuthority = {
        authorizeCreate: async () => ({ ...actor, projectId }),
        authorizeDocumentRevision: async () => {
          throw new Error("搜索夹具不允许修订原件。");
        },
        authorizeObjectRead: async () => {
          throw new Error("搜索夹具不允许读取原件。");
        },
        authorizeByteRead: async () => {
          throw new Error("搜索夹具不允许读取文件字节。");
        },
      };
      const objects = await ObjectsStore.sqlite(
        join(directory, "objects.sqlite"),
        authority,
      );
      try {
        const objectId = `agent_${randomUUID().replaceAll("-", "")}`;
        const original = await objects.createDocument({
          credential: "isolated-e2e-agent",
          commandId: randomUUID(),
          objectId,
          requestedProjectId: projectId,
          title,
          markdown,
        });
        await domains.content.platform.recordCommittedContent(
          {
            tenantId,
            principalId: actor.principalId,
            actantId: actor.actantId,
            runtimeInputId: inputId,
            instanceId: domains.content.instanceIds.objects,
            receiptId: original.receiptId,
          },
          {
            objectId,
            projectId,
            kind: "document",
            title,
            observedVersionRef: original.versionRef,
          },
        );
        await objects.markDirectoryProjected(tenantId, original.eventId);
        return objectId;
      } finally {
        await objects.close();
      }
    } finally {
      await domains.close();
    }
  } finally {
    transport.close();
  }
}
