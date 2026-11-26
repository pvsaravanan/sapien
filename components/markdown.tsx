"use client";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/** Models often write \( \) and \[ \] delimiters; normalize to $ forms for remark-math. */
function normalizeMath(src: string): string {
  return src
    // Over-escaped LaTeX from a model ("\\\\lambda") → "\\lambda", inside $…$ only.
    .replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => m.replace(/\\\\(?=[a-zA-Z{])/g, "\\"))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner) => `\n$$\n${inner.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner) => `$${inner.trim()}$`);
}

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`prose-lesson ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }]]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
}
