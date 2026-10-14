const reasons: Record<string, string> = {
  user_input: "你回复",
  permission: "你批准",
  timer: "定时触发",
  thread: "关联执行结束",
  thread_group: "子任务结果",
  tool_task: "工具结果",
  delegation: "委派结果",
  external_event: "外部事件",
  resource: "资源可用",
};
/** Unknown is not a request for user input. Never interpret Agent prose. */
export function executionWaitLabel(kinds?: readonly string[]) {
  if (!kinds?.length) return "等待条件（原因待核对）";
  return (
    "等待" +
    [...new Set(kinds.map((kind) => reasons[kind] ?? "其他条件"))].join("、")
  );
}
