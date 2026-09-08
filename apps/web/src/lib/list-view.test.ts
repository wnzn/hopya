import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./api";
import { listSortLabels, matchesListFilter, normalizeListViewSettings, sortListItems, type ListSortType } from "./list-view";

const item = (id: string, title: string, parentId: string | null = null): Item => ({
  id, title, parentId, workspaceId: "w", nodeId: "l", description: "", status: "todo",
  priority: "none", startDate: null, dueDate: null, tags: [], customFields: {}, assigneeId: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

test("list settings overlay defaults and reject stale or unsafe keys", () => {
  assert.deepEqual(normalizeListViewSettings({
    columnOrder: ["old", "status", "status"],
    hiddenColumns: ["title", "status", "old", "status"],
    sort: { column: "status", direction: "asc" },
    updatedAt: 4,
  }, ["title", "status", "new"], "p"), {
    view: "list", projectId: "p", columnOrder: ["status", "title", "new"],
    hiddenColumns: ["status"], sort: null, updatedAt: null,
  });
});

test("typed sorting handles each label/value contract and keeps missing values last", () => {
  const rows = [item("a", "10"), item("b", "2"), item("c", "")];
  const cases: [ListSortType, unknown[], string[]][] = [
    ["text", ["Zulu", "alpha", null], ["b", "a", "c"]],
    ["number", [10, 2, null], ["b", "a", "c"]],
    ["date", ["2026-02-01", "2025-01-01", null], ["b", "a", "c"]],
    ["checkbox", [true, false, null], ["b", "a", "c"]],
    ["status", [2, 0, null], ["b", "a", "c"]],
  ];
  for (const [type, values, expected] of cases) {
    const byId = new Map(rows.map((row, index) => [row.id, values[index]]));
    assert.deepEqual(sortListItems([...rows], { column: "x", direction: "asc" }, type, row => byId.get(row.id)).map(row => row.id), expected);
  }
  assert.deepEqual(listSortLabels("status"), { asc: "Workflow forward", desc: "Workflow reverse" });
});

test("sorting orders roots and siblings without detaching subtasks", () => {
  const rows = [item("root-b", "Beta"), item("child-z", "Zulu", "root-b"), item("root-a", "Alpha"), item("child-a", "Alpha", "root-b")];
  assert.deepEqual(sortListItems(rows, { column: "title", direction: "asc" }, "text", row => row.title).map(row => row.id),
    ["root-a", "root-b", "child-a", "child-z"]);
});

test("descending sorts keep unset values last", () => {
  const rows = [item("unset", ""), item("low", "2"), item("high", "10")];
  assert.deepEqual(sortListItems(rows, { column: "number", direction: "desc" }, "number", row => row.title || null).map(row => row.id),
    ["high", "low", "unset"]);
});

test("list filters apply typed formulas to scalar, array, missing, number, and date values", () => {
  const filter = (operator: Parameters<typeof matchesListFilter>[1]["operator"], value = "") => ({ id: "f", field: "x", operator, value });
  assert.equal(matchesListFilter(["Alpha", "Beta"], filter("contains", "bet"), "text"), true);
  assert.equal(matchesListFilter(["Alpha", "Beta"], filter("not_contains", "bet"), "text"), false);
  assert.equal(matchesListFilter(null, filter("empty"), "text"), true);
  assert.equal(matchesListFilter(false, filter("is", "false"), "checkbox"), true);
  assert.equal(matchesListFilter(4, filter("gte", "4"), "number"), true);
  assert.equal(matchesListFilter("2026-09-08", filter("lt", "2026-09-09"), "date"), true);
  assert.equal(matchesListFilter("not a number", filter("gt", "2"), "number"), false);
});
