import { z } from "zod";

export const evaluationSourceSchema = z.object({
  plan_execution_id: z.string().min(1),
  effect_sequence: z.number().int().nonnegative(),
});
export const evaluationResultSchema = z.object({
  activationId: z.string(),
  validation: z.enum(["pending", "accepted", "rejected"]),
  source: evaluationSourceSchema.optional(),
  consumed: z.boolean().optional(),
  // Application-authored view metadata, never an instruction from a model.
  textPath: z.array(z.string().min(1).max(128)).max(8).optional(),
});
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

/** One readable value for rendering, copying and sharing. Unknown structured
 * results remain data; a field named reply alone never becomes a reply. */
export function evaluationDisplayValue(message: {
  text: string;
  evaluation?: EvaluationResult;
}): unknown {
  let value = evaluationPreview(message.text).value;
  for (const key of message.evaluation?.textPath ?? []) {
    if (!value || typeof value !== "object") return undefined;
    const tagged = (value as { $yao?: { fields?: unknown } }).$yao;
    if (tagged?.fields && typeof tagged.fields === "object")
      value = tagged.fields;
    if (!Object.hasOwn(value as object, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (message.evaluation?.textPath && typeof value !== "string")
    return undefined;
  return value;
}

export function evaluationDisplayText(message: {
  text: string;
  evaluation?: EvaluationResult;
}): string {
  const value = evaluationDisplayValue(message);
  return typeof value === "string"
    ? value
    : value === undefined
      ? ""
      : JSON.stringify(value, null, 2);
}

/** Presentation only. Partial values are NEVER an admitted Yao value. This
 * bounded prefix reader decodes actual JSON string escapes without inventing
 * closing quotes/brackets, guessing business fields, or evaluating source. */
export function evaluationPreview(raw: string): {
  value: unknown;
  partial: boolean;
} {
  const text = raw.slice(0, 262144);
  try {
    return { value: JSON.parse(text), partial: false };
  } catch {
    /* prefix */
  }
  let offset = 0,
    nodes = 0;
  const space = () => {
    while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++;
  };
  function string(): string {
    offset++;
    let value = "";
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') return value;
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escape = text[offset++];
      if (escape === undefined) break;
      if (escape === "u") {
        const digits = text.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) break;
        value += String.fromCharCode(parseInt(digits, 16));
        offset += 4;
      } else {
        const decoded: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (!(escape in decoded)) break;
        value += decoded[escape];
      }
    }
    // A split Unicode surrogate pair is not a complete display character.
    return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
  }
  function read(depth: number): unknown {
    space();
    if (++nodes > 512 || depth > 16 || offset >= text.length) return undefined;
    if (text[offset] === '"') return string();
    if (text[offset] === "{") {
      offset++;
      const value: Record<string, unknown> = Object.create(null);
      while (offset < text.length && nodes < 512) {
        space();
        if (text[offset] !== '"') break;
        const key = string();
        space();
        if (text[offset++] !== ":") break;
        const child = read(depth + 1);
        if (child === undefined) break;
        value[key] = child;
        space();
        if (text[offset++] !== ",") break;
      }
      return value;
    }
    if (text[offset] === "[") {
      offset++;
      const value: unknown[] = [];
      while (offset < text.length && nodes < 512) {
        const child = read(depth + 1);
        if (child === undefined) break;
        value.push(child);
        space();
        if (text[offset++] !== ",") break;
      }
      return value;
    }
    const token = text
      .slice(offset)
      .match(
        /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)/,
      )?.[0];
    if (token) {
      offset += token.length;
      return JSON.parse(token);
    }
    return undefined;
  }
  return { value: read(0), partial: true };
}

export function evaluationSourceKey(value: unknown): string | null {
  // Ordinary messages have no evaluation provenance. Absence is not a failed
  // validation; avoid allocating a Zod error/stack for every row and render.
  // Present values still go through the schema every time, without caching.
  if (value === undefined || value === null) return null;
  const parsed = evaluationSourceSchema.safeParse(value);
  return parsed.success
    ? JSON.stringify([
        parsed.data.plan_execution_id,
        parsed.data.effect_sequence,
      ])
    : null;
}

/** A logical infer can span several scheduler activations (e.g. tool reads).
 * They update one value, not one new chat row per physical activation. */
export function evaluationMessageId(
  activationId: string,
  source: unknown,
  rootId: string | null | undefined,
): string {
  const key = evaluationSourceKey(source);
  return key
    ? `evaluation:${encodeURIComponent(rootId ?? "")}:${encodeURIComponent(key)}`
    : `evaluation:${activationId}`;
}

export function coalesceEvaluationMessages<
  T extends {
    id: string;
    kind: string;
    createdAt: string;
    evaluation?: EvaluationResult;
  },
>(messages: T[]): T[] {
  const result: T[] = [];
  const indexes = new Map<string, number>();
  for (const message of messages) {
    const index =
      message.kind === "evaluation" ? indexes.get(message.id) : undefined;
    if (index === undefined) {
      if (message.kind === "evaluation") indexes.set(message.id, result.length);
      result.push(message);
      continue;
    }
    const previous = result[index]!;
    const rank = (value: T) =>
      value.evaluation?.validation === "accepted"
        ? 2
        : value.evaluation?.validation === "rejected"
          ? 1
          : 0;
    const selected = rank(previous) > rank(message) ? previous : message;
    result[index] = {
      ...selected,
      createdAt:
        previous.createdAt < message.createdAt
          ? previous.createdAt
          : message.createdAt,
    };
  }
  return result;
}
