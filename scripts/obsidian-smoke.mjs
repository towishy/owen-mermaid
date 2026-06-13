import { chromium } from "playwright-core";

const endpoint = process.env.OBSIDIAN_CDP_URL ?? "http://127.0.0.1:9222";
const pluginId = "owen-mermaid";

const browser = await chromium.connectOverCDP(endpoint);
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

  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  await browser.close();
}
