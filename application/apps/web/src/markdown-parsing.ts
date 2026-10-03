import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import type { PluggableList } from "unified";

/** Shared grammar only; each surface keeps its own link and media policy. */
export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkCjkFriendly,
];
