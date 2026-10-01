import type { RuntimeBridge } from "../packages/application/src/runtime.js";
import type { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";

/** Empty Runtime transport for HTTP identity/stream-lifecycle tests. It checks
 * actual Platform permissions but never represents persisted Runtime history. */
export function emptyPlatformStream(
  domains: Awaited<ReturnType<typeof openApplicationDomainsHost>>,
  options: { teamIdentity?: boolean } = {},
): RuntimeBridge {
  const fixture: Pick<
    RuntimeBridge,
    | "teamIdentity"
    | "isConnected"
    | "supportsDirectedInput"
    | "platformAttachmentOwner"
    | "observePlatformConversation"
  > = {
    teamIdentity: options.teamIdentity ?? true,
    isConnected: false,
    supportsDirectedInput: false,
    async platformAttachmentOwner() {
      // No inputs or attachments have been accepted by this Runtime fixture.
      return null;
    },
    async observePlatformConversation(scope, access, emit, failed) {
      const authorize = () =>
        domains.work.authority.withSession(
          access,
          () => {},
          (actor) =>
            domains.content.platform.authorizeConversationRead(actor, scope),
        );
      await authorize();
      let closed = false;
      const close = () => {
        closed = true;
        clearInterval(timer);
      };
      const timer = setInterval(() => {
        void authorize().then(
          () => {
            if (!closed) emit({ connected: false, messages: [] });
          },
          () => {
            if (!closed) {
              close();
              failed();
            }
          },
        );
      }, 50);
      emit({ connected: false, messages: [] });
      return close;
    },
  };
  return fixture as RuntimeBridge;
}
