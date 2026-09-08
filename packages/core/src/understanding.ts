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
