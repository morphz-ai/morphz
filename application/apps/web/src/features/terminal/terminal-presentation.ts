import type {
  TerminalRecord,
  TerminalView,
} from "../../../../../packages/core/src/terminal.js";

const states: Record<TerminalRecord["status"], string> = {
  starting: "正在连接",
  open: "会话已连接",
  exited: "进程已退出",
  closed: "会话已结束",
  lost: "终端连接已丢失",
};

/** Low-frequency metadata belongs to the actual session, not a persistent
 * status row. Initial cwd is never represented as the shell's current cwd. */
export function terminalSessionDescription(
  record: TerminalRecord,
  online: boolean,
) {
  return [
    record.title,
    online ? states[record.status] : "连接状态待核对",
    `起始目录：${record.cwd}`,
    `Shell：${record.shell}`,
    `执行节点：${record.target_id}`,
    `${record.sandbox_status === "enforced" ? "工作区沙盒" : record.sandbox_status === "disabled" ? "完全访问（无工作区沙盒限制）" : "沙盒状态待核对"} · 网络${record.network_enabled ? "允许" : "受限"}`,
    `${record.cols}×${record.rows}`,
    ...(record.exit_code !== null ? [`退出码：${record.exit_code}`] : []),
  ].join("\n");
}

/** One truthful connection/read-only notice. Never repeat the same failure
 * as offline, checkpoint, connection and footer messages simultaneously. */
export function terminalConnectionNotice(
  online: boolean,
  error: string,
  terminal: TerminalRecord | undefined,
  view: TerminalView | null,
) {
  if (!online) return "应用连接中断，终端暂时只读；未确认的命令不会重发。";
  if (error) return `${error} 现有会话不会被重新执行。`;
  if (!terminal) return null;
  if (["lost", "exited", "closed"].includes(terminal.status))
    return `${states[terminal.status]}${terminal.exit_code !== null ? `（退出码 ${terminal.exit_code}）` : ""}。${view?.screen ? "显示最后屏幕；" : ""}旧命令不会自动重发。`;
  if (!view) return null;
  if (view.checkpoint || !view.connected)
    return "终端未连接，当前只读；旧命令不会自动重发。";
  if (!view.input_supported)
    return "当前终端只读：Runtime 尚未提供键盘输入能力。";
  return null;
}
