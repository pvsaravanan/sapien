import assert from "node:assert/strict";
import { test } from "node:test";
import { figureProblems, figureText, toFigure, type FileView } from "../src/core/figure";

const files: FileView[] = [
  { id: "a".repeat(16), name: "notes.md", kind: "text", sent: true },
  { id: "b".repeat(16), name: "slides.pdf", kind: "pdf", pages: 12, sent: true },
  { id: "c".repeat(16), name: "working.jpg", kind: "image", sent: true },
  { id: "d".repeat(16), name: "big.pdf", kind: "pdf", pages: 3, sent: false },
];

test("a well-formed figure on a PDF page passes and resolves the file id", () => {
  const draft = {
    file: 2,
    page: 4,
    crop: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 },
    marks: [
      { kind: "arrow" as const, x: 0.15, y: 0.25, x2: 0.4, y2: 0.45, text: "the gradient" },
      { kind: "box" as const, x: 0.5, y: 0.3, w: 0.15, h: 0.1 },
      { kind: "label" as const, x: 0.3, y: 0.6, text: "minimum" },
    ],
    caption: "Where the step size matters.",
  };
  assert.deepEqual(figureProblems(draft, files), []);
  const fig = toFigure(draft, files);
  assert.equal(fig.fileId, "b".repeat(16));
  assert.equal(fig.page, 4);
  assert.equal(fig.marks.length, 3);
  assert.match(figureText(fig, "slides.pdf"), /slides\.pdf, page 4 \(cropped\) with marks: arrow "the gradient", box, label "minimum"/);
});

test("figure checks catch the mistakes agents make", () => {
  const p = (d: Parameters<typeof figureProblems>[0]) => figureProblems(d, files).join(" | ");
  assert.match(p({ file: 9 }), /no file 9/);
  assert.match(p({ file: 1 }), /text file/);
  assert.match(p({ file: 4, page: 1 }), /not included/);
  assert.match(p({ file: 2 }), /page .* required/);
  assert.match(p({ file: 2, page: 13 }), /out of range/);
  assert.match(p({ file: 3, marks: [{ kind: "arrow", x: 0.2, y: 0.2 }] }), /needs x2,y2/);
  assert.match(p({ file: 3, marks: [{ kind: "label", x: 0.2, y: 0.2 }] }), /needs text/);
  assert.match(p({ file: 3, marks: [{ kind: "box", x: 0.2, y: 0.2, w: 0, h: 0.1 }] }), /needs w and h/);
  assert.match(p({ file: 3, marks: [{ kind: "label", x: 120, y: 0.2, text: "px" }] }), /fractions/);
  assert.match(p({ file: 3, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, marks: [{ kind: "label", x: 0.9, y: 0.9, text: "far" }] }), /outside figure.crop/);
  assert.match(p({ file: 3, crop: { x: 0.6, y: 0, w: 0.6, h: 0.5 } }), /past the page/);
});

test("PDFs sent as text can be shown whole but not cropped or marked", () => {
  const textOnly = files.map((f) => (f.kind === "pdf" ? { ...f, textOnly: true } : f));
  assert.deepEqual(figureProblems({ file: 2, page: 1 }, textOnly), []);
  assert.match(figureProblems({ file: 2, page: 1, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, textOnly).join(), /layout/);
});

test("toFigure clamps values and drops fields that don't apply", () => {
  const fig = toFigure({ file: 3, page: 2, crop: { x: 0.5, y: -0.01, w: 0.52, h: 1 }, marks: [{ kind: "label", x: 1.01, y: 0.5, text: " hi ", w: 0.3 }] }, files);
  assert.equal(fig.page, undefined);
  assert.deepEqual(fig.crop, { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(fig.marks[0], { kind: "label", x: 1, y: 0.5, text: "hi" });
});
