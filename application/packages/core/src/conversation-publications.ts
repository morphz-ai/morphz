type PublicationMessage = {
  id: string;
  kind: string;
  projectId: string;
  conversationId?: string;
  inputId?: string | null;
  rootId?: string | null;
  publicationKey?: string;
  threadId?: string;
  streaming?: boolean;
};

function publicationScope(message: PublicationMessage): string | null {
  if (
    !message.publicationKey ||
    !message.projectId ||
    !message.conversationId ||
    !message.inputId ||
    !message.rootId
  )
    return null;
  return JSON.stringify([
    message.projectId,
    message.conversationId,
    message.inputId,
    message.rootId,
    message.publicationKey,
  ]);
}

/** Reconcile two presentations of one Runtime publication, never equal prose.
 * A canonical terminal row replaces only its attributed public stream prefix.
 * Timeline rows do not carry threadId; where both projections supply it, a
 * different branch must remain distinct. Unknown provenance stays readable.
 * The surviving objects, first-visible timestamps and IDs are not rewritten. */
export function reconcileConversationPublications<T extends PublicationMessage>(
  messages: readonly T[],
): T[] {
  const finals = new Map<string, T[]>();
  for (const message of messages) {
    const scope = publicationScope(message);
    if (
      !scope ||
      message.id !== `publication:${message.publicationKey}` ||
      message.streaming !== undefined ||
      (message.kind !== "reply" && message.kind !== "error")
    )
      continue;
    const previous = finals.get(scope) ?? [];
    previous.push(message);
    finals.set(scope, previous);
  }
  return messages.filter((message) => {
    if (
      !message.id.startsWith("stream:") ||
      (message.kind !== "reply" && message.kind !== "error")
    )
      return true;
    const scope = publicationScope(message);
    return (
      !scope ||
      !finals
        .get(scope)
        ?.some(
          (final) =>
            !message.threadId ||
            !final.threadId ||
            message.threadId === final.threadId,
        )
    );
  });
}
