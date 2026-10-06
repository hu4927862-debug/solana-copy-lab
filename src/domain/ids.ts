import { createHash } from "node:crypto";

export function stableId(
  namespace: string,
  ...parts: readonly (string | number | bigint)[]
): string {
  const payload = parts.map(String).join("\u001f");
  return `${namespace}_${createHash("sha256").update(payload).digest("hex")}`;
}
