import { z } from "zod";

/** A published source names a catalog original and the App's exact version.
 * It is a navigation reference, not a copy of the original or a file grant.
 */
export const understandingSourceSchema = z
  .object({
    contentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    versionRef: z.string().min(1).max(200),
  })
  .strict();
export const understandingSourcesSchema = z
  .array(understandingSourceSchema)
  .max(100);
export type UnderstandingSource = z.infer<typeof understandingSourceSchema>;

/** Decode only the explicit public-summary marker, never arbitrary frame bodies.
 * Runtime's SExpr Display preserves literal newlines/tabs in a quoted atom.
 */
export function publicSummary(body: string): string {
  const match = /^\(public-summary ("(?:[^"\\]|\\.)*")\)$/s.exec(body);
  if (!match || body.length > 30000) throw new Error("Invalid public summary");
  const decoded: unknown = JSON.parse(
    match[1]!.replace(
      /[\n\r\t]/g,
      (c) =>
        ({
          "\n": "\\n",
          "\r": "\\r",
          "\t": "\\t",
        })[c]!,
    ),
  );
  if (typeof decoded !== "string" || !decoded.trim())
    throw new Error("Empty public summary");
  return decoded;
}
