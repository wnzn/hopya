import test from "node:test";
import assert from "node:assert/strict";
import { defaultStatuses, projectStatuses, projectDateFormat, statusLabel, statusStyle } from "./project-statuses";
import { formatFieldDate, localDateTime } from "./field-values";
import type { Detail } from "./api";

const data = { nodes: [{ id: "p", kind: "project", parentId: null }, { id: "f", kind: "folder", parentId: "p" }, { id: "l", kind: "list", parentId: "f" }], projectFields: [{ projectId: "p", statuses: [{ id: "shipped", name: "Released", color: "#abcdef", completed: true }], dateFormat: "dd/MM/yyyy" }] } as Detail;
test("list statuses override the owning project while projects, folders and inheriting lists use project defaults", () => {
  assert.equal(projectStatuses(data, "l")[0].id, "shipped");
  assert.equal(projectStatuses(data, "f")[0].id, "shipped");
  const overridden = { ...data, listStatusConfigs: [{ listId: "l", statuses: [{ id: "testing", name: "Testing", color: "#123456", completed: false }], updatedAt: "l1", inheritedProjectUpdatedAt: "p1" }] };
  assert.equal(projectStatuses(overridden, "l")[0].id, "testing");
  assert.equal(projectStatuses(overridden, "f")[0].id, "shipped");
  assert.equal(projectStatuses({ ...overridden, listStatusConfigs: [{ listId: "l", updatedAt: "l2", inheritedProjectUpdatedAt: "p1" }] }, "l")[0].id, "shipped");
  assert.equal(statusLabel(data, "f", "shipped"), "Released");
  assert.equal(statusLabel(data, "l", "removed_status"), "Removed status");
  assert.equal(projectDateFormat(data, "l"), "dd/MM/yyyy");
  assert.deepEqual(projectStatuses(data, "missing"), defaultStatuses);
  assert.deepEqual(projectStatuses({ ...data, projectFields: undefined }, "l"), defaultStatuses);
  assert.equal(projectDateFormat(data, "missing"), "yyyy-MM-dd");
});
test("status colors maintain AA contrast at extremes and the crossover, with a safe invalid fallback", () => {
  for (const color of ["#000000", "#ffffff", "#757575", "#767676", "#ff0000"]) {
    const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const lum = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const contrast = statusStyle(color).color === "#000000" ? (lum + 0.05) / 0.05 : 1.05 / (lum + 0.05);
    assert.ok(contrast >= 4.5);
  }
  assert.equal(statusStyle("url(https://example.test)").backgroundColor, "#64748b");
});
test("date formatting preserves calendar dates and local timestamp editing preserves instants", () => {
  assert.equal(formatFieldDate("2026-09-07", "dd/MM/yyyy"), "07/09/2026");
  assert.equal(formatFieldDate("2026-09-07", "MMM d, yyyy"), "Sep 7, 2026");
  assert.equal(formatFieldDate("2026-09-07", "MMMM d, yyyy"), "September 7, 2026");
  assert.equal(formatFieldDate("0099-01-02"), "0099-01-02");
  assert.equal(formatFieldDate("invalid"), "invalid");
  const iso = "2026-09-07T04:30:12.123Z";
  assert.equal(new Date(localDateTime(iso)).toISOString(), iso);
  assert.equal(localDateTime("invalid"), "");
});
