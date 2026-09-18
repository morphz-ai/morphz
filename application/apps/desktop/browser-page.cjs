// This fixed program runs in an isolated Chromium world, with no Node or preload.
// Model arguments are JSON data, never executable JavaScript or CSS selectors.
function pageAction(action, snapshotId) {
  function visible(el) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      el.isConnected &&
      r.width > 0 &&
      r.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }
  function allowed(el) {
    return (
      visible(el) &&
      !el.disabled &&
      !el.closest('[inert],[aria-hidden="true"]') &&
      !(
        el instanceof HTMLInputElement &&
        ["password", "hidden", "file"].includes(el.type)
      )
    );
  }
  function label(el) {
    return (
      el.getAttribute("aria-label") ||
      (el.labels && [...el.labels].map((l) => l.innerText).join(" ")) ||
      el.innerText ||
      el.getAttribute("placeholder") ||
      el.name ||
      ""
    )
      .trim()
      .slice(0, 400);
  }
  if (action.type === "snapshot") {
    const nodes = [
      ...document.querySelectorAll(
        'input,textarea,select,button,a[href],[contenteditable="true"],[role="button"]',
      ),
    ]
      .filter(allowed)
      .slice(0, 150);
    const refs = nodes.map((el, i) => ({
      ref: "e" + i,
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      label: label(el),
      href: el instanceof HTMLAnchorElement ? el.href : undefined,
    }));
    globalThis.__morphzBrowserSnapshot = {
      id: snapshotId,
      url: location.href,
      nodes,
      labels: nodes.map(label),
    };
    return {
      snapshotId,
      url: location.href,
      title: document.title,
      text: document.body?.innerText.slice(0, 22000) || "",
      elements: refs,
      untrusted: true,
    };
  }
  const snapshot = globalThis.__morphzBrowserSnapshot;
  if (
    !snapshot ||
    snapshot.id !== action.snapshotId ||
    snapshot.url !== location.href
  )
    throw new Error("页面快照已过期，请重新读取。");
  const i = Number(action.ref.slice(1)),
    el = snapshot.nodes[i];
  if (!el || !allowed(el) || label(el) !== snapshot.labels[i])
    throw new Error("目标已变化，请重新读取页面。");
  if (action.type === "inspect")
    return {
      label: label(el),
      tag: el.tagName.toLowerCase(),
      url: location.href,
    };
  if (action.type === "fill") {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (
        el.readOnly ||
        (el instanceof HTMLInputElement &&
          !["text", "search", "url", "email", "tel", "number"].includes(
            el.type,
          ))
      )
        throw new Error("这个字段不能由 Agent 填写。");
      const prototype =
        el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        el,
        action.value,
      );
    } else if (el instanceof HTMLSelectElement) {
      if (![...el.options].some((o) => o.value === action.value))
        throw new Error("选项不存在。");
      el.value = action.value;
    } else if (el.isContentEditable) el.textContent = action.value;
    else throw new Error("这个对象不是输入框。");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    delete globalThis.__morphzBrowserSnapshot;
    return {
      filled: true,
      label: label(el),
      note: "填写完成；字段可能触发网站自动保存。继续操作前需要重新读取。",
    };
  }
  if (action.type === "click") {
    // Consume the snapshot BEFORE dispatch. A later timeout must never retry.
    delete globalThis.__morphzBrowserSnapshot;
    el.click();
    return {
      dispatched: true,
      label: label(el),
      note: "点击已发出，不代表提交成功；请重新读取页面确认结果。",
    };
  }
  throw new Error("不支持这个浏览器动作。");
}
module.exports = { pageAction };
