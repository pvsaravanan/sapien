import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent runtime spawns the Claude Code CLI and writes JSON files; keep it server-only.
  serverExternalPackages: ["pdfjs-dist", "@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
