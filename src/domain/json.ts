export function jsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    space,
  );
}
