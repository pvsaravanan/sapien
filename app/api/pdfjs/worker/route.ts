import fs from "node:fs";
import path from "node:path";

/** pdf.js worker for rendering PDF pages in the browser (annotated figures). Served
 *  from the installed package so its version always matches the bundled pdf.js. */
export async function GET() {
  try {
    const file = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
    return new Response(fs.readFileSync(file), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
    });
  } catch {
    return new Response("pdf.js worker not found", { status: 404 });
  }
}
