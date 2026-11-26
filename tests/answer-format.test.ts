import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModelAnswer, splitRubric } from "../src/core/answer-format";

const messy =
  "(1) What to see: the city column. (2) Which table: customers, because city and name are both in the customers table and the orders table has no city. (3) Which rows count: only the row where the name is Meena. These answers map to SELECT city / FROM customers / WHERE name = 'Meena', which gives SELECT city FROM customers WHERE name = 'Meena'; and returns Salem. The answer is right if the learner names city as the thing to show, customers as the table, and Meena's row (name is Meena) as the condition. Exact wording doesn't matter, and they don't need to write any SQL.";

test("a dense model answer becomes a list, a code block, and no grading rules", () => {
  const out = formatModelAnswer(messy);
  assert.match(out, /^1\. What to see: the city column\.\n2\. Which table: customers, because/m);
  assert.match(out, /^3\. Which rows count: only the row where the name is Meena\.$/m);
  assert.match(out, /These answers map to `SELECT` city \/ `FROM` customers \/ `WHERE` name = 'Meena', which gives the query below and returns Salem\./);
  assert.match(out, /```sql\nSELECT city FROM customers WHERE name = 'Meena';\n```/);
  assert.doesNotMatch(out, /learner|Exact wording|any SQL/);
});

test("splitRubric moves grading sentences into notes", () => {
  const { answer, notes } = splitRubric(messy);
  assert.match(notes, /^The answer is right if the learner names city.*Exact wording doesn't matter, and they don't need to write any SQL\.$/);
  assert.doesNotMatch(answer, /learner/);
});

test("already-structured Markdown is left alone", () => {
  const md = "1. Pick the column.\n2. Pick the table.\n\n```sql\nSELECT city FROM customers;\n```\n\nResult: **Salem**";
  assert.equal(formatModelAnswer(md), md);
});

test("prose without enumerations or SQL is unchanged", () => {
  const p = "Multiplying by 2 doubles each term, so the sum doubles too.";
  assert.equal(formatModelAnswer(p), p);
});
