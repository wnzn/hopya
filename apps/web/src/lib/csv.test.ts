import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "./csv.js";

test("quoted commas, newlines and escaped quotes round-trip", () => {
  const rows = parseCsv('"a,b","c""d","e\nf",plain');
  assert.deepEqual(rows, [["a,b", 'c"d', "e\nf", "plain"]]);
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("CRLF and LF line endings parse to the same rows", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseCsv("a,b\nc,d\n"), parseCsv("a,b\r\nc,d\r\n"));
});

test("serializer quotes only fields containing , \" or newlines", () => {
  assert.equal(
    toCsv([
      ["title", "tags"],
      ["plain", "a;b"],
      ["has, comma", 'say "hi"'],
      ["line\nbreak", "ok"],
    ]),
    'title,tags\nplain,a;b\n"has, comma","say ""hi"""\n"line\nbreak",ok',
  );
});

test("row cap and size guard throw errors", () => {
  const over = Array.from({ length: 2001 }, (_, i) => `row${i}`).join("\n");
  assert.throws(() => parseCsv(over), /2000 row/);
  assert.throws(() => parseCsv("a,".repeat(1024 * 1024)), /1MB/);
});
