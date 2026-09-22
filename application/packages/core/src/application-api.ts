// Logical application operations. No HTTP, Electron, filesystem or credentials.
// Both hosts call the same business layer; only their transport adapters differ.
export const applicationMethods = [
  "workspace",
  "connection.check",
  "connection.configure",
  "login",
  "logout",
  "command",
  "message",
  "input.send",
  "input.cancel",
  "search",
  "artifact.read",
  "local-files.read",
  "directories.list",
  "directories.revoke",
  "local-files.revoke",
  "models",
  "model-settings.read",
  "model-settings.update",
  "asset.add",
  "attachment.add",
  "pdf.import",
  "reader.import",
  "reader.read",
  "reader.contents",
  "reader.ocr",
  "execution.snapshot",
  "execution.result",
  "execution.control",
  "task.snapshot",
  "task.control",
  "speech.status",
  "speech.transcribe",
  "speech.stream",
  "speech.synthesize",
  "notifications.read",
  "notifications.control",
  "browser.register",
  "browser.exchange",
] as const;
export type ApplicationMethod = (typeof applicationMethods)[number];
export type ApplicationFailure = {
  status: number;
  code: string;
  message: string;
};
export type ApplicationReply =
  { ok: true; value: unknown } | { ok: false; error: ApplicationFailure };
export type ApplicationInvocation = {
  id: string;
  method: ApplicationMethod;
  params?: unknown;
  identityGeneration?: string;
};
export type ApplicationConnection =
  { mode: "local" } | { mode: "remote"; url: string };
export type ApplicationCallOptions = {
  identityGeneration?: string;
  signal?: AbortSignal;
};
export interface ApplicationCaller {
  call(
    method: ApplicationMethod,
    params?: unknown,
    options?: ApplicationCallOptions,
  ): Promise<unknown>;
}
export class ApplicationRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
