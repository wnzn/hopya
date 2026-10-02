import assert from "node:assert/strict";
import test from "node:test";
import type { TableColumn, TableRecord } from "./api";
import { columnLetter, formatTableNumber, nextTableCell, readTableNumberFormats, tableCellDraft, tableFilterFromDraft, tableRecordValues, tableValueFromDraft, tableValuesEqual } from "./table-resource";

const column = (type: TableColumn["type"], options: string[] = []): TableColumn => ({
  id: "column", workspaceId: "w", tableId: "t", name: "Value", type, options,
  position: 0, createdAt: "1", updatedAt: "1",
});

test("table value helpers parse typed drafts", () => {
  assert.equal(tableValueFromDraft(column("number"), "12.5"), 12.5);
  assert.equal(tableValueFromDraft(column("number"), ""), null);
  assert.equal(tableValueFromDraft(column("checkbox"), "", true), true);
  assert.equal(tableValueFromDraft(column("checkbox"), "", false), false);
  assert.equal(tableValueFromDraft(column("checkbox"), "", null), null);
  assert.equal(tableValuesEqual(column("checkbox"), undefined, false), false);
  assert.equal(tableValueFromDraft(column("select", ["One"]), "One"), "One");
  assert.throws(() => tableValueFromDraft(column("select", ["One"]), "Two"));
  assert.equal(tableCellDraft(column("text"), null), "");
  const precise = "2026-09-18T10:23:45.123Z";
  const preciseDraft = tableCellDraft(column("datetime"), precise);
  assert.equal(tableValueFromDraft(column("datetime"), preciseDraft), precise);
  assert.equal(tableValuesEqual(column("datetime"), "2026-09-18T10:23:45.123+00:00", precise), true);
});

test("table cell updates preserve every sibling value", () => {
  const record: TableRecord = {
    id: "r", workspaceId: "w", tableId: "t", values: { column: "old", sibling: 3, checked: true },
    createdAt: "1", updatedAt: "2",
  };
  assert.deepEqual(tableRecordValues(record, "column", "new"), { column: "new", sibling: 3, checked: true });
  assert.deepEqual(record.values, { column: "old", sibling: 3, checked: true });
});

test("Table filter drafts retain zero and false and reject incomplete typed values", () => {
  assert.deepEqual(tableFilterFromDraft(column("number"), "gte", "0"), { columnId: "column", operator: "gte", value: 0 });
  assert.deepEqual(tableFilterFromDraft(column("checkbox"), "is", "false"), { columnId: "column", operator: "is", value: false });
  assert.deepEqual(tableFilterFromDraft(column("date"), "empty", ""), { columnId: "column", operator: "empty" });
  assert.throws(() => tableFilterFromDraft(column("number"), "is", " "));
  assert.throws(() => tableFilterFromDraft(column("checkbox"), "is", ""));
});

test("number display preserves exact SQL decimals and rounds presentation without changing editing values", () => {
  const exact = "9007199254740993.123456789";
  assert.equal(formatTableNumber(exact, { decimals: null, separators: "comma-dot" }), "9,007,199,254,740,993.123456789");
  assert.equal(formatTableNumber(exact, { decimals: 2, separators: "dot-comma" }), "9.007.199.254.740.993,12");
  assert.equal(tableCellDraft(column("number"), exact), exact);
  assert.equal(formatTableNumber("999.995", { decimals: 2, separators: "space-comma" }), "1 000,00");
  assert.equal(formatTableNumber("-0.005", { decimals: 2, separators: "plain" }), "-0.01");
  assert.equal(formatTableNumber("-0.0001", { decimals: 2, separators: "plain" }), "0.00");
  assert.equal(formatTableNumber(1.25e-7), "0.000000125");
  assert.equal(formatTableNumber(0, { decimals: 2, separators: "decimal-comma" }), "0,00");
  assert.equal(formatTableNumber("1e100000000"), "1e100000000");
});

test("invalid saved number preferences cannot break Table rendering", () => {
  assert.deepEqual(readTableNumberFormats("broken JSON"), {});
  assert.deepEqual(readTableNumberFormats(JSON.stringify({ good: { decimals: 2, separators: "comma-dot" }, invalid: { decimals: 1000000, separators: "plain" }, unknown: { decimals: null, separators: "unexpected" } })), { good: { decimals: 2, separators: "comma-dot" } });
});

test("spreadsheet movement wraps Tab without trapping focus or moving outside loaded rows", () => {
  assert.deepEqual(nextTableCell(0, 2, 2, 3, "Tab"), { row: 1, column: 0 });
  assert.deepEqual(nextTableCell(1, 0, 2, 3, "Tab", true), { row: 0, column: 2 });
  assert.equal(nextTableCell(1, 2, 2, 3, "Tab"), null);
  assert.deepEqual(nextTableCell(1, 2, 2, 3, "ArrowDown"), { row: 1, column: 2 });
  assert.equal(columnLetter(26), "AA");
});
