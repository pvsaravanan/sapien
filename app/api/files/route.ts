import { handle } from "@/src/server/http";
import { ensurePdfText, FileError, saveFile } from "@/src/server/files";
import { InputError } from "@/src/server/orchestrator";

/** Upload one or more learner files (multipart field "file"). */
export async function POST(req: Request) {
  return handle(req, async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new InputError("Expected a multipart upload.");
    }
    const entries = form.getAll("file").filter((f): f is File => typeof f !== "string");
    if (!entries.length) throw new InputError("No file received.");
    if (entries.length > 10) throw new InputError("Upload at most 10 files at a time.");
    try {
      const files = [];
      for (const f of entries) {
        const meta = saveFile(f.name, Buffer.from(await f.arrayBuffer()));
        // Cache extracted text for CLIs that cannot read PDFs natively.
        if (meta.kind === "pdf") await ensurePdfText(meta.id);
        files.push(meta);
      }
      return { files };
    } catch (err) {
      if (err instanceof FileError) throw new InputError(err.message);
      throw err;
    }
  });
}
