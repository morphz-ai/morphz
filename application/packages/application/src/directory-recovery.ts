import type { ObjectsStore } from "../../objects/src/store.js";
import type { PlatformStore } from "../../platform/src/store.js";
import type { ReaderStore } from "../../reader/src/store.js";
import type { ScriptStudioStore } from "../../script-studio/src/store.js";
import { projectPendingDocumentDirectory } from "./document-service.js";
import { projectPendingReaderDirectory } from "./reader-service.js";
import {
  projectPendingScriptCandidateDecisions,
  projectPendingScriptDirectory,
  projectPendingScriptExports,
  projectPendingScriptItems,
  projectPendingScriptSettings,
  projectPendingScriptWorkflow,
  projectPendingScriptReviews,
} from "./script-production-service.js";

type Cursor = { createdAt: string; eventId: string };
type Page = {
  examined: number;
  projected: number;
  unresolved: string[];
  nextCursor: Cursor | null;
};

/** Recover only committed App outbox events. The owning App remains the
 * original; Platform verifies its exact receipt before updating the catalog.
 * No Human credential, model invocation or App write is replayed here.
 */
export async function recoverEmbeddedDirectory(request: {
  tenantId: string;
  platform: PlatformStore;
  objects: ObjectsStore;
  objectsInstanceId: string;
  studio: ScriptStudioStore;
  studioInstanceId: string;
  reader: ReaderStore;
  readerInstanceId: string;
}) {
  const feeds: ((after?: Cursor) => Promise<Page>)[] = [
    (after) =>
      projectPendingDocumentDirectory({
        platform: request.platform,
        objects: request.objects,
        tenantId: request.tenantId,
        instanceId: request.objectsInstanceId,
        after,
      }),
    (after) => projectPendingReaderDirectory({
      platform: request.platform,
      reader: request.reader,
      tenantId: request.tenantId,
      instanceId: request.readerInstanceId,
      after,
    }),
    (after) =>
      projectPendingScriptDirectory({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptItems({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptSettings({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptExports({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptWorkflow({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptReviews({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
    (after) =>
      projectPendingScriptCandidateDecisions({
        platform: request.platform,
        studio: request.studio,
        tenantId: request.tenantId,
        instanceId: request.studioInstanceId,
        after,
      }),
  ];
  let recovered = 0;
  // App events from separate domains may have equal or non-monotonic wall
  // clocks. Retry unresolved revisions after other committed predecessors have
  // projected; stop if a complete pass cannot make progress.
  for (;;) {
    let examined = 0;
    let projected = 0;
    for (const feed of feeds) {
      let cursor: Cursor | undefined;
      for (;;) {
        const page = await feed(cursor);
        examined += page.examined;
        projected += page.projected;
        if (page.examined < 100) break;
        if (!page.nextCursor)
          throw new Error("应用目录恢复游标缺失，原件未改动。");
        cursor = page.nextCursor;
      }
    }
    recovered += projected;
    if (!examined) return { recovered };
    if (!projected)
      throw new Error(
        "应用原件已保存，但内容目录仍有无法核验的提交；拒绝隐藏原件后继续启动。",
      );
  }
}
