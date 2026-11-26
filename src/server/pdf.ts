/** Server-side PDF text extraction (pdf.js, no native dependencies). Used for CLIs that
 *  cannot read PDFs themselves. Scanned, image-only pages yield no text. */
export async function extractPdfText(buf: Buffer, maxChars = 400_000): Promise<{ text: string; pages: number; emptyPages: number }> {
  const { getDocument } = await quietly(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
  const doc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  let emptyPages = 0;
  let total = 0;
  try {
    for (let i = 1; i <= doc.numPages && total < maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        line += item.str ?? "";
        if (item.hasEOL) (lines.push(line), (line = ""));
      }
      if (line) lines.push(line);
      const text = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
      if (!text) emptyPages++;
      const chunk = `[page ${i}]\n${text || "(no extractable text on this page; it may be a scan or figure)"}`;
      parts.push(chunk);
      total += chunk.length;
      page.cleanup();
    }
    return { text: parts.join("\n\n").slice(0, maxChars), pages: doc.numPages, emptyPages };
  } finally {
    await doc.destroy();
  }
}

/** pdf.js warns at load time about canvas polyfills it only needs for rendering, which
 *  Sapien never does; keep those out of the server log. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const log = console.log;
  const filter = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
    if (typeof a[0] === "string" && /Cannot (polyfill|access the `require`)/.test(a[0])) return;
    orig(...a);
  };
  console.warn = filter(warn);
  console.log = filter(log);
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}
