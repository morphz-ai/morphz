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
// Read only the user's current selection. Running in an isolated world gives the
// page no IPC or Node access. Nothing is sent to a model until the Human submits.
function pageSelection(reveal) {
  const normalized = (text) => text.replace(/\s+/g, " ").trim();
  function selectMatchingRange(range) {
    if (!range) return false;
    const selection = getSelection();
    const previous = Array.from({ length: selection.rangeCount }, (_, i) =>
      selection.getRangeAt(i).cloneRange(),
    );
    selection.removeAllRanges();
    selection.addRange(range);
    // Use the same rendered-text semantics as capture: DOM textContent both
    // includes hidden nodes and omits line breaks between block elements.
    if (normalized(selection.toString()) === normalized(reveal.text))
      return true;
    selection.removeAllRanges();
    previous.forEach((saved) => selection.addRange(saved));
    return false;
  }
  function rangeAt(start, end) {
    if (start < 0 || end <= start) return null;
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      ),
      range = document.createRange();
    let count = 0,
      began = false,
      node;
    while ((node = walker.nextNode())) {
      const length = node.textContent.length;
      if (!began && start < count + length) {
        range.setStart(node, start - count);
        began = true;
      }
      if (began && end <= count + length) {
        range.setEnd(node, end - count);
        return range;
      }
      count += length;
    }
    return null;
  }
  if (reveal) {
    const all = document.body?.textContent || "";
    let range =
      reveal.anchor && rangeAt(reveal.anchor.start, reveal.anchor.end);
    if (!selectMatchingRange(range)) {
      const start = all.indexOf(reveal.text);
      if (start < 0 || all.indexOf(reveal.text, start + 1) >= 0)
        return { found: false };
      range = rangeAt(start, start + reveal.text.length);
      if (!selectMatchingRange(range)) return { found: false };
    }
    const node = range.startContainer;
    (node.nodeType === Node.ELEMENT_NODE
      ? node
      : node.parentElement
    )?.scrollIntoView({ block: "center" });
    return { found: true };
  }
  if (
    document.activeElement?.matches('input,textarea,[contenteditable="true"]')
  )
    return null;
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0),
    // Selection reflects rendered text. Range.toString() also includes hidden
    // style/script nodes when a native paragraph selection crosses them.
    text = selection.toString().trim();
  if (
    !text ||
    text.length > 30000 ||
    !document.body?.contains(range.commonAncestorContainer)
  )
    return null;
  const before = range.cloneRange();
  before.selectNodeContents(document.body);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  before.setEnd(range.endContainer, range.endOffset);
  const end = before.toString().length;
  const rect = Array.from(range.getClientRects())
    .filter((r) => r.height && r.bottom > 0 && r.top < innerHeight)
    .at(-1);
  if (!rect) return null;
  return {
    text,
    title: document.title.slice(0, 500) || location.host,
    url: location.href,
    anchor: {
      start,
      end,
      prefix: "",
      suffix: "",
    },
    point: { x: rect.right, y: rect.bottom },
    viewport: { width: innerWidth, height: innerHeight },
  };
}
module.exports = { pageAction, pageSelection };
