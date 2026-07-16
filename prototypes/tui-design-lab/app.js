const preview = document.querySelector("#terminal-preview");
const workStatusStrip = document.querySelector("#work-status-strip");
const chatStatusStrip = document.querySelector("#chat-status-strip");
const mindStatusChip = document.querySelector("#mind-status-chip");
const mindView = document.querySelector("#mind-view");
const mindViewClose = document.querySelector("#mind-view-close");
const workbench = document.querySelector("#workbench");
const workbenchClose = document.querySelector("#workbench-close");
const workStatusActionLabel = document.querySelector("#work-status-action-label");
const workstripToggle = document.querySelector("#workstrip-toggle");
const shortcutsToggle = document.querySelector("#shortcuts-toggle");
const resetButton = document.querySelector("#reset-design");
const input = document.querySelector("#message-input");
const decisionTitle = document.querySelector("#decision-title");
const decisionCopy = document.querySelector("#decision-copy");
const completedToggle = document.querySelector("#completed-toggle");
const completedList = document.querySelector("#completed-list");
const runningCount = document.querySelector("#running-count");
const waitingCount = document.querySelector("#waiting-count");
const statusRunningCount = document.querySelector("#status-running-count");
const statusWaitingCount = document.querySelector("#status-waiting-count");
const keyToast = document.querySelector("#key-toast");
const contextChip = document.querySelector("#context-chip");
const sessionSelector = document.querySelector("#session-selector");
const sessionPopover = document.querySelector("#session-popover");
const currentSessionName = document.querySelector("#current-session-name");
const currentSessionPolicy = document.querySelector("#current-session-policy");
const currentContextName = document.querySelector("#current-context-name");
const currentContextPolicy = document.querySelector("#current-context-policy");
const conversationSessionLabel = document.querySelector("#conversation-session-label");
const chatStatusSession = document.querySelector("#chat-status-session");
let keyToastTimer;

const defaults = {
  theme: "dark",
  accent: "iris",
  density: "balanced",
  tools: "summary",
  viewport: "standard",
  activeView: "conversation",
  workstrip: true,
  shortcuts: true,
  scope: "session",
};

const state = { ...defaults };
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

const labels = {
  accent: { iris: "鸢尾紫", cyan: "电光青", coral: "暖珊瑚", mono: "纯单色" },
  density: { airy: "舒展", balanced: "平衡", compact: "紧凑" },
  tools: { minimal: "只显示调用状态", summary: "显示结果摘要", expanded: "默认展开参数与结果" },
  activeView: { conversation: "对话视图", tasks: "任务视图", mind: "认知视图" },
};

function resolvedTheme() {
  if (state.theme === "system") return systemTheme.matches ? "dark" : "light";
  return state.theme;
}

function updateDecision() {
  decisionTitle.textContent = `透明 · ${labels.accent[state.accent]} · ${labels.density[state.density]}`;
  decisionCopy.textContent = `对话与执行分离；当前为${labels.activeView[state.activeView]}，工具${labels.tools[state.tools]}。`;
}

function showKeyToast(message) {
  window.clearTimeout(keyToastTimer);
  keyToast.textContent = message;
  keyToast.classList.add("is-visible");
  keyToastTimer = window.setTimeout(() => keyToast.classList.remove("is-visible"), 1300);
}

function setActiveView(view, message) {
  state.activeView = view;
  render();
  if (message) showKeyToast(message);
}

function setScope(scope, message) {
  state.scope = scope;
  document.querySelectorAll("[data-scope]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scope));
  });
  document.querySelectorAll("[data-context-task]").forEach((task) => {
    task.hidden = scope !== "context";
  });
  const contextWide = scope === "context";
  runningCount.textContent = contextWide ? "2" : "1";
  waitingCount.textContent = "1";
  statusRunningCount.textContent = contextWide ? "2" : "1";
  statusWaitingCount.textContent = "1";
  if (message) showKeyToast(message);
}

function render() {
  preview.dataset.theme = state.theme;
  preview.dataset.resolvedTheme = resolvedTheme();
  preview.dataset.accent = state.accent;
  preview.dataset.density = state.density;
  preview.dataset.tools = state.tools;
  preview.dataset.viewport = state.viewport;
  preview.dataset.activeView = state.activeView;
  preview.classList.remove("hide-workbench");
  const taskViewActive = state.activeView === "tasks";
  preview.classList.toggle("hide-workstrip", !state.workstrip);
  preview.classList.toggle("hide-shortcuts", !state.shortcuts);
  workStatusStrip.setAttribute("aria-expanded", String(taskViewActive));
  workbench.setAttribute("aria-hidden", String(!taskViewActive));
  mindView.setAttribute("aria-hidden", String(state.activeView !== "mind"));
  mindStatusChip.setAttribute("aria-pressed", String(state.activeView === "mind"));
  workStatusActionLabel.textContent = "任务视图";

  document.querySelectorAll("[data-control]").forEach((group) => {
    const key = group.dataset.control;
    group.querySelectorAll("[data-value]").forEach((button) => {
      const selected = button.dataset.value === state[key];
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-selected", selected);
    });
  });

  workstripToggle.checked = state.workstrip;
  shortcutsToggle.checked = state.shortcuts;
  updateDecision();
}

document.querySelectorAll("[data-control]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[data-value]");
    if (!button) return;
    state[group.dataset.control] = button.dataset.value;
    render();
    if (group.dataset.control === "activeView") {
      showKeyToast(`已切换到${labels.activeView[state.activeView]}`);
    }
  });
});

document.querySelectorAll(".tool-row").forEach((row) => {
  row.addEventListener("click", () => {
    row.setAttribute("aria-expanded", String(row.getAttribute("aria-expanded") !== "true"));
  });
});

workStatusStrip.addEventListener("click", () => {
  setActiveView("tasks", "已切换到任务视图");
});

workbenchClose.addEventListener("click", () => {
  setActiveView("conversation", "已返回对话视图");
});

mindStatusChip.addEventListener("click", () => {
  const nextView = state.activeView === "mind" ? "conversation" : "mind";
  setActiveView(nextView, `已切换到${labels.activeView[nextView]}`);
});

contextChip.addEventListener("click", () => {
  setActiveView("mind", `已打开 ${currentContextName.textContent} 的认知视图`);
});

mindViewClose.addEventListener("click", () => {
  setActiveView("conversation", "已返回对话视图");
});

chatStatusStrip.addEventListener("click", () => {
  setActiveView("conversation", "已返回对话视图");
});

function setSessionPopover(open) {
  sessionPopover.hidden = !open;
  sessionSelector.setAttribute("aria-expanded", String(open));
}

sessionSelector.addEventListener("click", () => {
  setSessionPopover(sessionPopover.hidden);
});

document.querySelectorAll(".session-option").forEach((option) => {
  option.addEventListener("click", () => {
    const name = option.dataset.sessionName;
    currentSessionName.textContent = name;
    currentSessionPolicy.textContent = option.dataset.sessionPolicy;
    currentContextName.textContent = option.dataset.contextName;
    currentContextPolicy.textContent = option.dataset.contextPolicy;
    conversationSessionLabel.textContent = `SESSION · ${name}`;
    chatStatusSession.textContent = `session/${name}`;
    document.querySelectorAll(".session-option").forEach((candidate) => {
      candidate.classList.toggle("is-current", candidate === option);
    });
    setSessionPopover(false);
    showKeyToast(`已切换到可见 Session：${name}`);
  });
});

document.addEventListener("click", (event) => {
  if (!sessionPopover.hidden && !event.target.closest(".session-selector-wrap")) {
    setSessionPopover(false);
  }
});

workstripToggle.addEventListener("change", () => {
  state.workstrip = workstripToggle.checked;
  render();
});

shortcutsToggle.addEventListener("change", () => {
  state.shortcuts = shortcutsToggle.checked;
  render();
});

resetButton.addEventListener("click", () => {
  Object.assign(state, defaults);
  currentSessionName.textContent = "main";
  currentSessionPolicy.textContent = "private record";
  currentContextName.textContent = "context-default";
  currentContextPolicy.textContent = "shared · r184";
  conversationSessionLabel.textContent = "SESSION · main";
  chatStatusSession.textContent = "session/main";
  document.querySelectorAll(".session-option").forEach((option) => {
    option.classList.toggle("is-current", option.dataset.sessionName === "main");
  });
  setSessionPopover(false);
  completedList.classList.remove("is-open");
  completedToggle.setAttribute("aria-expanded", "false");
  document.querySelectorAll(".tool-row").forEach((row, index) => {
    row.setAttribute("aria-expanded", String(index === 2));
  });
  document.querySelectorAll("[data-context-task]").forEach((task) => {
    task.hidden = true;
  });
  document.querySelectorAll("[data-scope]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.scope === "session"));
  });
  runningCount.textContent = "1";
  waitingCount.textContent = "1";
  statusRunningCount.textContent = "1";
  statusWaitingCount.textContent = "1";
  render();
});

document.querySelectorAll("[data-scope]").forEach((button) => {
  button.addEventListener("click", () => {
    setScope(button.dataset.scope);
  });
});

completedToggle.addEventListener("click", () => {
  const open = !completedList.classList.contains("is-open");
  completedList.classList.toggle("is-open", open);
  completedToggle.setAttribute("aria-expanded", String(open));
});

systemTheme.addEventListener("change", () => {
  if (state.theme === "system") render();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 100)}px`;
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    input.value = "";
    input.style.height = "auto";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !sessionPopover.hidden) {
    event.preventDefault();
    setSessionPopover(false);
    return;
  }

  if (event.ctrlKey && event.key.toLowerCase() === "w") {
    event.preventDefault();
    const nextView = state.activeView === "conversation" ? "tasks" : "conversation";
    setActiveView(nextView, `Ctrl+W · ${labels.activeView[nextView]}`);
    return;
  }

  if (event.ctrlKey && event.key.toLowerCase() === "m") {
    event.preventDefault();
    const nextView = state.activeView === "mind" ? "conversation" : "mind";
    setActiveView(nextView, `Ctrl+M · ${labels.activeView[nextView]}`);
    return;
  }

  if (event.key === "Escape" && state.activeView !== "conversation") {
    event.preventDefault();
    setActiveView("conversation", "Esc · 已返回对话视图");
    return;
  }

  if (event.ctrlKey && event.key === "1") {
    event.preventDefault();
    setScope("session", "Ctrl+1 · 当前 Session");
    return;
  }

  if (event.ctrlKey && event.key === "2") {
    event.preventDefault();
    setScope("context", "Ctrl+2 · 整个 Context");
  }
});

render();
