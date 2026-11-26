// Repairs for common structured-output wobbles before semantic validation.
// Observed in practice: a model packs a whole array into one stringified
// element (["[\"a\",\"b\"]"]), or sends a number as a string.

/** Recursively repair a parsed structured-output value. */
export function heal(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 1 && typeof value[0] === "string") {
      const inner = tryParse(value[0]);
      if (Array.isArray(inner)) return inner.map(heal);
    }
    return value.map(heal);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    // null means "not applicable" on the wire (see requireAll); drop it.
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = heal(v);
    return out;
  }
  return value;
}

/** For fields the schema declares as arrays/objects: accept a stringified form. */
export function parseIfJsonString(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const inner = tryParse(v.trim());
  return inner !== undefined && typeof inner === "object" ? heal(inner) : v;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Coerce "2" → 2 for index arrays. */
export function toIndexArray(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  return arr.map((x) => (typeof x === "string" ? Number.parseInt(x, 10) : Number(x))).filter((n) => Number.isInteger(n));
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "node"
  );
}
