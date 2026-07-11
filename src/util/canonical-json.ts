function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = normalizeValue(child);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
