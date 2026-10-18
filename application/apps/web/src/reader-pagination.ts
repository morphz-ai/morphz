import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { readerOffsets, readerRange } from "./reader-dom.js";
import type {
  ReadingLocation,
  ReadingSection,
} from "../../../packages/core/src/reader.js";

/** Screen pages are a layout projection. Only source offsets are persisted. */
export function useReaderPagination({
  enabled,
  active,
  section,
  preferences,
  viewport,
  article,
  progress,
}: {
  enabled: boolean;
  active: boolean;
  section: ReadingSection | null;
  preferences: unknown;
  viewport: RefObject<HTMLDivElement | null>;
  article: RefObject<HTMLDivElement | null>;
  progress: RefObject<ReadingLocation | null>;
}) {
  const [pages, setPages] = useState({ page: 0, count: 1 });
  const layout = useRef({ page: 0, count: 1, stride: 0 });
  const preserving = useRef(false),
    release = useRef(0);
  useLayoutEffect(() => () => cancelAnimationFrame(release.current), []);
  const go = (page: number, animate = false, preserveAnchor = true) => {
    const view = viewport.current;
    if (!view || !layout.current.stride) return;
    const next = Math.max(0, Math.min(layout.current.count - 1, page));
    cancelAnimationFrame(release.current);
    preserving.current = preserveAnchor;
    if (preserveAnchor)
      release.current = requestAnimationFrame(() => {
        release.current = requestAnimationFrame(() => {
          preserving.current = false;
        });
      });
    layout.current.page = next;
    view.scrollTo({
      left: next * layout.current.stride,
      top: 0,
      behavior:
        animate && !matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
    setPages({ page: next, count: layout.current.count });
  };
  const reveal = (target: Range | Element, preserveAnchor = true) => {
    const view = viewport.current;
    const rect = [...target.getClientRects()].find(
      (r) => r.width > 0 && r.height > 0,
    );
    if (!view || !rect || !layout.current.stride) return;
    const bounds = view.getBoundingClientRect();
    const scale = bounds.width / view.clientWidth;
    go(
      Math.floor(
        ((rect.left - bounds.left) / scale + view.scrollLeft) /
          layout.current.stride,
      ),
      false,
      preserveAnchor,
    );
  };
  useLayoutEffect(() => {
    const view = viewport.current,
      root = article.current;
    if (!enabled || !active || !section || !view || !root) return;
    let frame = 0,
      disposed = false;
    const measure = () => {
      if (!view.clientWidth || !view.clientHeight) return;
      const saved = progress.current;
      const width = view.clientWidth,
        height = view.clientHeight;
      const gutter = Math.max(28, (width - Math.min(680, width - 72)) / 2);
      const block = Math.min(32, Math.max(16, height * 0.035));
      view.style.setProperty(
        "--reader-column-width",
        `${width - 2 * gutter}px`,
      );
      view.style.setProperty("--reader-page-gap", `${gutter * 2}px`);
      view.style.setProperty(
        "--reader-page-height",
        `${Math.max(1, height - 2 * block)}px`,
      );
      view.style.setProperty("--reader-page-gutter", `${gutter}px`);
      view.style.setProperty("--reader-page-inset", `${block}px`);
      const count = Math.max(
        1,
        Math.ceil((root.scrollWidth + 2 * gutter) / width),
      );
      view.style.setProperty("--reader-flow-width", `${count * width}px`);
      layout.current = { page: layout.current.page, count, stride: width };
      if (
        saved?.sourceId === section.sourceId &&
        saved.sectionId === section.id
      ) {
        const offsets = readerOffsets(root.textContent ?? "", section.text);
        const from = offsets?.sourceToDom[saved.start];
        const to =
          offsets?.sourceToDom[Math.min(saved.start + 1, section.text.length)];
        const range =
          from !== undefined && to !== undefined
            ? readerRange(root, from, to)
            : null;
        if (range) {
          reveal(range);
          return;
        }
      }
      go(layout.current.page);
    };
    const schedule = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(view);
    // Images and late fonts may change the number of columns without resizing the viewport.
    view.addEventListener("load", schedule, true);
    void document.fonts.ready.then(schedule);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      view.removeEventListener("load", schedule, true);
    };
  }, [enabled, active, section, preferences]);
  return {
    ...pages,
    go,
    reveal,
    preservingAnchor: () => preserving.current,
    turn(direction: -1 | 1) {
      const next = layout.current.page + direction;
      if (next < 0 || next >= layout.current.count) return false;
      go(next, true, false);
      return true;
    },
  };
}
