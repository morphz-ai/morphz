import type { applicationCall } from "../../apps/web/src/application-transport.js";
import type { Boot } from "../../apps/web/src/client.js";
import type {
  PlatformClient,
  PlatformContent,
} from "../../apps/web/src/platform-client.js";
import {
  collectEditorPage,
  parseEditorHead,
  parseEditorVersion,
  parseEditorCandidate,
  type ScriptEditorProduction,
  type ScriptPanel,
} from "../../apps/web/src/script-editor-reader.js";
import {
  scriptReviewDetailSchema,
  scriptExportDetailSchema,
  scriptVersionTitleSchema,
  type ScriptEditorPageRequest,
} from "../../packages/core/src/script-editor.js";
import { scriptProductionSchema } from "../../packages/core/src/script-studio.js";
import type { ScriptLocation } from "../../packages/core/src/script-delivery.js";
import {
  scriptDocxLimits,
  type ScriptDocxManifest,
} from "../../packages/core/src/script-studio-docx.js";

type FixedScriptModel = { identity: string; value: ScriptEditorProduction };
export type FixedScriptEditorBindings = {
  scriptEditorModels: { current: Map<string, FixedScriptModel> };
  scriptVersionTitles: { current: Map<string, string> };
  current: { current: Pick<Boot, "csrfToken" | "scriptLibrary"> | null };
  scriptReadSession: () => {
    identity: { csrfToken: string };
    source: PlatformClient;
    check: () => void;
  };
  applicationCall: typeof applicationCall;
  rememberContent: (entry: PlatformContent, generation: string) => void;
};

/** Fixed original algorithms from Git 4ce98b64 client.ts.
 * Only the surrounding React refs/transport are supplied by this isolated adapter.
 * This fixture intentionally does not call the new owner.
 */
export function createFixedScriptEditorReads(
  bindings: FixedScriptEditorBindings,
) {
  const {
    scriptEditorModels,
    scriptVersionTitles,
    current,
    scriptReadSession,
    applicationCall,
    rememberContent,
  } = bindings;
  async function readScriptEditorPage<
    K extends ScriptEditorPageRequest["panel"],
  >(
    production: ScriptEditorProduction,
    panel: K,
    itemId?: string,
  ): Promise<ScriptPanel<K>> {
    const { identity, check } = scriptReadSession();
    const result = await collectEditorPage(
      async (request) => {
        const value = await applicationCall("scripts.editor.page", request, {
          identityGeneration: identity.csrfToken,
        });
        check();
        return value;
      },
      production,
      panel,
      itemId,
    );
    check();
    return result;
  }
  async function readScriptEditor(
    productionId: string,
  ): Promise<ScriptEditorProduction> {
    const { identity, source, check } = scriptReadSession();
    const catalog = await source.resolveContent({
      appId: "morphz.script-studio",
      appObjectId: productionId,
    });
    check();
    const head = parseEditorHead(
      catalog,
      await applicationCall(
        "scripts.editor.head",
        { contentId: catalog.id },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    const cached = scriptEditorModels.current.get(productionId);
    if (
      cached?.identity === identity.csrfToken &&
      cached.value.activityRevision === head.activityRevision &&
      cached.value.catalogRevision === head.catalogRevision &&
      cached.value.providerRevision === head.providerRevision
    ) {
      rememberContent(catalog, identity.csrfToken);
      return cached.value;
    }
    const directory = await collectEditorPage(
      async (request) => {
        const value = await applicationCall("scripts.editor.page", request, {
          identityGeneration: identity.csrfToken,
        });
        check();
        return value;
      },
      head,
      "directory",
    );
    const confirmed = await source.getContent(catalog.id);
    check();
    if (
      confirmed.revision !== catalog.revision ||
      confirmed.providerRevision !== catalog.providerRevision ||
      confirmed.observedVersionRef !== catalog.observedVersionRef
    )
      throw new Error("剧本目录已变化，请重试打开。");
    const model: ScriptEditorProduction = { ...head, items: directory.items };
    scriptEditorModels.current.set(productionId, {
      identity: identity.csrfToken,
      value: model,
    });
    if (scriptEditorModels.current.size > 64)
      scriptEditorModels.current.delete(
        scriptEditorModels.current.keys().next().value!,
      );
    rememberContent(confirmed, identity.csrfToken);
    return model;
  }
  function getScriptEditor(productionId: string) {
    const cached = scriptEditorModels.current.get(productionId);
    const entry = current.current?.scriptLibrary.find(
      (value) => value.id === productionId,
    );
    if (
      !cached ||
      !entry ||
      cached.identity !== current.current?.csrfToken ||
      entry.catalogRevision !== cached.value.catalogRevision ||
      entry.activityRevision !== cached.value.activityRevision
    )
      return undefined;
    return cached.value;
  }
  async function readScriptVersion(
    production: ScriptEditorProduction,
    itemId: string,
    revision?: number,
  ) {
    const { identity, source, check } = scriptReadSession();
    const version = await parseEditorVersion(
      source,
      await source.readScriptItem(production.contentId, itemId, revision),
    );
    check();
    if (
      version.productionId !== production.id ||
      version.itemId !== itemId ||
      (revision !== undefined && version.revision !== revision)
    )
      throw new Error("剧本条目版本不一致，请重试。");
    scriptVersionTitles.current.set(
      `${identity.csrfToken}:${production.id}:${itemId}:${version.revision}`,
      version.draft.title,
    );
    if (scriptVersionTitles.current.size > 512)
      scriptVersionTitles.current.delete(
        scriptVersionTitles.current.keys().next().value!,
      );
    return version;
  }
  async function readScriptCandidate(
    production: ScriptEditorProduction,
    candidateId: string,
  ) {
    const { identity, source, check } = scriptReadSession();
    const value = await applicationCall(
      "scripts.editor.detail",
      {
        contentId: production.contentId,
        kind: "candidate",
        objectId: candidateId,
      },
      { identityGeneration: identity.csrfToken },
    );
    const candidate = await parseEditorCandidate(source, value);
    check();
    if (candidate.id !== candidateId)
      throw new Error("候选稿身份不一致，请重试。");
    return candidate;
  }
  async function readScriptVersionTitle(
    production: ScriptEditorProduction,
    itemId: string,
    revision: number,
  ) {
    const { identity, check } = scriptReadSession();
    const key = `${identity.csrfToken}:${production.id}:${itemId}:${revision}`;
    const cached = scriptVersionTitles.current.get(key);
    if (cached !== undefined) return cached;
    const value = scriptVersionTitleSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "item-version-title",
          objectId: itemId,
          revision,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (
      value.productionId !== production.id ||
      value.itemId !== itemId ||
      value.revision !== revision
    )
      throw new Error("剧本条目版本不一致，请重试。");
    scriptVersionTitles.current.set(key, value.title);
    if (scriptVersionTitles.current.size > 512)
      scriptVersionTitles.current.delete(
        scriptVersionTitles.current.keys().next().value!,
      );
    return value.title;
  }
  async function readScriptReview(
    production: ScriptEditorProduction,
    reviewId: string,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptReviewDetailSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "review",
          objectId: reviewId,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.id !== reviewId) throw new Error("审阅意见身份不一致，请重试。");
    return value;
  }
  async function readScriptExport(
    production: ScriptEditorProduction,
    exportId: string,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptExportDetailSchema.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "export",
          objectId: exportId,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.id !== exportId) throw new Error("导出记录身份不一致，请重试。");
    return value;
  }
  async function readScriptContext(
    production: ScriptEditorProduction,
    revision: number,
  ) {
    const { identity, check } = scriptReadSession();
    const value = scriptProductionSchema.shape.metadataHistory.element.parse(
      await applicationCall(
        "scripts.editor.detail",
        {
          contentId: production.contentId,
          kind: "context",
          revision,
        },
        { identityGeneration: identity.csrfToken },
      ),
    );
    check();
    if (value.revision !== revision)
      throw new Error("剧本规范版本不一致，请重试。");
    return value;
  }
  async function readScriptExportManifest(
    production: ScriptEditorProduction,
    exportId: string,
  ): Promise<ScriptDocxManifest> {
    const { check } = scriptReadSession();
    const record = await readScriptExport(production, exportId);
    const metadata = await readScriptContext(
      production,
      record.contextRevision,
    );
    const versions: ScriptDocxManifest["versions"] = [];
    const loaded = new Set<string>();
    let sourceCharacters = 2;
    const read = async (itemId: string, revision: number) => {
      const key = `${itemId}:${revision}`;
      if (loaded.has(key)) return;
      const value = await readScriptVersion(production, itemId, revision);
      check();
      const version = {
        id: itemId,
        kind: value.kind,
        revision: value.revision,
        draft: value.draft,
      };
      sourceCharacters +=
        JSON.stringify(version).length + (versions.length ? 1 : 0);
      if (sourceCharacters > scriptDocxLimits.sourceCharacters)
        throw new Error("原文过大，请拆分为较少集数导出。");
      versions.push(version);
      loaded.add(key);
    };
    if (record.items.length > scriptDocxLimits.items)
      throw new Error("导出条目数量过多。");
    for (const ref of record.items) await read(ref.itemId, ref.revision);
    const selected = [...versions];
    for (const version of selected)
      for (const ref of version.draft.dependencies)
        await read(ref.itemId, ref.revision);
    check();
    return { productionId: production.id, record, metadata, versions };
  }
  async function resolveScriptLocation(target: ScriptLocation) {
    const { check } = scriptReadSession();
    const production = await readScriptEditor(target.productionId);
    const item = production.items.find((value) => value.id === target.itemId);
    if (target.itemId && !item) return null;
    if (target.revision && item)
      await readScriptVersion(production, item.id, target.revision);
    if (target.candidateId) {
      const candidate = await readScriptCandidate(
        production,
        target.candidateId,
      );
      if (
        candidate.targetId !== item?.id ||
        candidate.baseRevision !== target.revision
      )
        return null;
    }
    if (target.reviewId) {
      const review = await readScriptReview(production, target.reviewId);
      if (review.itemId !== item?.id || review.itemRevision !== target.revision)
        return null;
    }
    check();
    return { production, item };
  }
  return {
    readScriptEditorPage,
    readScriptEditor,
    getScriptEditor,
    readScriptVersion,
    readScriptCandidate,
    readScriptVersionTitle,
    readScriptReview,
    readScriptExport,
    readScriptContext,
    readScriptExportManifest,
    resolveScriptLocation,
    scriptVersionTitle: (
      productionId: string,
      itemId: string,
      revision: number,
    ) =>
      scriptVersionTitles.current.get(
        `${current.current?.csrfToken}:${productionId}:${itemId}:${revision}`,
      ),
    clear() {
      scriptEditorModels.current.clear();
      scriptVersionTitles.current.clear();
    },
  };
}
