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
});
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

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
  const parsed = evaluationSourceSchema.safeParse(value);
  return parsed.success
    ? JSON.stringify([
        parsed.data.plan_execution_id,
        parsed.data.effect_sequence,
      ])
    : null;
}
