import { expect, test, type Page, type Route } from "@playwright/test";
import { detail, fixture, listId, wid } from "./fixture";

type FetchObservation = {
  path: string;
  hasSignal: boolean;
  aborts: number;
  outcome: "pending" | "fulfilled" | "rejected";
  errorName: string;
};
type ObservedWindow = typeof window & { agentFetches: FetchObservation[] };

async function observeAgentFetches(page: Page) {
  await page.addInitScript(() => {
    const observations: FetchObservation[] = [];
    (window as ObservedWindow).agentFetches = observations;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (!/^\/api\/v1\/workspaces\/[^/]+\/agent$/.test(path)) return nativeFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      const observation: FetchObservation = {
        path, hasSignal: !!signal, aborts: 0, outcome: "pending", errorName: "",
      };
      observations.push(observation);
      signal?.addEventListener("abort", () => { observation.aborts++; }, { once: true });
      // Pass the original arguments through: observe, never simulate cancellation.
      try {
        const response = await nativeFetch(input, init);
        observation.outcome = "fulfilled";
        return response;
      } catch (error) {
        observation.outcome = "rejected";
        observation.errorName = error instanceof Error ? error.name : "Unknown";
        throw error;
      }
    };
  });
}

function fetches(page: Page) {
  return page.evaluate(() => (window as ObservedWindow).agentFetches);
}

function observation(workspaceId: string, outcome: FetchObservation["outcome"] = "pending"): FetchObservation {
  return {
    path: `/api/v1/workspaces/${workspaceId}/agent`,
    hasSignal: true,
    aborts: outcome === "rejected" ? 1 : 0,
    outcome,
    errorName: outcome === "rejected" ? "AbortError" : "",
  };
}

async function holdAgent(page: Page, workspaceId = wid) {
  let resolve!: (route: Route) => void;
  const request = new Promise<Route>((done) => { resolve = done; });
  await page.route(`**/api/v1/workspaces/${workspaceId}/agent`, (route) => resolve(route), { times: 1 });
  return { request };
}

const suggestion = {
  reply: "Lifecycle suggestion ready for review.",
  proposal: {
    title: "Lifecycle proposed task",
    description: "Synthetic lifecycle verification only.",
    nodeId: listId,
    priority: "medium",
  },
};

for (const late of ["success", "error"] as const) {
  test(`closing a pending assistant aborts native fetch and excludes late ${late} after reopening`, async ({ page }) => {
    await page.setViewportSize({ width: late === "success" ? 1280 : 390, height: 900 });
    const { mutations, errors } = await fixture(page);
    await observeAgentFetches(page);
    const pending = await holdAgent(page);
    await page.goto("/app");
    const opener = page.getByRole("button", { name: "Assistant", exact: false });
    await opener.click();
    await page.getByLabel("Message the assistant").fill("Check this synthetic workspace");
    await page.getByRole("button", { name: "Send message" }).click();
    const oldRequest = await pending.request;
    await expect(page.getByText("Thinking...", { exact: true })).toBeVisible();
    await expect.poll(() => fetches(page)).toEqual([observation(wid)]);

    if (late === "success") await page.getByRole("button", { name: "Close assistant" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.getByLabel("Message the assistant")).toHaveCount(0);
    await expect.poll(() => fetches(page)).toEqual([observation(wid, "rejected")]);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByLabel("Message the assistant")).toHaveValue("");
    await expect(page.getByRole("log")).toContainText("Turn a thought into a next step.");

    // A new native request must remain independent of the cancelled generation.
    const fresh = await holdAgent(page);
    await page.getByLabel("Message the assistant").fill("Check the reopened workspace");
    await page.getByRole("button", { name: "Send message" }).click();
    const freshRequest = await fresh.request;
    await oldRequest.fulfill(late === "success"
      ? { json: suggestion }
      : { status: 503, json: { error: "Late lifecycle failure" } });
    await expect(page.getByText("Thinking...", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Waiting..." })).toBeDisabled();
    await freshRequest.fulfill({ json: { reply: "Fresh lifecycle reply" } });
    await expect(page.getByRole("log")).toContainText("Fresh lifecycle reply");
    await expect(page.getByRole("log").locator(".chat-message")).toHaveCount(2);
    await expect(page.getByText(suggestion.reply, { exact: true })).toHaveCount(0);
    await expect(page.getByText(suggestion.proposal.title, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review suggestion" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Thinking...", { exact: true })).toHaveCount(0);
    await expect.poll(() => fetches(page)).toEqual([observation(wid, "rejected"), observation(wid, "fulfilled")]);
    expect(mutations.filter((mutation) => mutation.path.endsWith("/items"))).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("switching workspace aborts the old request without leaking its reply or proposal into the new assistant", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { mutations, errors } = await fixture(page);
  await observeAgentFetches(page);
  const other = { id: "77777777-7777-4777-8777-777777777777", name: "Other lifecycle workspace" };
  const otherList = "88888888-8888-4888-8888-888888888888";
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({ json: [detail.workspace, other] }));
  await page.route(`**/api/v1/workspaces/${other.id}`, (route) => route.fulfill({
    json: { ...detail, workspace: other, nodes: [{ id: otherList, name: "Other list", kind: "list", parentId: null }] },
  }));
  await page.route(`**/api/v1/workspaces/${other.id}/items/page*`, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  const old = await holdAgent(page);
  const current = await holdAgent(page, other.id);
  await page.goto("/app");
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByLabel("Message the assistant").fill("Check the first workspace");
  await page.getByRole("button", { name: "Send message" }).click();
  const oldRequest = await old.request;
  await expect.poll(() => fetches(page)).toEqual([observation(wid)]);
  await page.getByRole("combobox", { name: "WORKSPACE", exact: true }).selectOption(other.id);
  await expect(page.locator(".breadcrumb")).toContainText(other.name);
  await expect(page.getByLabel("Message the assistant")).toHaveCount(0);
  await expect.poll(() => fetches(page)).toEqual([observation(wid, "rejected")]);
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await expect(page.getByRole("log")).toContainText("Turn a thought into a next step.");
  await page.getByLabel("Message the assistant").fill("Check the other workspace");
  await page.getByRole("button", { name: "Send message" }).click();
  const currentRequest = await current.request;
  await oldRequest.fulfill({ json: suggestion });
  await expect(page.getByRole("button", { name: "Waiting..." })).toBeDisabled();
  await expect.poll(() => fetches(page)).toEqual([observation(wid, "rejected"), observation(other.id)]);
  await currentRequest.fulfill({ json: {
    reply: "Only the other workspace reply",
    proposal: { ...suggestion.proposal, title: "Other workspace proposed task", nodeId: otherList },
  } });
  await expect(page.getByRole("log")).toContainText("Only the other workspace reply");
  await expect(page.getByRole("log").locator(".chat-message")).toHaveCount(2);
  await expect(page.getByText(suggestion.reply, { exact: true })).toHaveCount(0);
  await expect(page.getByText(suggestion.proposal.title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Review suggestion" }).click();
  const review = page.getByRole("dialog", { name: "Review suggested task" });
  await expect(review.getByLabel("Title", { exact: true })).toHaveValue("Other workspace proposed task");
  await expect(review.getByRole("combobox", { name: "List", exact: true })).toHaveValue(otherList);
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect.poll(() => fetches(page)).toEqual([observation(wid, "rejected"), observation(other.id, "fulfilled")]);
  expect(mutations.filter((mutation) => mutation.path.endsWith("/items"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("desktop/mobile transitions preserve the pending workspace request and nested review still requires explicit confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { mutations, errors } = await fixture(page);
  await observeAgentFetches(page);
  const pending = await holdAgent(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Assistant", exact: false }).click();
  await page.getByLabel("Message the assistant").fill("Suggest a synthetic lifecycle task");
  await page.getByRole("button", { name: "Send message" }).click();
  const request = await pending.request;
  for (const width of [390, 1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByRole(width <= 760 ? "dialog" : "complementary", { name: "Workspace assistant" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Thinking...", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Waiting..." })).toBeDisabled();
    await expect.poll(() => fetches(page)).toEqual([observation(wid)]);
  }
  await request.fulfill({ json: suggestion });
  const panel = page.getByRole("dialog", { name: "Workspace assistant" });
  const reviewButton = panel.getByRole("button", { name: "Review suggestion" });
  await expect(panel.getByRole("log")).toContainText(suggestion.reply);
  await expect.poll(() => fetches(page)).toEqual([observation(wid, "fulfilled")]);
  await reviewButton.click();
  const review = page.getByRole("dialog", { name: "Review suggested task" });
  await expect(review).toBeVisible();
  await expect(review.getByRole("combobox", { name: "List", exact: true })).toHaveValue(listId);
  expect(mutations.filter((mutation) => mutation.path.endsWith("/items"))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(reviewButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(review).toBeVisible();
  await review.getByLabel("Title", { exact: true }).fill("Human-confirmed lifecycle task");
  await review.getByLabel("Title", { exact: true }).press("Enter");
  await expect(review).toBeVisible();
  expect(mutations.filter((mutation) => mutation.path.endsWith("/items"))).toEqual([]);
  await review.getByRole("button", { name: "Confirm and create", exact: true }).click();
  await expect(review).toHaveCount(0);
  const creates = mutations.filter((mutation) => mutation.path.endsWith("/items"));
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    path: `/workspaces/${wid}/items`, method: "POST",
    body: { title: "Human-confirmed lifecycle task", nodeId: listId },
  });
  await page.getByRole("button", { name: "Close assistant" }).click();
  await expect(page.getByRole("button", { name: "Human-confirmed lifecycle task", exact: true })).toBeVisible();
  await expect.poll(() => fetches(page)).toEqual([observation(wid, "fulfilled")]);
  expect(errors).toEqual([]);
});
