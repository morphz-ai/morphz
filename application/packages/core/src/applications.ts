import { z } from "zod";
import {
  applicationManifestFormat,
  legacyApplicationManifestFormat,
} from "./application-names.js";

// Work UI package v1 is a host extension, not a change to the HNS format.
const name = z.string().trim().min(1).max(100);
export const applicationManifestSchema = z
  .object({
    format: z.enum([
      applicationManifestFormat,
      legacyApplicationManifestFormat,
    ]),
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,80}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: name,
    description: z.string().max(500),
    icon: z.enum(["layers", "document", "globe", "code", "book", "film"]),
    iconImage: z
      .string()
      .max(180000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
      .optional(),
    permissions: z
      .array(z.enum(["artifacts.read", "artifacts.write", "input.compose"]))
      .max(3),
    harness: z.object({ id: name, version: name }).strict().nullable(),
    ui: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("builtin"),
          view: z.enum(["objects", "browser", "script-studio"]),
          presentation: z.enum(["workspace", "immersive"]).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("sandbox"),
          html: z.string().min(1).max(1000000),
          presentation: z.enum(["workspace", "immersive"]).optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type ApplicationManifest = z.infer<typeof applicationManifestSchema>;

/** Presentation-only correction for the bundled example's old launcher copy.
 * Installed HTML, protocol, permissions, versions and saved instances stay intact.
 */
export function applicationDescription(app: ApplicationManifest) {
  return app.id === "example.scratchpad" &&
    app.description === "宿主协议示例：独立界面、状态恢复、保存对象与协作输入。"
    ? "记下想法，保存为文档，或交给 Morphz 继续整理。"
    : app.description;
}
export const applicationStateSchema = z
  .record(z.string().max(100), z.json())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65536,
    "应用视图状态超过 64 KiB；正文请保存为对象。",
  );
export const applicationInstanceSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    applicationId: z.string(),
    applicationVersion: z.string(),
    revision: z.number().int().positive(),
    state: applicationStateSchema,
    status: z.enum(["open", "closed"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ApplicationInstance = z.infer<typeof applicationInstanceSchema>;
export const objectsApplication: ApplicationManifest = {
  format: applicationManifestFormat,
  id: "morphz.objects",
  version: "1.0.0",
  title: "内容",
  description: "阅读、编辑和整理当前工作空间的内容。",
  icon: "layers",
  permissions: ["artifacts.read", "artifacts.write", "input.compose"],
  harness: null,
  ui: { type: "builtin", view: "objects" },
};

export const browserApplication: ApplicationManifest = {
  format: applicationManifestFormat,
  id: "morphz.browser",
  version: "1.0.0",
  title: "浏览器",
  description: "直接访问网站；需要时让 Morphz 协助。",
  icon: "globe",
  permissions: ["input.compose"],
  harness: null,
  ui: { type: "builtin", view: "browser", presentation: "workspace" },
};

export const scriptStudioApplication: ApplicationManifest = {
  format: applicationManifestFormat,
  id: "morphz.script-studio",
  version: "1.0.0",
  title: "剧本工作室",
  description: "从创作要求到分集分场、候选审改与锁稿交付。",
  icon: "film",
  permissions: ["input.compose"],
  // New inputs snapshot this execution package; existing inputs/retries keep
  // their immutable Harness reference. The builtin UI protocol stays v1.
  harness: { id: "morphz.script-studio", version: "1.1.1" },
  ui: { type: "builtin", view: "script-studio", presentation: "workspace" },
};

/** null/absent means unverified, never an empty installed registry. */
export function harnessReadinessError(
  required: { id: string; version: string },
  loaded: { id: string; version: string }[] | null | undefined,
): string | null {
  if (!loaded)
    return "运行服务尚未提供应用执行包的就绪检查，请更新并检查运行服务；输入会保留，不会改用普通聊天。";
  if (
    !loaded.some((h) => h.id === required.id && h.version === required.version)
  )
    return `运行服务尚未加载应用执行包 ${required.id}@${required.version}。请在当前运行服务安装并加载该版本，再重试原输入。`;
  return null;
}

export const applicationMessageSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("ready") }).strict(),
  z
    .object({
      method: z.literal("saveState"),
      expectedRevision: z.number().int().positive(),
      state: applicationStateSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("readArtifact"),
      artifactId: z.string(),
      revision: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({ method: z.literal("openArtifact"), artifactId: z.string() })
    .strict(),
  z
    .object({
      method: z.literal("compose"),
      text: z.string().max(30000),
      artifactId: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("command"), operation: z.unknown() }).strict(),
]);
