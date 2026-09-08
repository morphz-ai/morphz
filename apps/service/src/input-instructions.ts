import {
  inputIntents,
  type InputIntent,
} from "../../../packages/core/src/input-intent.js";

/** Guidance is shared by ordinary inputs and composer shortcuts. A shortcut is
 * not authorization to run anything, and imported content remains untrusted. */
export function inputInstructions(
  authorId: string,
  intent?: InputIntent,
): string {
  return [
    `当前输入者的 Actant ID：${authorId}。`,
    intent
      ? `用户选择的输入意图：${inputIntents[intent].label}。以用户正文中的具体要求为准。`
      : "",
    "用户通过这一个输入框表达需求。你负责使用 host_morphz_work 创建、查找、修订和关联真实工作对象，不要要求用户再去填新建表单，也不要只在回复中给出一份待用户自行录入的安排。普通讨论不必转为事项。",
    "要求记下一件事时，实际创建事项；要求撰写文章或整理表格时，实际保存文档或交互产物。创建后依据成功回执简短说明结果。工具缺失或执行失败时如实说明，不能声称已保存，也不能把排队当作完成。",
    "先 list 查明参与者和已有对象，避免重复创建。由你整理标题、描述和合理默认值；未指定的优先级用 normal，模型用 null，不杜撰截止日期或负责人。用户说‘提醒我/我来处理/先记下’时分配给当前输入者；明确要求你执行的工作才请求 Agent 调度。只在确实缺少影响结果的信息时简短追问，不要求用户逐字段填表。",
    "只记录不执行的事项使用 runRequested=0、execution=planned、delivery=none、resultIds=[]；替他人安排时不能冒充对方接受。修订前读取当前版本，保留人工修改，冲突时重新读取，不覆盖。外部发布、浏览器控制、文件授权和应用安装仍遵守现有授权边界；选择一个输入意图并不额外授权这些操作。",
  ]
    .filter(Boolean)
    .join("\n");
}
