import type { ScriptDocxManifest } from "../packages/core/src/script-studio-docx.js";
import type { ScriptProduction } from "../packages/core/src/script-studio.js";
export { scriptDocxLimits } from "../packages/core/src/script-studio-docx.js";

/** Pure offline-model projection for rendering fixtures. This is not a store,
 * an authorization adapter or evidence that a domain operation persisted. */
export function scriptDocxManifest(
  production: ScriptProduction,
  exportId: string,
): ScriptDocxManifest {
  const records = production.exports.filter((value) => value.id === exportId);
  if (records.length !== 1)
    throw new Error("无法导出 Word：导出记录不存在或不唯一。");
  const record = records[0]!;
  const contexts = production.metadataHistory.filter(
    (value) => value.revision === record.contextRevision,
  );
  if (contexts.length !== 1)
    throw new Error("无法导出 Word：项目历史版本缺失或不唯一。");
  const ids = new Set<string>();
  for (const item of production.items) {
    if (ids.has(item.id))
      throw new Error(`无法导出 Word：条目 ID 重复：${item.id}`);
    ids.add(item.id);
  }
  const keys = new Set(
    record.items.map((ref) => `${ref.itemId}:${ref.revision}`),
  );
  for (const item of production.items)
    for (const version of item.versions) {
      if (!keys.has(`${item.id}:${version.revision}`)) continue;
      for (const ref of version.draft.dependencies)
        keys.add(`${ref.itemId}:${ref.revision}`);
    }
  return {
    productionId: production.id,
    record,
    metadata: contexts[0]!,
    versions: production.items.flatMap((item) =>
      item.versions
        .filter((version) => keys.has(`${item.id}:${version.revision}`))
        .map((version) => ({
          id: item.id,
          kind: item.kind,
          revision: version.revision,
          draft: version.draft,
        })),
    ),
  };
}
