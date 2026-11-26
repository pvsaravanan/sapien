/** Decode the (possibly unfinished) string value of a top-level `key` from streaming
 *  JSON. Returns null until the value has started. Stops cleanly at an incomplete
 *  escape sequence instead of emitting garbage. */
export function partialStringField(json: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < json.length) {
    const c = json[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) return out;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    if (n in simple) {
      out += simple[n];
      i += 2;
      continue;
    }
    if (n === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    i += 2; // unknown escape: skip
  }
  return out;
}
