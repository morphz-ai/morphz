import { z } from "zod";

// A composer shortcut is a user-visible hint, not a separate creation workflow.
// Ordinary inputs need no intent; the Agent decides which tools fit the request.
export const inputIntentSchema = z.enum([
  "task",
  "document",
  "website",
  "interactive",
]);
export type InputIntent = z.infer<typeof inputIntentSchema>;
export const inputIntents: Record<
  InputIntent,
  { label: string; placeholder: string }
> = {
  task: {
    label: "安排事项",
    placeholder: "告诉 Morphz 要做什么，或需要怎样调整安排…",
  },
  document: {
    label: "创作文档",
    placeholder: "描述你想写的内容、用途，或直接给出素材…",
  },
  website: {
    label: "添加网站",
    placeholder: "粘贴网址，也可以说明接下来想在网站上做什么…",
  },
  interactive: {
    label: "制作表格或报告",
    placeholder: "描述要整理的数据，或想得到的表格、报告…",
  },
};
