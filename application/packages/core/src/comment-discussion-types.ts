/** Shared presentation contract. Keep this module independent of Host schemas
 * so the standalone Dashboard can consume it without Desktop dependencies. */
export type DiscussionReplyLocator = {
  messageId: string;
  eventId: string;
};

export type CommentDiscussionMessage = {
  id: string;
  eventId: string;
  entryId?: string;
  contentOmitted?: boolean;
  nextOffset?: number | null;
  rootId: string;
  createdAt: string;
  kind: "input" | "reply" | "progress" | "error";
  text: string;
  streaming?: boolean;
  replace?: boolean;
  truncated?: boolean;
  threadId?: string;
  generation?: number;
};

export type CommentDiscussionPage = {
  id: string;
  messages: CommentDiscussionMessage[];
  nextCursor: { createdAt: string; id: string } | null;
};
