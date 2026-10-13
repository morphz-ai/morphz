type PublicationMessage = {
  id: string;
  kind: string;
  projectId: string;
  conversationId?: string;
  inputId?: string | null;
  rootId?: string | null;
  publicationKey?: string;
  modelAttemptId?: string;
  threadId?: string;
  streaming?: boolean;
  providerRecovery?: { startedAt: string };
};

function publicationScope(
  message: PublicationMessage,
  publicationKey = message.publicationKey,
): string | null {
  if (
    !publicationKey ||
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
    publicationKey,
  ]);
}

/** Reconcile two presentations of one Runtime publication, never equal prose.
 * A semantic outcome replaces only its explicitly attributed public prefix.
 * A retry is related by Runtime's model_attempt_id, never a name suffix or prose.
 * Actual progress replaces its words; Provider waiting never erases the prefix.
 * When both projections identify a Thread, they must agree. Unknown
 * provenance stays readable; a different branch must remain distinct.
 * The surviving objects, first-visible timestamps and IDs are not rewritten. */
export function reconcileConversationPublications<T extends PublicationMessage>(
  messages: readonly T[],
): T[] {
  const finals = new Map<string, T[]>();
  for (const message of messages) {
    const scope = publicationScope(message);
    if (
      !scope ||
      message.streaming !== undefined ||
      !(
        ((message.kind === "reply" || message.kind === "error") &&
          message.id === `publication:${message.publicationKey}`) ||
        (message.kind === "progress" &&
          !message.id.startsWith("stream:") &&
          !message.providerRecovery)
      )
    )
      continue;
    const previous = finals.get(scope) ?? [];
    previous.push(message);
    finals.set(scope, previous);
    const modelScope = message.modelAttemptId
      ? publicationScope(message, message.modelAttemptId)
      : null;
    if (modelScope && modelScope !== scope) {
      const previous = finals.get(modelScope) ?? [];
      previous.push(message);
      finals.set(modelScope, previous);
    }
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
