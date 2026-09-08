import { test, expect } from "@playwright/test";
import type { Detail, Item } from "../src/lib/api";
import { fixture, task } from "./fixture";

const fields: Detail["fields"] = [
  { id: "qty", name: "Qty", type: "number" },
  { id: "price", name: "Price", type: "number" },
  { id: "total", name: "Total", type: "formula" },
];

const item: Item = {
  ...task,
  customFields: { qty: 3, price: 2.5, total: "{{Qty}} * {{Price}}" },
};

test("settings exposes the formula type without options input", async ({
  page,
}) => {
  const { mutations, errors } = await fixture(page, { fields });
  await page.goto("/settings");
  await page.getByLabel("Field name").fill("Total");
  await page
    .getByRole("combobox", { name: "Type", exact: true })
    .selectOption("formula");
  await expect(page.getByLabel("Formula expression")).toHaveValue("=0");
  await expect(page.getByLabel("Options, one per line")).toHaveCount(0);
  await page.getByRole("button", { name: "Create field" }).click();
  const created = mutations.find((m) => m.path.endsWith("/fields"));
  expect(created?.body).toEqual({ name: "Total", type: "formula", settings: { formula: "=0" } });
  expect(errors).toEqual([]);
});

test("formula field stores raw expression, previews live and displays transformed", async ({
  page,
}) => {
  const { mutations, errors } = await fixture(page, { fields, items: [item] });
  await page.goto("/app");
  await page.getByRole("button", { name: item.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog).toBeVisible();
  const total = page.getByRole("textbox", { name: /^Total/ });
  await expect(total).toHaveValue("{{Qty}} * {{Price}}");
  await expect(dialog.getByText("Preview: 7.5")).toBeVisible();
  await total.fill("{{Qty}} + {{Price}}");
  await expect(dialog.getByText("Preview: 5.5")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeVisible();
  const patch = mutations.find((m) => m.method === "PATCH");
  expect(patch?.body.customFields).toEqual({
    qty: 3,
    price: 2.5,
    total: "{{Qty}} + {{Price}}",
  });
  await expect(page.getByRole("textbox", { name: /^Total/ })).toHaveValue(
    "{{Qty}} + {{Price}}",
  );
  await expect(page.getByText("Preview: 5.5")).toBeVisible();
  expect(errors).toEqual([]);
});

test("constructor-looking expressions stay raw without executing code", async ({
  page,
}) => {
  const { errors } = await fixture(page, { fields, items: [item] });
  await page.goto("/app");
  await page.getByRole("button", { name: item.title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await page
    .getByRole("textbox", { name: /^Total/ })
    .fill("{{title}}.constructor('return 1')()");
  await expect(
    dialog.getByText("Preview:", { exact: false }).filter({
      hasText: "{{title}}.constructor('return 1')()",
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
