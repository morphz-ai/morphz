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
      appearance?: {
        setMode(
          mode: "system" | "light" | "dark",
        ): Promise<DesktopAppearanceState>;
        onChange(callback: (state: DesktopAppearanceState) => void): () => void;
      };
      openExternal?(url: string): Promise<void>;
      capture: {
        select(): Promise<{ mime: "image/png"; data: string } | null>;
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
        layout(
          pageId: string,
          bounds: {
            x: number;
            y: number;
            width: number;
            height: number;
          } | null,
        ): Promise<void>;
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
