import { chromium } from "playwright-core";

const endpoint = process.env.OBSIDIAN_CDP_URL ?? "http://127.0.0.1:9222";
const pluginId = "owen-mermaid";
const skipUi = process.env.OWEN_MERMAID_SMOKE_SKIP_UI === "1";

const browser = await chromium.connectOverCDP(endpoint);
let smokePath;
try {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith("app://obsidian.md")) ?? pages[0];
  if (!page) throw new Error("No Obsidian page was found over CDP.");

  await page.waitForLoadState("domcontentloaded");
  const result = await page.evaluate((id) => {
    const app = window.app;
    const plugin = app?.plugins?.plugins?.[id];
    const enabled = Boolean(plugin);
    const commandIds = Object.keys(app?.commands?.commands ?? {}).filter((commandId) => commandId.startsWith(`${id}:`));
    return { enabled, commandIds };
  }, pluginId);

  if (!result.enabled) throw new Error(`Plugin ${pluginId} is not enabled in Obsidian.`);
  for (const commandId of [`${pluginId}:scan-mermaid-diagrams`, `${pluginId}:export-active-note-mermaid-diagrams`]) {
    if (!result.commandIds.includes(commandId)) throw new Error(`Missing command: ${commandId}`);
  }

  let ui = { checked: false };
  if (!skipUi) {
    smokePath = await page.evaluate(async () => {
      const app = window.app;
      if (!app?.vault || !app?.workspace) throw new Error("Obsidian app APIs are not available.");
      const path = `Owen Mermaid Smoke ${Date.now()}.md`;
      const source = [
        "# Owen Mermaid Smoke",
        "",
        "```mermaid",
        "flowchart LR",
        "  A[Smoke Start] --> B{Smoke Done}",
        "```",
        "",
      ].join("\n");
      const file = await app.vault.create(path, source);
      const leaf = app.workspace.getLeaf(true);
      await leaf.openFile(file, { active: true });
      await leaf.setViewState({ type: "markdown", state: { file: path, mode: "preview" }, active: true });
      return path;
    });

    await page.waitForSelector(".markdown-preview-view .mermaid svg, .markdown-preview-view .block-language-mermaid svg", { timeout: 15000 });
    await page.waitForSelector(".owen-mermaid-block .owen-mermaid-inline-toolbar", { state: "attached", timeout: 10000 });
    ui = await page.evaluate(() => {
      const toolbar = document.querySelector(".owen-mermaid-block .owen-mermaid-inline-toolbar");
      const buttons = Array.from(toolbar?.querySelectorAll("button") ?? []).map((button) => ({
        action: button.dataset.action ?? "",
        label: button.getAttribute("aria-label") ?? "",
        title: button.getAttribute("title") ?? "",
      }));
      const editButton = toolbar?.querySelector("button[data-action='edit']");
      if (!editButton) throw new Error("Edit toolbar button was not found.");
      editButton.click();
      return { checked: true, buttons };
    });
    await page.waitForSelector(".owen-mermaid-editor-modal .owen-mermaid-canvas", { timeout: 10000 });
    await page.waitForSelector(".owen-mermaid-editor-modal .owen-mermaid-code-preview", { timeout: 10000 });
    await page.locator(".owen-mermaid-editor-actions button").last().click({ force: true });
    await page.waitForSelector(".owen-mermaid-editor-modal", { state: "detached", timeout: 10000 });
  }

  console.log(JSON.stringify({ ok: true, ...result, ui }, null, 2));
} finally {
  if (smokePath) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if (!page.url().startsWith("app://obsidian.md")) continue;
      try {
        await page.evaluate(async (path) => {
          const app = window.app;
          const file = app?.vault?.getAbstractFileByPath?.(path);
          if (file) await app.vault.delete(file, true);
        }, smokePath);
      } catch {
        // Best-effort cleanup. Keep the original smoke-test failure if there was one.
      }
      break;
    }
  }
  await browser.close();
}
