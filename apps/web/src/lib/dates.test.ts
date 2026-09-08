import { test } from "node:test";
import assert from "node:assert/strict";
import {
  barRange,
  dateKey,
  dayDistance,
  monthDays,
  monthStart,
  parseDate,
  parseMonth,
} from "./dates.js";
test("calendar is Monday-first and covers leap day and adjacent months", () => {
  const days = monthDays(parseDate("2024-02-01"));
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  assert.equal(dateKey(days[0]), "2024-01-29");
  assert.ok(days.some((d) => dateKey(d) === "2024-02-29"));
});
test("day distance is calendar based across daylight savings", () => {
  assert.equal(
    dayDistance(parseDate("2026-03-07"), parseDate("2026-03-10")),
    3,
  );
});
test("gantt clips inclusive ranges and supports one-date milestones", () => {
  const start = parseDate("2026-09-01");
  assert.deepEqual(barRange("2026-08-30", "2026-09-03", start, 30), {
    offset: 0,
    span: 3,
  });
  assert.deepEqual(barRange(null, "2026-09-10", start, 30), {
    offset: 9,
    span: 1,
  });
  assert.deepEqual(barRange("2026-09-29", "2026-10-03", start, 30), {
    offset: 28,
    span: 2,
  });
  assert.equal(barRange(null, null, start, 30), null);
  assert.equal(barRange("2026-09-05", "2026-09-01", start, 30), null);
  assert.equal(barRange("2026-10-01", null, start, 30), null);
});
test("month jumps accept only the API's four-digit year and valid month", () => {
  for (const value of ["0000-01", "0001-02", "0099-12", "2024-02", "9999-12"]) {
    assert.equal(dateKey(parseMonth(value)!), `${value}-01`);
  }
  for (const value of [
    "",
    "2026-00",
    "2026-13",
    "26-09",
    "2026-9",
    "10000-01",
    "2026-09-01",
    "2026-09junk",
    " 2026-09",
    "-001-09",
  ]) {
    assert.equal(parseMonth(value), null);
  }
});
test("month starts and navigation preserve years 0 through 99 without constructor offsets", () => {
  for (const year of ["0000", "0001", "0099", "0100", "9999"]) {
    assert.equal(
      dateKey(monthStart(parseDate(`${year}-02-28`))),
      `${year}-02-01`,
    );
    assert.equal(
      dateKey(monthStart(parseDate(`${year}-01-31`), 1)),
      `${year}-02-01`,
    );
    assert.equal(monthDays(parseDate(`${year}-02-01`)).length, 42);
  }
  assert.equal(dateKey(monthStart(parseDate("0099-12-31"), 1)), "0100-01-01");
  assert.equal(dateKey(monthStart(parseDate("0100-01-31"), -1)), "0099-12-01");
  assert.ok(
    monthDays(parseDate("0000-02-01")).some(
      (day) => dateKey(day) === "0000-02-29",
    ),
  );
});
test("calendar distances and ranges cross year 99 and include year zero leap day", () => {
  assert.equal(
    dayDistance(parseDate("0099-12-31"), parseDate("0100-01-01")),
    1,
  );
  assert.equal(
    dayDistance(parseDate("0000-02-28"), parseDate("0000-03-01")),
    2,
  );
  assert.deepEqual(
    barRange("0099-12-31", "0100-01-03", parseDate("0100-01-01"), 31),
    { offset: 0, span: 3 },
  );
  assert.deepEqual(
    barRange("0000-02-28", "0000-03-01", parseDate("0000-02-01"), 29),
    { offset: 27, span: 2 },
  );
});
