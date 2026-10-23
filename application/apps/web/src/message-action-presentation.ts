import type { ReactNode } from "react";
import type { WorkspaceClient } from "./client.js";
import type { MessageShareContent } from "./MessageShareDialog.js";

export type MessageActionProps = {
  createdAt: string;
  text: string;
  control?: ReactNode;
  share: MessageShareContent;
  client: WorkspaceClient;
};

function sameFields(previous: object, next: object) {
  const keys = Object.keys(previous);
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) =>
        Object.hasOwn(next, key) &&
        Object.is(Reflect.get(previous, key), Reflect.get(next, key)),
    )
  );
}

/** Cache only an unchanged footer, never message ownership or authorization.
 * Conversation builds new share arrays on every stream delta. Compare their
 * small, already selected presentation fields; all other values (including
 * state, catalog, Client and live controls) retain reference equality. Unknown
 * or future fields fail closed rather than silently keeping an old closure. */
export function sameMessageActionPresentation(
  previous: Readonly<MessageActionProps>,
  next: Readonly<MessageActionProps>,
) {
  const { share: oldShare, ...oldSurface } = previous;
  const { share: newShare, ...newSurface } = next;
  if (!sameFields(oldSurface, newSurface)) return false;
  const {
    quotes: oldQuotes,
    attachments: oldAttachments,
    ...oldContent
  } = oldShare;
  const {
    quotes: newQuotes,
    attachments: newAttachments,
    ...newContent
  } = newShare;
  return (
    sameFields(oldContent, newContent) &&
    oldQuotes.length === newQuotes.length &&
    oldQuotes.every((quote, index) => sameFields(quote, newQuotes[index]!)) &&
    oldAttachments.length === newAttachments.length &&
    oldAttachments.every((name, index) => name === newAttachments[index])
  );
}
