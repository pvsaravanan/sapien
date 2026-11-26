import type { ProviderId } from "./types";

/** What each supported CLI offers through its documented headless interface. */
export const PROVIDERS: Record<
  ProviderId,
  {
    name: string;
    docs: string;
    defaultPath: string;
    schema: "native" | "prompted";
    files: string;
    web: string;
    effort: boolean;
    /** How PDFs reach the model: natively, or as text Sapien extracts first. */
    pdf: "native" | "text";
    /** The CLI has its own live web search Sapien can use for research. */
    webSearch: boolean;
  }
> = {
  claude: { name: "Claude Code", docs: "https://code.claude.com/docs/en/headless", defaultPath: "claude", schema: "native", files: "PDFs, images, text", web: "Built-in search", pdf: "native", webSearch: true, effort: true },
  codex: { name: "Codex CLI", docs: "https://developers.openai.com/codex/noninteractive", defaultPath: "codex", schema: "native", files: "Images, text, PDFs (as extracted text)", web: "Sapien search", pdf: "text", webSearch: false, effort: true },
  gemini: { name: "Gemini CLI", docs: "https://geminicli.com/docs/cli/headless", defaultPath: "gemini", schema: "prompted", files: "PDFs, images, text", web: "Built-in search", pdf: "native", webSearch: true, effort: false },
  copilot: { name: "GitHub Copilot CLI", docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference", defaultPath: "copilot", schema: "prompted", files: "PDFs, images, text", web: "Sapien search", pdf: "native", webSearch: false, effort: true },
  opencode: { name: "OpenCode", docs: "https://opencode.ai/docs/cli", defaultPath: "opencode", schema: "prompted", files: "PDFs, images, text", web: "Sapien search", pdf: "native", webSearch: false, effort: true },
  commandcode: { name: "Command Code", docs: "https://commandcode.ai/docs/core-concepts/headless", defaultPath: "cmd", schema: "prompted", files: "Text, PDFs (as extracted text)", web: "Sapien search", pdf: "text", webSearch: false, effort: true },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
