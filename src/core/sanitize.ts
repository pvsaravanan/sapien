// Worker output is model-generated markup. SVGs are displayed through <img>
// (which never runs script), and are also stripped here as defence in depth.
// Demos run in a sandboxed iframe with no same-origin access and a strict CSP.

export function sanitizeSvg(raw: string): string | null {
  const start = raw.indexOf("<svg");
  const end = raw.lastIndexOf("</svg>");
  if (start === -1 || end === -1 || end < start) return null;
  let svg = raw.slice(start, end + "</svg>".length);
  svg = svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    // Only same-document fragment and data:image references survive.
    .replace(/\s(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _x, _q, dq, sq) => {
      const v = (dq ?? sq ?? "").trim();
      return v.startsWith("#") || /^data:image\/(png|jpeg|gif|webp);/i.test(v) ? m : "";
    })
    .replace(/&nbsp;/g, "&#160;");
  if (!/\sxmlns\s*=/.test(svg.slice(0, svg.indexOf(">")))) {
    svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEMO_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Wrap a model-written demo as a self-contained document with a strict CSP.
 *  Network access is blocked; the iframe adds `sandbox="allow-scripts"`. */
export function wrapDemoHtml(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${DEMO_CSP}">`;
  const base =
    "<style>html,body{margin:0;font-family:system-ui,sans-serif;background:#fff;color:#111}</style>";
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${csp}${base}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${csp}${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${base}</head><body>${html}</body></html>`;
}
