# sapien

An adaptive, multi-agent AI learning platform. Sapien measures where your understanding ends, searches the shortest dependency path to your goal, teaches it one reasoning step at a time with a check after every step, then makes it usable through practice. Everything you're taught accumulates in a persistent knowledge graph of claims and reasoning chains.

All inference runs through your installed **Claude Code CLI** and its own login (e.g. a Claude subscription). Sapien stores no API keys.

## Quick start

```bash
# Prerequisites: Node 20.9+, Claude Code installed and signed in (`claude --version`)
npm install
npm run dev          # http://localhost:3000
npm test             # offline tests with a fake engine
npm run build && npm start
```

Data lives in `./data` as plain JSON (override with `SAPIEN_DATA_DIR`). The CLI path can be set in Settings or via `SAPIEN_CLAUDE_PATH`.

Live smoke tests (these make real CLI calls): `npx tsx scripts/smoke.ts haiku` and `npx tsx scripts/smoke-workers.ts haiku`.

## Interface

Ink-navy, square-cornered design with a faint dot grid. Fonts: VT323 (pixel display) for headlines and step numbers; Plus Jakarta Sans for everything else; system monospace only for code inside lessons. Periwinkle (`#6b8eff`) marks labels, links and the current step; featured cards get a hard offset shadow.

- **Top nav**: brand, Learn / Practice / Sessions / Knowledge graph links, a background-agents box (running jobs and extractions with stop, plus total CLI-reported cost), and settings.
- **Home** (`/`): hero with a "what do you want to understand?" box (Teach/Practice, model/effort), a "pick up where you left off" card, a four-step "how every lesson works" figure, session cards, and a framed knowledge-graph preview.
- **Knowledge graph** (`/graph`): an Obsidian-style live force graph on a canvas. Nodes are sized by connections and coloured by source; hover lights a node and its neighbours; labels fade in with zoom; drag nodes, scroll to zoom, double-click to fit. A settings panel (top right) has filters, display options and force sliders, saved per browser. Search, Chains/Sources, Import notes, and "Practice from graph" (click nodes, then start practice).
- **Session** (`/session/:id`): pixel title with phase and progress. Question cards carry an "I don't know" row, a 0–100% confidence slider and a "Your thinking" box (↵ submits). A status bar shows tokens, cost and per-session model/effort. A sticky right column holds the boxed lesson-map tree and the start → goal states.

## Providers

Sapien drives a coding-agent CLI you already have installed and signed in to; choose one in **Settings → Provider**. Each uses its own login and billing.

| CLI | Invocation (official headless interface) | Structured replies | Files | Docs |
|---|---|---|---|---|
| Claude Code (default) | `claude -p --input-format stream-json --output-format stream-json --json-schema …` | Enforced | PDFs, images, text | [headless](https://code.claude.com/docs/en/headless) |
| Codex CLI | `codex exec --json -s read-only --output-schema schema.json -o last.txt --ephemeral --skip-git-repo-check -` | Enforced (`--output-schema`) | Images (`-i`), text | [non-interactive](https://developers.openai.com/codex/noninteractive) |
| Gemini CLI | `gemini -p … --output-format stream-json --approval-mode plan` (prompt on stdin) | Prompted + validated | PDFs, images (`@path`), text | [headless](https://geminicli.com/docs/cli/headless) |
| GitHub Copilot CLI (`copilot` or `gh copilot`) | `copilot -p "Read @PROMPT.md …" -s --no-ask-user --deny-tool shell --deny-tool write` | Prompted + validated | PDFs, images (`--attachment`), text | [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) |
| OpenCode | `opencode run --format json --pure -f PROMPT.md -f …` | Prompted + validated | Files (`-f`) | [CLI](https://opencode.ai/docs/cli) |
| Command Code (`cmd`) | `cmd -p --output-format json --max-turns 12` (prompt on stdin; read-only by default) | Prompted + validated | Text; reads files in its folder | [headless](https://commandcode.ai/docs/core-concepts/headless) |

Every run happens in an empty temporary folder that holds only your attachments, with write and shell tools blocked where the CLI allows it. For CLIs without schema enforcement, the JSON Schema is stated in the prompt and the answer is found in the output regardless of event format (the object that best matches the schema), then validated and retried as usual. Models are free-form per role (empty = the CLI's default).

- **Web research for every provider.** Claude Code and Gemini CLI use their own live search. For the others (or if you choose it), Sapien searches itself (Wikipedia with no key, or Brave Search / Tavily with an API key stored in `data/secrets.json`), fetches the pages (public http(s) only, size- and time-limited), and the research agent answers from those excerpts; citations outside the fetched list are sent back for correction. Settings → Research.
- **PDFs everywhere.** CLIs that can't read PDFs (Codex, Command Code) get the PDF's text, extracted on upload with pdf.js and tagged by page. Scanned PDFs without a text layer are flagged.
- **Refusal fallback for every provider.** Claude Code retries opus → sonnet → haiku; other CLIs try their configured fallback models; then an optional fallback provider is tried once.
- **Diagnosable failures.** When a CLI's output can't be used, its raw output is saved to `data/logs/<provider>-last-failure.txt` and the error points to it. Settings → Provider → **Test connection** runs one tiny real request.
- **Node versions handled.** JavaScript CLIs run with a Node that meets their requirement (Command Code and Copilot need 22+, Gemini 20+): Sapien prefers the Node installed alongside the CLI, then the newest suitable one from nvm, Homebrew or Volta, or a path you set.

## Semantic search (knowledge graph)

The graph is searched by meaning with a small local embedding model ([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), 384 dimensions, ~23 MB quantized) running via transformers.js. No API key, no per-search cost, and graph text never leaves your machine.

- The model downloads once into `data/models/` (Node first, then `curl` for networks that intercept TLS) and then runs with remote access off. Settings → Knowledge graph → **Prepare now** does it up front.
- Vectors are stored in `data/graph/embeddings.json`; only new or edited claims are re-embedded, and deleted ones are dropped. Extraction refreshes the index in the background.
- Ranking is hybrid: 80% meaning (cosine similarity) + 20% shared words, so exact terms still count.
- Used for: the graph page's search box (ranked results), the prior knowledge given to agents each turn, and duplicate candidates for the identity auditor (meaning ≥ 0.5 or word matches), so paraphrased duplicates get merged.
- Lesson turns never wait for the model: until it's ready (or if it fails), word matching is used and the model loads in the background. Turn it off in Settings to use word matching only.

## How it works

| Agent | Job | Default model |
| --- | --- | --- |
| **Prober** | Pins down the goal and brackets current understanding with diagnostic questions; ends by writing both knowledge states | opus |
| **Planner** | Searches the minimal dependency DAG from current state to goal (validated acyclic); re-plans on request | opus, high effort |
| **Teacher** | One reasoning step → one graded check (predict or check), tagged with a plan node; repairs misses before moving on; can dispatch workers | opus |
| **Grader** | Grades free-recall answers against the answer the teacher committed *before* asking | sonnet |
| **Practitioner** | Poses one problem at a time with a hidden committed solution; hints by questions; concludes with an outcome and a diagnosis | opus |
| **Extractor → Auditor → merge** | Turns teaching prose and imported notes into propositions and chains; the auditor links duplicates; a deterministic merge combines their sources and drops redundant chains | sonnet |
| **Workers** (background) | Research (CLI web search), Visual (sanitized SVG), Demo (sandboxed HTML/JS) | sonnet |
| **Helper** | Quick side questions; never sees answer keys of open questions | sonnet |
| **Summarizer** | Condenses older history in long sessions | sonnet |
| **Scribe** | Cleans up dictated text (punctuation, misheard terms) without changing what you said | haiku, low effort |

**The app owns the agent loop.** Each agent step is one stateless `claude -p` call: role prompt + rendered transcript on stdin + a JSON Schema for the actions that agent may take (`--json-schema`). Output is repaired (`src/core/heal.ts`), validated with zod plus semantic checks (e.g. `nodeId` must exist in the plan, option indexes in range), and one corrective retry feeds the problems back. On the wire every optional field becomes *required but nullable*, because models skip optional fields they should fill.

The CLI runs in an empty temp dir with no built-in tools (workers get only `WebSearch`/`WebFetch`), no MCP servers, no settings files, no CLAUDE.md, and no saved session.

Flow of a teaching turn (`src/server/orchestrator.ts`):

```
learner input ─▶ validate + save ─▶ prober ──finish──▶ planner ─▶ teacher ─▶ question (stop)
                                     │                     ▲          │
                                     └─ question (stop)    └─replan───┘
recall answer ─▶ grader ─▶ teacher        teacher dispatch ─▶ background job ─▶ result event
complete / threshold ─▶ extractor ─▶ auditor ─▶ merge ─▶ graph
```

- Turns run asynchronously. The HTTP call returns right away and the browser polls while work is in progress. One turn per session runs at a time (409 otherwise).
- Every write is a synchronous read-modify-write, so finishing background jobs never overwrite a running turn.
- Multiple choice is graded on submission. Answer keys and active solutions are redacted from what the browser receives until they're revealed.
- On restart, stale turn locks are released (with Retry) and unfinished jobs resume.

## Files, streaming, background results, long sessions

- **Annotated figures.** When a lesson step is about something in your own files (a diagram, a slide, a chart, a photo of your working), the teacher or practice coach can show it inline: an image, or a PDF page rendered in the browser with pdf.js, cropped to the part that matters, with up to 8 arrows, boxes, circles and labels drawn on top. Coordinates are fractions of the page, validated server-side (marks must sit inside the crop, PDF pages must exist), and a bad placement is sent back to the agent to fix. "Show whole page" and "Open file" sit under each figure. CLIs that only get a PDF's text can show the page but not crop or mark it.
- **Dictation.** Every answer, thinking and message box has a mic button that uses the browser's built-in speech recognition (no key, no setup). Words appear live and are added after what you've typed. In Chrome and Edge the audio is processed by the browser vendor's online speech service; Safari can recognise on-device. Browsers without speech recognition (e.g. Firefox) don't show the button. When you stop, the **scribe** (an AI pass; Haiku at low effort by default, about 5–7 s) rewrites only the dictated part: punctuation, digits and compact math (x^2), fillers and stutters removed, misheard terms fixed using the lesson's topic, map and current question as context. It keeps your claims, hedges and self-corrections, even wrong ones, because the teacher needs them, and it sees the lesson the way the side helper does, so it never sees open answer keys. "Undo clean-up" restores exactly what was heard; edits made while it works are never overwritten. Turn it off in Settings → Teaching.

- **Your files.** Attach PDFs, slide images, notes, or code with the paperclip, or drag them in (home start box, any message, practice attempts). Files are stored under `data/files/` and sent to the model *inside each request* as content blocks: PDFs as documents (figures included), images as images, text inline. Agents never get filesystem tools, so nothing outside your uploads is readable. Limits: PDF 20 MB, image 5 MB, text 1 MB, 20 files per session; about 22 MB of files travel with any one request (newest first). Because files are re-sent with every agent call, large PDFs make each step slower and costlier. Notes import also accepts PDFs and images.
- **Streaming.** The CLI runs in `stream-json` mode, and the answer's `message` field is decoded from the partial JSON as it arrives (`src/core/partial.ts`). The page polls every 0.5 s while an agent is working and shows the text as it's written.
- **Background results wake the agent.** When a research, visual, or demo job finishes, a short *delivery turn* runs. If a question is open, the agent may only add a brief `note` or stay quiet (`none`); your question stays open and editable, and only Submit waits. A result counts as delivered only once an agent was actually shown it.
- **Long sessions.** Once the agent transcript passes `compactionThresholdChars` (default 120,000, about 30k tokens), a summarizer folds older history into a running summary before the next turn; the most recent stretch stays verbatim. The full history is still saved and shown, with a divider where the summary begins.

## Code map

| Path | Contents |
| --- | --- |
| `src/core/` | Pure domain: types, plan DAG validation/layout/status, transcript rendering, graph merge, healing, sanitizers |
| `src/agents/` | Prompts and per-agent schemas and checks |
| `src/server/` | CLI engine and worker gate, agent runtime, orchestrator, extraction pipeline, JSON store, HTTP guard |
| `app/`, `components/` | Next.js pages, API routes, UI |
| `tests/` | Core unit tests and an end-to-end flow test with a scripted engine |

## Security notes

This is a single-user local app, not a multi-user server. Mutating API routes refuse cross-site requests so other websites can't drive your agents. Model-written SVGs are sanitized and shown via `<img>`. Demos run in `sandbox="allow-scripts"` iframes with a CSP that blocks all network access.

## License

MIT. See [LICENSE](LICENSE).
