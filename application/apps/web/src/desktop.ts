export type DesktopAppearanceState = {
  revision: number;
  material: "sidebar" | "solid";
  active: boolean;
  reducedTransparency: boolean;
  highContrast: boolean;
};
export type SourceView = {
  id: string;
  label: string;
  projectId: string;
  enabled: boolean;
  count: number;
  error: string;
  lastSync: string | null;
};
export type BrowserView = {
  pageId: string;
  surface: { partition: string; src: string };
  artifactId: string | null;
  projectId?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  epoch: string;
  url: string;
  title: string;
  granted: boolean;
  visible: boolean;
  error: string;
  pending: { id: string; label: string; action: string } | null;
};
declare global {
  interface Window {
    morphzDesktop?: {
      application?: {
        invoke(
          request: import("../../../packages/core/src/application-api.js").ApplicationInvocation,
        ): Promise<
          import("../../../packages/core/src/application-api.js").ApplicationReply
        >;
        cancel(id: string): void;
        subscribe(
          id: string,
          scope: { projectId: string; conversationId: string },
          generation: string,
        ): Promise<void>;
        unsubscribe(id: string): void;
        onStream(
          callback: (event: {
            id: string;
            closed?: boolean;
            value?: import("../../../packages/core/src/live-conversation.js").ConversationStream;
          }) => void,
        ): () => void;
      };
      scriptExports?: {
        save(request: {
          centerId: string;
          principalId: string;
          productionId: string;
          exportId: string;
        }): Promise<
          | { status: "cancelled"; exportId: string }
          | {
              status: "saved";
              exportId: string;
              filename: string;
              bytes: number;
              sha256: string;
              warning?: "temporary-file-cleanup-failed";
            }
        >;
      };
      appearance?: {
        setMode(
          mode: "system" | "light" | "dark",
        ): Promise<DesktopAppearanceState>;
        onChange(callback: (state: DesktopAppearanceState) => void): () => void;
      };
      openExternal?(url: string): Promise<void>;
      directories?: {
        choose(
          projectId: string,
          conversationId: string,
        ): Promise<
          | import("../../../packages/core/src/local-files.js").DirectoryGrant
          | null
        >;
      };
      files?: {
        choose(
          projectId: string,
          kind: "file" | "directory",
        ): Promise<
          | import("../../../packages/core/src/local-files.js").LocalFileView
          | null
        >;
        read(request: {
          projectId: string;
          grantId: string;
          path: string;
        }): Promise<
          import("../../../packages/core/src/local-files.js").LocalFileView
        >;
        revoke(request: { projectId: string; grantId: string }): Promise<void>;
      };
      capture: {
        select(options?: {
          hideWindow?: boolean;
        }): Promise<{ mime: "image/png"; data: string } | null>;
        cancel(): Promise<void>;
      };
      voice: {
        requestMicrophone(): Promise<boolean>;
        cancelMicrophone(): Promise<void>;
      };
      browser: {
        open(
          target: string | { projectId: string; url: string },
        ): Promise<BrowserView>;
        state(): Promise<BrowserView | null>;
        navigate(pageId: string, url: string): Promise<BrowserView>;
        control(
          pageId: string,
          action:
            | "grant"
            | "takeover"
            | "back"
            | "forward"
            | "reload"
            | "approve"
            | "reject",
        ): Promise<BrowserView>;
        visibility(pageId: string, visible: boolean): Promise<void>;
        onInput?(callback: () => void): () => void;
        close(pageId: string): Promise<void>;
      };
      sources: {
        list(): Promise<SourceView[]>;
        choose(
          projectId: string,
          kind: "file" | "directory",
        ): Promise<SourceView[]>;
        control(
          id: string,
          action: "resume" | "pause" | "remove" | "refresh",
        ): Promise<SourceView[]>;
      };
    };
  }
}
