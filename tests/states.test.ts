import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStates, statusOf } from "../src/core/states";

const current =
  "Complete beginner. No SQL, no programming. HELD FIRMLY: (1) Reading a grid as rows and columns where each row is one record. They worked out Priya's total (20+150+5=175) on their own. (2) Following an id from one table to a matching row in another. They traced order 103 to Arun. MISSING: (3) Why data is split into separate linked tables. They answered 'I don't know'. NOT YET ENCOUNTERED (assume missing): what a database is; the terms table/row/column; the idea that SQL describes what you want; basic query shape (SELECT ... FROM ... WHERE).";

const goal =
  "Conceptual understanding, not job-level fluency. At the end it should feel obvious that: (a) a database is a program that stores data as tables; (b) each row has an id (primary key), and other tables point to it (foreign key); (c) SQL states *what* you want, not how to find it; and (d) they can read simple queries.";

test("current state becomes status groups with headlines and evidence", () => {
  const p = parseStates(current);
  assert.equal(p.lead, "Complete beginner. No SQL, no programming.");
  assert.deepEqual(p.sections.map((s) => [s.label, s.status, s.items.length]), [
    ["Already solid", "held", 2],
    ["Missing", "missing", 1],
    ["New to you", "new", 4],
  ]);
  assert.deepEqual(p.sections[0].items[0], {
    text: "Reading a grid as rows and columns where each row is one record.",
    detail: "They worked out Priya's total (20+150+5=175) on their own.",
  });
  assert.equal(p.sections[2].items[3].text, "basic query shape (SELECT ... FROM ... WHERE).");
  assert.equal(p.sections[1].items[0].text, "Why data is split into separate linked tables.");
});

test("goal becomes a lead and a list of lettered points", () => {
  const p = parseStates(goal);
  assert.equal(p.lead, "Conceptual understanding, not job-level fluency.");
  assert.equal(p.items.length, 4);
  assert.equal(p.items[0].text, "a database is a program that stores data as tables");
  assert.equal(p.items[2].text, "SQL states *what* you want, not how to find it");
  assert.equal(p.sections.length, 0);
});

test("status labels are classified in the right order", () => {
  assert.equal(statusOf("NOT YET ENCOUNTERED (assume missing)"), "new");
  assert.equal(statusOf("HALF-HELD"), "partial");
  assert.equal(statusOf("HELD FIRMLY"), "held");
  assert.equal(statusOf("MISCONCEPTIONS"), "missing");
  assert.equal(statusOf("CONTEXT"), "other");
});

test("plain prose stays a single lead", () => {
  const p = parseStates("Knows basic algebra and can solve linear equations.");
  assert.equal(p.lead, "Knows basic algebra and can solve linear equations.");
  assert.deepEqual(p.sections, []);
  assert.deepEqual(p.items, []);
});
