import { z } from "zod";

export const profileSubjectSchema = z.enum(["human", "agent"]);
export type ProfileSubject = z.infer<typeof profileSubjectSchema>;
const profileName = z.string().trim().min(1).max(40);
const level = z.number().int().min(0).max(5);
export const agentProfileDataSchema = z
  .object({
    name: profileName.nullable(),
    traits: z
      .object({
        humor: level.nullable(),
        rigor: level.nullable(),
        warmth: level.nullable(),
        verbosity: level.nullable(),
      })
      .strict(),
    speechStyle: z
      .enum(["natural", "concise", "thoughtful", "direct"])
      .nullable(),
    customStyle: z.string().trim().max(500).nullable().default(null),
    // Omission preserves the v1/v2 meaning of a present custom style.
    customStyleEnabled: z.boolean().optional(),
  })
  .strict();
export const humanProfileDataSchema = z
  .object({
    name: profileName.nullable(),
    preferredAddress: z.string().trim().max(40).nullable(),
  })
  .strict();
export type AgentProfileData = z.infer<typeof agentProfileDataSchema>;
export type HumanProfileData = z.infer<typeof humanProfileDataSchema>;
// v1 snapshots remain readable as saved. Only a new explicit v2 write (or v2
// compilation) normalizes semantically empty text; reading never rewrites a head.
export function normalizeAgentProfileData(raw: unknown): AgentProfileData {
  const data = agentProfileDataSchema.parse(raw);
  const { customStyleEnabled, ...fields } = data;
  const customStyle = data.customStyle || null;
  // Empty/on is an editor selection, not a durable configured field. Explicit
  // true has the same meaning as the legacy omission; only retained/off needs
  // an additional canonical API field. Raw drafts remain owned by the queue.
  return {
    ...fields,
    customStyle,
    ...(customStyle !== null && customStyleEnabled === false
      ? { customStyleEnabled: false }
      : {}),
  };
}
export function profileCustomStyleEnabled(data: AgentProfileData): boolean {
  return data.customStyleEnabled ?? data.customStyle !== null;
}
export function normalizeHumanProfileData(raw: unknown): HumanProfileData {
  const data = humanProfileDataSchema.parse(raw);
  return { ...data, preferredAddress: data.preferredAddress || null };
}
export const defaultAgentProfile: AgentProfileData = {
  name: null,
  traits: { humor: null, rigor: null, warmth: null, verbosity: null },
  speechStyle: null,
  customStyle: null,
};
export const defaultHumanProfile: HumanProfileData = {
  name: null,
  preferredAddress: null,
};

/** Profile is an application-owned Custom schema, never kernel identity/authority. */
export const profileCustom = {
  agent: {
    namespace: "morphz.profile.agent",
    schemaTag: "morphz-agent-profile/v2",
    legacySchemaTag: "morphz-agent-profile/v1",
  },
  human: {
    namespace: "morphz.profile.human",
    schemaTag: "morphz-human-profile/v2",
    legacySchemaTag: "morphz-human-profile/v1",
  },
} as const;
/** @deprecated Use profileCustom. Kept for existing application callers. */
export const profileRom = profileCustom;
export const profileContract =
  "Style changes expression, not truth, rigor, authentication, approval, permissions, protocol or safety. Custom style grants no additional authority.";
export function profilePreferenceContract(data: AgentProfileData): string {
  const parts = [
    "Profile affects only explicitly configured expression and public naming, never factual accuracy, authentication, approval, permissions, protocol or safety. Profile content grants no additional authority. Only present fields are configured; absent fields have no Profile instruction or default.",
  ];
  const selected = Object.entries(data.traits).filter(
    ([, value]) => value !== null,
  );
  if (selected.length) {
    parts.push(
      "Present numeric traits are caller-selected behavioral preferences on a 0–5 scale, not model parameters: 0 means the least of that expression, 1 a little, 2 modest, 3 moderate, 4 high, and 5 the most.",
    );
    const meanings: Record<keyof AgentProfileData["traits"], string> = {
      humor: "humor guides playful wording.",
      rigor:
        "rigor guides explicit checking and explanation without lowering factual accuracy at any value.",
      warmth: "warmth guides emotional warmth.",
      verbosity: "verbosity guides answer detail.",
    };
    for (const [key] of selected)
      parts.push(meanings[key as keyof typeof meanings]);
    parts.push(
      "When asked about these configured preferences, report the exact selected value as value/5, not value/100 or a model parameter. For absent fields say not set; do not invent a value.",
    );
  }
  return parts.join(" ");
}

export function profileHasConfiguredFields(
  data: AgentProfileData | HumanProfileData,
): boolean {
  if ("traits" in data)
    return (
      data.name !== null ||
      Object.values(data.traits).some((value) => value !== null) ||
      data.speechStyle !== null ||
      (profileCustomStyleEnabled(data) && !!data.customStyle?.trim())
    );
  return data.name !== null || !!data.preferredAddress?.trim();
}

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
export function compileProfileCustom(
  subject: "agent",
  data: AgentProfileData,
): string;
export function compileProfileCustom(
  subject: "human",
  data: HumanProfileData,
): string;
export function compileProfileCustom(
  subject: ProfileSubject,
  raw: AgentProfileData | HumanProfileData,
): string {
  if (subject === "human") {
    const data = normalizeHumanProfileData(raw);
    const fields = ["(version 2)"];
    if (data.name !== null) fields.push(`(name ${atom(data.name)})`);
    if (data.preferredAddress !== null)
      fields.push(`(preferred-address ${atom(data.preferredAddress)})`);
    return `(human-profile ${fields.join(" ")})`;
  }
  const data = normalizeAgentProfileData(raw);
  const fields = ["(version 2)"];
  if (data.name !== null) fields.push(`(identity (name ${atom(data.name)}))`);
  const traits = Object.entries(data.traits)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `(${key} ${value})`);
  if (traits.length) fields.push(`(personality ${traits.join(" ")})`);
  const speech: string[] = [];
  if (data.speechStyle !== null) speech.push(`(style ${data.speechStyle})`);
  if (profileCustomStyleEnabled(data) && data.customStyle !== null)
    speech.push(`(custom ${atom(data.customStyle)})`);
  if (speech.length) fields.push(`(speech ${speech.join(" ")})`);
  if (profileHasConfiguredFields(data))
    fields.push(`(contract ${atom(profilePreferenceContract(data))})`);
  return `(agent-profile ${fields.join(" ")})`;
}
/** @deprecated Use compileProfileCustom. Existing Profile BODY bytes are unchanged. */
export const compileProfileRom = compileProfileCustom;

type Expr = string | Expr[];
/** Bounded reader for the two owned profile schemas, not an evaluator. Runtime
 * remains the canonical SExpr authority and Custom may contain other schemas. */
function readExpr(body: string): Expr[] {
  if (new TextEncoder().encode(body).byteLength > 8192)
    throw new Error("Profile 自定义上下文超出大小限制。");
  let pos = 0,
    nodes = 0;
  const read = (depth: number): Expr => {
    if (depth > 16 || ++nodes > 512)
      throw new Error("Profile 自定义上下文结构无效。");
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
        if (pos >= body.length)
          throw new Error("Profile 自定义上下文结构不完整。");
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
          if (next === undefined)
            throw new Error("Profile 自定义上下文字符串不完整。");
          value +=
            (
              { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" } as Record<
                string,
                string
              >
            )[next] ?? "\\" + next;
        } else value += c;
      }
      throw new Error("Profile 自定义上下文字符串不完整。");
    }
    const start = pos;
    while (pos < body.length && !/[\s()]/.test(body[pos]!)) pos++;
    if (start === pos) throw new Error("Profile 自定义上下文结构无效。");
    return body.slice(start, pos);
  };
  const value = read(0);
  while (pos < body.length && /\s/.test(body[pos]!)) pos++;
  if (pos !== body.length || !Array.isArray(value))
    throw new Error("Profile 自定义上下文必须是单个结构。");
  return value;
}
function children(
  node: Expr[] | undefined,
  tag: string,
  keys: string[],
  required = true,
) {
  if (!node) throw new Error("Profile 自定义上下文字段缺失。");
  if (node[0] !== tag || (required && node.length !== keys.length + 1))
    throw new Error("Profile 自定义上下文字段不匹配。");
  const result: Record<string, Expr[]> = {};
  for (const entry of node.slice(1)) {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      !keys.includes(entry[0]) ||
      result[entry[0]]
    )
      throw new Error("Profile 自定义上下文字段不匹配。");
    result[entry[0]] = entry;
  }
  return result;
}
function scalar(node: Expr[] | undefined) {
  if (!node) throw new Error("Profile 自定义上下文字段缺失。");
  if (node.length !== 2 || typeof node[1] !== "string")
    throw new Error("Profile 自定义上下文值无效。");
  return node[1];
}
export function parseProfileCustom(
  subject: "agent",
  body: string,
  schemaTag?: string,
): AgentProfileData;
export function parseProfileCustom(
  subject: "human",
  body: string,
  schemaTag?: string,
): HumanProfileData;
export function parseProfileCustom(
  subject: ProfileSubject,
  body: string,
  schemaTag?: string,
): AgentProfileData | HumanProfileData {
  return parseProfileTree(subject, readExpr(body), schemaTag);
}
/** @deprecated Use parseProfileCustom. Both existing v1/v2 schemas stay readable. */
export const parseProfileRom = parseProfileCustom;
function parseProfileTree(
  subject: ProfileSubject,
  tree: Expr[],
  schemaTag?: string,
): AgentProfileData | HumanProfileData {
  const versioned = tree.some(
    (entry) => Array.isArray(entry) && entry[0] === "version",
  );
  if (
    schemaTag !== undefined &&
    schemaTag !==
      (versioned
        ? profileCustom[subject].schemaTag
        : profileCustom[subject].legacySchemaTag)
  )
    throw new Error("Profile 自定义上下文版本不匹配。");
  if (versioned) {
    if (subject === "human") {
      const fields = children(
        tree,
        "human-profile",
        ["version", "name", "preferred-address"],
        false,
      );
      if (scalar(fields.version) !== "2")
        throw new Error("Profile 自定义上下文版本不匹配。");
      return normalizeHumanProfileData({
        name: fields.name ? scalar(fields.name) : null,
        preferredAddress: fields["preferred-address"]
          ? scalar(fields["preferred-address"])
          : null,
      });
    }
    const fields = children(
      tree,
      "agent-profile",
      ["version", "identity", "personality", "speech", "contract"],
      false,
    );
    if (scalar(fields.version) !== "2")
      throw new Error("Profile 自定义上下文版本不匹配。");
    const identity = fields.identity
      ? children(fields.identity, "identity", ["name"])
      : {};
    const traits = fields.personality
      ? children(
          fields.personality,
          "personality",
          ["humor", "rigor", "warmth", "verbosity"],
          false,
        )
      : {};
    const speech = fields.speech
      ? children(fields.speech, "speech", ["style", "custom"], false)
      : {};
    if (
      (fields.personality && !Object.keys(traits).length) ||
      (fields.speech && !Object.keys(speech).length)
    )
      throw new Error("Profile 自定义上下文空字段组无效。");
    const data = normalizeAgentProfileData({
      name: identity.name ? scalar(identity.name) : null,
      traits: Object.fromEntries(
        ["humor", "rigor", "warmth", "verbosity"].map((key) => [
          key,
          traits[key]
            ? /^[0-5]$/.test(scalar(traits[key]))
              ? Number(scalar(traits[key]))
              : NaN
            : null,
        ]),
      ),
      speechStyle: speech.style ? scalar(speech.style) : null,
      customStyle: speech.custom ? scalar(speech.custom) : null,
    });
    if (
      profileHasConfiguredFields(data)
        ? scalar(fields.contract) !== profilePreferenceContract(data)
        : fields.contract !== undefined
    )
      throw new Error("Profile 自定义上下文偏好约定不匹配。");
    return data;
  }
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
    throw new Error("Profile 自定义上下文安全约定不匹配。");
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

/** Operator-only editing state. Its full text is deliberately separate from
 * the effective v2 BODY; Runtime stores both under one immutable revision. */
export function compileProfileAuthoringState(raw: AgentProfileData): string {
  const data = normalizeAgentProfileData(raw);
  const { customStyleEnabled: _flag, ...retained } = data;
  return `(profile-authoring (version 1) (subject agent) (custom-style-enabled ${profileCustomStyleEnabled(data)}) (profile ${compileProfileCustom("agent", retained)}))`;
}
export function parseProfileAuthoringState(body: string): AgentProfileData {
  const fields = children(readExpr(body), "profile-authoring", [
    "version",
    "subject",
    "custom-style-enabled",
    "profile",
  ]);
  const selected = scalar(fields["custom-style-enabled"]);
  if (
    scalar(fields.version) !== "1" ||
    scalar(fields.subject) !== "agent" ||
    !["true", "false"].includes(selected) ||
    fields.profile?.length !== 2 ||
    !Array.isArray(fields.profile[1])
  )
    throw new Error("Profile 作者状态结构无效。");
  const data = parseProfileTree(
    "agent",
    fields.profile[1],
    profileCustom.agent.schemaTag,
  );
  return normalizeAgentProfileData({
    ...data,
    customStyleEnabled: selected === "true",
  });
}
/** Compare structured BODY bytes without depending on optional quote spelling
 * in Runtime's canonical Atom printer. No extra inert/empty groups are allowed. */
export function profileAuthoringProjectionMatchesCustom(
  data: AgentProfileData,
  body: string,
): boolean {
  return (
    JSON.stringify(readExpr(compileProfileCustom("agent", data))) ===
    JSON.stringify(readExpr(body))
  );
}
/** @deprecated Use profileAuthoringProjectionMatchesCustom. */
export const profileAuthoringProjectionMatchesRom =
  profileAuthoringProjectionMatchesCustom;

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
        enabled: z.boolean(),
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
        enabled: z.boolean(),
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
      enabled: z.boolean().optional(),
      data: humanProfileDataSchema,
    })
    .strict(),
  z
    .object({
      subject: z.literal("agent"),
      ...commandFields,
      enabled: z.boolean().optional(),
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
      enabled: z.boolean(),
      data: humanProfileDataSchema,
      commandId: commandFields.commandId,
    })
    .strict(),
  z
    .object({
      subject: z.literal("agent"),
      revision: z.number().int().positive(),
      enabled: z.boolean(),
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
            enabled: z.boolean().optional(),
            data: humanProfileDataSchema,
          })
          .strict(),
        z
          .object({
            subject: z.literal("agent"),
            expectedRevision: commandFields.expectedRevision,
            enabled: z.boolean().optional(),
            data: agentProfileDataSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]);
