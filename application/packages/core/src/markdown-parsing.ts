import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import type { PluggableList } from "unified";
import { readableAutolinks } from "./markdown-autolinks.js";

/** Grammar shared by message rendering and authoritative quote validation.
 * Each surface retains its own navigation, remote media and HTML policies. */
export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkCjkFriendly,
  readableAutolinks,
];
