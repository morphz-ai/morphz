import type {
  DiscussionDirectoryCursor,
  DiscussionSummary,
} from "./comment-discussion-controller.js";

export type DiscussionMark = DiscussionSummary & { text?: string };
export type PassageSource<Q> = { key: string; quote: Q };
export type PassageMark = {
  key: string;
  id: string;
  quote: unknown;
  count: number;
  more: boolean;
  x: number;
  y: number;
  preview: string;
};
type Owner<Q> = {
  selector: string;
  describe(root: HTMLElement): PassageSource<Q> | null;
  read(
    quote: Q,
    signal: AbortSignal,
  ): Promise<{
    items: DiscussionSummary[];
    nextCursor: DiscussionDirectoryCursor | null;
  }>;
  range(root: HTMLElement, mark: DiscussionMark): Range | null;
  open(id: string, quote: Q, point: { x: number; y: number }): void;
};
type SourcePage<Q> = {
  source: PassageSource<Q>;
  items: DiscussionMark[];
  loaded: boolean;
  more: boolean;
  read?: AbortController;
};

/** Visible, already-loaded sources own their independent first metadata page.
 * Scrolling does layout work only; it never drains a directory or transcript.
 * The owner retires all requests on scope/permission change. */
export class DiscussionMarks<Q> {
  private roots = new Map<HTMLElement, PassageSource<Q>>();
  private ids = new WeakMap<HTMLElement, number>();
  private serial = 0;
  private visible = new Set<HTMLElement>();
  private pages = new Map<string, SourcePage<Q>>();
  private listeners = new Set<() => void>();
  private intersections?: IntersectionObserver;
  private mutations?: MutationObserver;
  private resize?: ResizeObserver;
  private frame = 0;
  private running = false;
  private online = true;
  private inFlight = 0;
  private clickRanges: {
    range: Range;
    source: PassageSource<Q>;
    id: string;
  }[] = [];
  private highlightName = `morphz-discussions-${Math.random().toString(36).slice(2)}`;
  version = 0;
  marks: PassageMark[] = [];
  private owner: Owner<Q>;
  constructor(owner: Owner<Q>) {
    this.owner = owner;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  start() {
    this.running = true;
    this.intersections = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const root = entry.target as HTMLElement;
        if (entry.isIntersecting) this.visible.add(root);
        else this.visible.delete(root);
      }
      const visibleKeys = new Set(
        [...this.visible].map((root) => this.roots.get(root)?.key),
      );
      for (const [key, page] of this.pages)
        if (!visibleKeys.has(key)) page.read?.abort();
      this.pump();
      this.layout();
    });
    this.resize = new ResizeObserver(this.layout);
    this.mutations = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes")
          this.discover(record.target as HTMLElement);
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement) this.discover(node);
      }
      for (const root of this.roots.keys())
        if (!root.isConnected) {
          this.intersections?.unobserve(root);
          this.resize?.unobserve(root);
          this.roots.delete(root);
          this.visible.delete(root);
        }
      this.layout();
    });
    this.mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-text-source", "data-event-id"],
    });
    this.discover(document.body);
    document.addEventListener("scroll", this.layout, true);
    window.addEventListener("resize", this.layout);
    document.addEventListener("click", this.click);
  }
  private discover(node: HTMLElement) {
    if (node.closest("[data-quote-ui], [data-discussion-ui]")) return;
    if (node.matches(this.owner.selector)) this.register(node);
    for (const root of node.querySelectorAll<HTMLElement>(this.owner.selector))
      this.register(root);
  }
  private register(root: HTMLElement) {
    if (!root.matches(this.owner.selector)) return;
    if (root.closest("[data-quote-ui], [data-discussion-ui]")) return;
    const source = this.owner.describe(root);
    if (!source) return;
    const previous = this.roots.get(root);
    if (previous?.key === source.key) return;
    root.removeAttribute("data-discussion-marked");
    this.roots.set(root, source);
    if (!this.ids.has(root)) this.ids.set(root, ++this.serial);
    this.intersections?.observe(root);
    this.resize?.observe(root);
  }
  private pump() {
    if (!this.running || !this.online) return;
    for (const root of this.visible) {
      if (this.inFlight >= 2) break;
      const source = this.roots.get(root);
      if (!source) continue;
      let page = this.pages.get(source.key);
      if (!page) {
        if (this.pages.size >= 64) {
          const visibleKeys = new Set(
            [...this.visible].map((root) => this.roots.get(root)?.key),
          );
          const evict = [...this.pages].find(
            ([key, page]) => !visibleKeys.has(key) && !page.read,
          );
          if (!evict) continue;
          this.pages.delete(evict[0]);
        }
        page = { source, items: [], loaded: false, more: false };
        this.pages.set(source.key, page);
      }
      if (page.loaded || page.read) continue;
      const owned = page,
        read = new AbortController();
      owned.read = read;
      this.inFlight++;
      void this.owner
        .read(source.quote, read.signal)
        .then((result) => {
          if (
            !this.running ||
            read.signal.aborted ||
            this.pages.get(source.key) !== owned
          )
            return;
          if (
            result.items.length > 10 ||
            new TextEncoder().encode(JSON.stringify(result.items)).byteLength >
              2 * 1024 * 1024
          )
            throw Error("Discussion marker page exceeds its budget");
          // Keep accepted local additions that arrived while this page was held.
          const merged = new Map(owned.items.map((item) => [item.id, item]));
          for (const item of result.items)
            if (!merged.has(item.id)) merged.set(item.id, item);
          owned.items = [...merged.values()].slice(0, 10);
          owned.more = result.nextCursor !== null || merged.size > 10;
        })
        .catch(() => {
          // A failed metadata read never erases known marks or claims absence.
        })
        .finally(() => {
          owned.loaded = !read.signal.aborted;
          owned.read = undefined;
          this.inFlight--;
          if (this.running) {
            this.pump();
            this.layout();
          }
        });
    }
  }
  accepted(source: PassageSource<Q>, mark: DiscussionMark) {
    if (!this.running) return;
    let page = this.pages.get(source.key);
    if (!page) {
      if (
        ![...this.visible].some(
          (root) => this.roots.get(root)?.key === source.key,
        )
      )
        return;
      page = { source, items: [], loaded: false, more: false };
      this.pages.set(source.key, page);
    }
    const existing = page.items.findIndex((item) => item.id === mark.id);
    if (existing >= 0) page.items[existing] = mark;
    else page.items.unshift(mark);
    if (page.items.length > 10) {
      page.items.length = 10;
      page.more = true;
    }
    this.layout();
  }
  connection(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      for (const page of this.pages.values()) page.read?.abort();
      return;
    }
    for (const root of this.visible) {
      const key = this.roots.get(root)?.key,
        page = key && this.pages.get(key);
      if (page) page.loaded = false;
    }
    this.pump();
  }
  private layout = () => {
    if (!this.running || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  };
  private paint() {
    this.marks = [];
    this.clickRanges = [];
    const ranges: Range[] = [];
    for (const root of this.visible) {
      const source = this.roots.get(root),
        page = source && this.pages.get(source.key);
      if (!source || !page?.items.length || !root.isConnected) {
        root.removeAttribute("data-discussion-marked");
        continue;
      }
      const box = root.getBoundingClientRect();
      if (!box.width || box.bottom <= 0 || box.top >= innerHeight) continue;
      root.setAttribute("data-discussion-marked", "true");
      for (const item of page.items) {
        const range = this.owner.range(root, item);
        if (range) {
          ranges.push(range);
          this.clickRanges.push({ range, source, id: item.id });
        }
      }
      const first = page.items[0]!;
      this.marks.push({
        key: `${source.key}:${this.ids.get(root)}`,
        id: first.id,
        quote: source.quote,
        count: page.items.length,
        more: page.more,
        x: Math.min(innerWidth - 40, box.right - 34),
        y: Math.max(0, box.top),
        preview: first.preview,
      });
    }
    const highlight = Reflect.get(window, "Highlight") as
      (new (...ranges: Range[]) => unknown) | undefined;
    const registry = CSS.highlights;
    if (highlight && registry) {
      const value = new highlight(...ranges) as Highlight;
      registry.set(this.highlightName, value);
      // Use one semantic pseudo-element rule for all owned ranges.
      const style =
        document.getElementById(this.highlightName) ??
        document.head.appendChild(
          Object.assign(document.createElement("style"), {
            id: this.highlightName,
          }),
        );
      style.textContent = `::highlight(${this.highlightName}) { background-color: var(--discussion-highlight, #9bdce14d); text-decoration: underline; text-decoration-color: var(--discussion-ink, #168492); text-decoration-thickness: 1px; text-underline-offset: 3px; }`;
    }
    this.version++;
    for (const listener of this.listeners) listener();
  }
  open(mark: PassageMark) {
    this.owner.open(mark.id, mark.quote as Q, { x: mark.x, y: mark.y + 24 });
  }
  private click = (event: MouseEvent) => {
    if (
      event.button ||
      window.getSelection()?.toString() ||
      (event.target as Element)?.closest(
        "button,a,input,textarea,[data-discussion-ui]",
      )
    )
      return;
    for (const item of this.clickRanges)
      if (
        [...item.range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        )
      ) {
        this.owner.open(item.id, item.source.quote, {
          x: event.clientX,
          y: event.clientY,
        });
        break;
      }
  };
  dispose() {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.intersections?.disconnect();
    this.mutations?.disconnect();
    this.resize?.disconnect();
    document.removeEventListener("scroll", this.layout, true);
    window.removeEventListener("resize", this.layout);
    document.removeEventListener("click", this.click);
    for (const page of this.pages.values()) page.read?.abort();
    for (const root of this.roots.keys())
      root.removeAttribute("data-discussion-marked");
    CSS.highlights?.delete(this.highlightName);
    document.getElementById(this.highlightName)?.remove();
    this.roots.clear();
    this.visible.clear();
    this.marks = [];
  }
}

/** Offsets belong to the immutable source, never the layout or nearby message.
 * Old short snapshots may be located only when unique; ambiguous text stays a
 * source-level marker rather than a highlight on the wrong passage. */
export function discussionRange(
  root: HTMLElement,
  mark: DiscussionMark,
): Range | null {
  const locator = mark.locator ?? {},
    anchor = locator.anchor as
      | { start?: number; end?: number; prefix?: string; suffix?: string }
      | undefined;
  const text = root.textContent ?? "",
    offset = Number(root.dataset.textOffset ?? 0);
  let start = -1,
    end = -1;
  if (
    anchor &&
    Number.isSafeInteger(anchor.start) &&
    Number.isSafeInteger(anchor.end)
  ) {
    start = anchor.start! - offset;
    end = anchor.end! - offset;
    const value = text.slice(start, end);
    if (
      start < 0 ||
      end > text.length ||
      !value.startsWith(mark.preview) ||
      (anchor.prefix && !text.slice(0, start).endsWith(anchor.prefix)) ||
      (anchor.suffix && !text.slice(end).startsWith(anchor.suffix))
    )
      return null;
  } else {
    const exact =
      mark.text ?? (Array.from(mark.preview).length < 160 ? mark.preview : "");
    if (!exact) return null;
    start = text.indexOf(exact);
    end = start + exact.length;
    if (start < 0 || text.indexOf(exact, start + 1) >= 0) return null;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    range = document.createRange();
  let seen = 0,
    began = false,
    node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!began && start < seen + length) {
      range.setStart(node, start - seen);
      began = true;
    }
    if (began && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
