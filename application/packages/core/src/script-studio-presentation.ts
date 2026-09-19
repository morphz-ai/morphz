import type { Actant } from "./model.js";
import type {
  ScriptDraft,
  ScriptItem,
  ScriptProduction,
} from "./script-studio.js";

/** Display only: identifiers and immutable audit records remain unchanged. */
export function scriptAuthorName(
  author: { actantId: string; principalId: string },
  actants: Pick<Actant, "id" | "principalId" | "name">[],
) {
  return (
    actants.find(
      (a) => a.id === author.actantId && a.principalId === author.principalId,
    )?.name || "未命名参与者"
  );
}

export const scriptEventLabels: Record<
  ScriptItem["events"][number]["action"],
  string
> = {
  submit: "提交审阅",
  approve: "批准",
  "request-changes": "退回修改",
  lock: "锁稿",
  unlock: "解锁",
  revise: "修订",
  invalidate: "需重新审阅",
};

export const scriptFieldLabels: Record<keyof ScriptDraft, string> = {
  title: "标题",
  text: "正文",
  order: "目录次序",
  basis: "依据",
  parentId: "所属分集",
  dependencies: "版本依赖",
  sources: "原作引用",
  location: "地点",
  storyTime: "故事时间",
  characters: "出场角色",
  audienceKnowledge: "观众已知",
  characterKnowledge: "人物认知",
  setupPayoff: "伏笔与兑现",
  productionNotes: "制作说明",
};

export function scriptFieldValue(
  production: ScriptProduction,
  draft: ScriptDraft,
  key: keyof ScriptDraft,
) {
  const title = (id: string) => {
    const ref = draft.dependencies.find((r) => r.itemId === id);
    const item = production.items.find((i) => i.id === id);
    return (
      item?.versions.find(
        (v) => v.revision === (ref?.revision ?? item.revision),
      )?.draft.title || "已不可用的文稿"
    );
  };
  if (key === "basis")
    return { original: "原创", source: "原作事实", adaptation: "改编设定" }[
      draft.basis
    ];
  if (key === "parentId")
    return draft.parentId ? title(draft.parentId) : "未指定";
  if (key === "characters")
    return draft.characters.map(title).join("、") || "无";
  if (key === "dependencies")
    return (
      draft.dependencies
        .map((r) => `${title(r.itemId)} · v${r.revision}`)
        .join("\n") || "无"
    );
  if (key === "sources")
    return (
      draft.sources
        .map(
          (r, i) =>
            `原作引用 ${i + 1} · v${r.revision}\n${r.quote || "整份版本引用"}`,
        )
        .join("\n") || "无"
    );
  return String(draft[key] ?? "");
}

export function scriptEventNote(
  production: ScriptProduction,
  event: ScriptItem["events"][number],
) {
  // Only translate machine-authored invalidation text, never rewrite a human's note.
  if (event.action !== "invalidate") return event.note;
  const match = /^上游 (.+) 更新至 v(\d+)$/.exec(event.note);
  if (!match) return event.note;
  const title = production.items
    .find((i) => i.id === match[1])
    ?.versions.find((v) => v.revision === Number(match[2]))?.draft.title;
  return `上游「${title || "已不可用的文稿"}」更新至 v${match[2]}`;
}

export function scriptExportContents(
  production: ScriptProduction,
  record: ScriptProduction["exports"][number],
) {
  return record.items.map((ref) => {
    const title = production.items
      .find((i) => i.id === ref.itemId)
      ?.versions.find((v) => v.revision === ref.revision)?.draft.title;
    return `${title || "历史文稿不可用"} · v${ref.revision}`;
  });
}

export function scriptDisplayTime(time: string) {
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}
