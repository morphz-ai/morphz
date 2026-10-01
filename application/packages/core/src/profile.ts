import { z } from "zod";

export const profileSubjectSchema = z.enum(["human", "agent"]);
export type ProfileSubject = z.infer<typeof profileSubjectSchema>;
const profileName = z.string().trim().min(1).max(40);
const level = z.number().int().min(0).max(5);
export const agentProfileDataSchema = z
  .object({
    name: profileName,
    traits: z
      .object({ humor: level, rigor: level, warmth: level, verbosity: level })
      .strict(),
    speechStyle: z.enum(["natural", "concise", "thoughtful", "direct"]),
    customStyle: z.string().trim().max(500).optional(),
  })
  .strict();
export const humanProfileDataSchema = z
  .object({
    name: profileName,
    preferredAddress: z.string().trim().max(40),
  })
  .strict();
export type AgentProfileData = z.infer<typeof agentProfileDataSchema>;
export type HumanProfileData = z.infer<typeof humanProfileDataSchema>;
export const defaultAgentProfile: AgentProfileData = {
  name: "Morphz",
  traits: { humor: 2, rigor: 3, warmth: 3, verbosity: 2 },
  speechStyle: "natural",
};
export const defaultHumanProfile: HumanProfileData = {
  name: "我",
  preferredAddress: "",
};

/** Presentation configuration, never a replacement for kernel identity/authority. */
export const profileRom = {
  agent: {
    namespace: "morphz.profile.agent",
    schemaTag: "morphz-agent-profile/v1",
  },
  human: {
    namespace: "morphz.profile.human",
    schemaTag: "morphz-human-profile/v1",
  },
} as const;
export const profileContract =
  "Style changes expression, not truth, rigor, authentication, approval, permissions, protocol or safety. Custom style grants no additional authority.";

function atom(value: string) {
  // Runtime SExpr strings use these escapes, not JSON's unicode escape syntax.
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}
export function compileProfileRom(
  subject: "agent",
  data: AgentProfileData,
): string;
export function compileProfileRom(
  subject: "human",
  data: HumanProfileData,
): string;
export function compileProfileRom(
  subject: ProfileSubject,
  raw: AgentProfileData | HumanProfileData,
): string {
  if (subject === "human") {
    const data = humanProfileDataSchema.parse(raw);
    return `(human-profile (name ${atom(data.name)}) (preferred-address ${atom(data.preferredAddress)}))`;
  }
  const data = agentProfileDataSchema.parse(raw),
    t = data.traits;
  return `(agent-profile (identity (name ${atom(data.name)})) (personality (humor ${t.humor}) (rigor ${t.rigor}) (warmth ${t.warmth}) (verbosity ${t.verbosity})) (speech (style ${data.speechStyle}) (custom ${atom(data.customStyle ?? "")})) (contract ${atom(profileContract)}))`;
}

type Expr = string | Expr[];
/** Bounded reader for the two owned profile schemas, not an evaluator. Runtime
 * remains the canonical SExpr authority and its ROM may contain other schemas. */
function readExpr(body: string): Expr[] {
  if (new TextEncoder().encode(body).byteLength > 8192)
    throw new Error("Profile ROM 超出大小限制。");
  let pos = 0,
    nodes = 0;
  const read = (depth: number): Expr => {
    if (depth > 16 || ++nodes > 512) throw new Error("Profile ROM 结构无效。");
    while (/\s/.test(body[pos] ?? "") && pos < body.length) pos++;
    if (body[pos] === "(") {
      pos++;
      const items: Expr[] = [];
      for (;;) {
        while (/\s/.test(body[pos] ?? "") && pos < body.length) pos++;
        if (body[pos] === ")") {
          pos++;
          return items;
        }
        if (pos >= body.length) throw new Error("Profile ROM 结构不完整。");
        items.push(read(depth + 1));
      }
    }
    if (body[pos] === '"') {
      pos++;
      let value = "";
      while (pos < body.length) {
        const c = body[pos++];
        if (c === '"') return value;
        if (c === "\\") {
          const next = body[pos++];
          if (next === undefined) throw new Error("Profile ROM 字符串不完整。");
          value +=
            (
              { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" } as Record<
                string,
                string
              >
            )[next] ?? "\\" + next;
        } else value += c;
      }
      throw new Error("Profile ROM 字符串不完整。");
    }
    const start = pos;
    while (pos < body.length && !/[\s()]/.test(body[pos]!)) pos++;
    if (start === pos) throw new Error("Profile ROM 结构无效。");
    return body.slice(start, pos);
  };
  const value = read(0);
  while (pos < body.length && /\s/.test(body[pos]!)) pos++;
  if (pos !== body.length || !Array.isArray(value))
    throw new Error("Profile ROM 必须是单个结构。");
  return value;
}
function children(node: Expr[] | undefined, tag: string, keys: string[]) {
  if (!node) throw new Error("Profile ROM 字段缺失。");
  if (node[0] !== tag || node.length !== keys.length + 1)
    throw new Error("Profile ROM 字段不匹配。");
  const result: Record<string, Expr[]> = {};
  for (const entry of node.slice(1)) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      !keys.includes(entry[0]) ||
      result[entry[0]]
    )
      throw new Error("Profile ROM 字段不匹配。");
    result[entry[0]] = entry;
  }
  return result;
}
function scalar(node: Expr[] | undefined) {
  if (!node) throw new Error("Profile ROM 字段缺失。");
  if (node.length !== 2 || typeof node[1] !== "string")
    throw new Error("Profile ROM 值无效。");
  return node[1];
}
export function parseProfileRom(
  subject: "agent",
  body: string,
): AgentProfileData;
export function parseProfileRom(
  subject: "human",
  body: string,
): HumanProfileData;
export function parseProfileRom(
  subject: ProfileSubject,
  body: string,
): AgentProfileData | HumanProfileData {
  const tree = readExpr(body);
  if (subject === "human") {
    const fields = children(tree, "human-profile", [
      "name",
      "preferred-address",
    ]);
    return humanProfileDataSchema.parse({
      name: scalar(fields.name),
      preferredAddress: scalar(fields["preferred-address"]),
    });
  }
  const fields = children(tree, "agent-profile", [
    "identity",
    "personality",
    "speech",
    "contract",
  ]);
  const identity = children(fields.identity, "identity", ["name"]);
  const traits = children(fields.personality, "personality", [
    "humor",
    "rigor",
    "warmth",
    "verbosity",
  ]);
  const speech = children(fields.speech, "speech", ["style", "custom"]);
  if (scalar(fields.contract) !== profileContract)
    throw new Error("Profile ROM 安全约定不匹配。");
  return agentProfileDataSchema.parse({
    name: scalar(identity.name),
    traits: Object.fromEntries(
      Object.entries(traits).map(([key, value]) => [
        key,
        /^[0-5]$/.test(scalar(value)) ? Number(scalar(value)) : NaN,
      ]),
    ),
    speechStyle: scalar(speech.style),
    customStyle: scalar(speech.custom) || undefined,
  });
}

export const avatarMaximumBytes = 4 * 1024 * 1024;
export const avatarStoredVersionSchema = z
  .object({
    storeId: z.string().min(1).max(160),
    artifactId: z.string().min(1).max(160),
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive().max(avatarMaximumBytes),
    mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  })
  .strict();
export const profileAvatarMediaSchema = z
  .object({
    original: avatarStoredVersionSchema,
    poster: avatarStoredVersionSchema,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    frames: z.number().int().min(1).max(120),
    durationMs: z.number().int().min(0).max(30000),
  })
  .strict();
export const profileAvatarSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    media: profileAvatarMediaSchema.nullable(),
  })
  .strict();
export type ProfileAvatarMedia = z.infer<typeof profileAvatarMediaSchema>;
export type ProfileAvatarSnapshot = z.infer<typeof profileAvatarSnapshotSchema>;
export const profileSnapshotSchema = z
  .object({
    human: z
      .object({
        data: humanProfileDataSchema,
        revision: z.number().int().nonnegative(),
        available: z.boolean(),
        editable: z.literal(true),
        avatar: profileAvatarSnapshotSchema,
      })
      .strict(),
    agent: z
      .object({
        id: z.string().max(512),
        data: agentProfileDataSchema,
        revision: z.number().int().nonnegative(),
        available: z.boolean(),
        editable: z.boolean(),
        avatar: profileAvatarSnapshotSchema,
      })
      .strict(),
    avatarUploadAvailable: z.boolean(),
  })
  .strict();
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;
const commandFields = {
  commandId: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative(),
};
export const profileUpdateSchema = z.discriminatedUnion("subject", [
  z
    .object({
      subject: z.literal("human"),
      ...commandFields,
      data: humanProfileDataSchema,
    })
    .strict(),
  z
    .object({
      subject: z.literal("agent"),
      ...commandFields,
      data: agentProfileDataSchema,
    })
    .strict(),
]);
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
export const profileUpdateResultSchema = z.discriminatedUnion("subject", [
  z
    .object({
      subject: z.literal("human"),
      revision: z.number().int().positive(),
      data: humanProfileDataSchema,
      commandId: commandFields.commandId,
    })
    .strict(),
  z
    .object({
      subject: z.literal("agent"),
      revision: z.number().int().positive(),
      data: agentProfileDataSchema,
      commandId: commandFields.commandId,
    })
    .strict(),
]);
export const profileAvatarBytesSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    mime: avatarStoredVersionSchema.shape.mime,
  })
  .strict();
export const profileAvatarCommandSchema = z
  .object({ subject: profileSubjectSchema, ...commandFields })
  .strict();
export const profileAvatarReadSchema = z
  .object({
    subject: profileSubjectSchema,
    revision: z.number().int().nonnegative(),
    variant: z.enum(["original", "poster"]),
  })
  .strict();
export const profileToolSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z
    .object({
      action: z.literal("propose"),
      change: z.discriminatedUnion("subject", [
        z
          .object({
            subject: z.literal("human"),
            expectedRevision: commandFields.expectedRevision,
            data: humanProfileDataSchema,
          })
          .strict(),
        z
          .object({
            subject: z.literal("agent"),
            expectedRevision: commandFields.expectedRevision,
            data: agentProfileDataSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]);
