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
  artifactId: string;
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
        open(artifactId: string): Promise<BrowserView>;
        state(): Promise<BrowserView | null>;
        navigate(pageId: string, url: string): Promise<BrowserView>;
        control(
          pageId: string,
          action:
            "grant" | "takeover" | "back" | "reload" | "approve" | "reject",
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
