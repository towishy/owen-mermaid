import { chromium } from "playwright-core";

const endpoint = process.env.OBSIDIAN_CDP_URL ?? "http://127.0.0.1:9222";
const pluginId = "owen-mermaid";
const skipUi = process.env.OWEN_MERMAID_SMOKE_SKIP_UI === "1";
const screenshotPath = process.env.OWEN_MERMAID_SMOKE_SCREENSHOT;

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
    if (await page.locator(".owen-mermaid-editor-modal").count()) throw new Error("Close the open Owen Mermaid editor before running the UI smoke test.");
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
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      await leaf.setViewState({ type: "markdown", state: { file: path, mode: "preview" }, active: true });
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await app.workspace.revealLeaf(leaf);
      leaf.view.containerEl.dataset.owenMermaidSmoke = "true";
      return path;
    });

    const smokeLeaf = page.locator("[data-owen-mermaid-smoke='true']");
    await smokeLeaf.locator(".markdown-preview-view:visible .mermaid svg, .markdown-preview-view:visible .block-language-mermaid svg").first().waitFor({ state: "visible", timeout: 15000 });
    await smokeLeaf.locator(".markdown-preview-view:visible .owen-mermaid-block .owen-mermaid-inline-toolbar").first().waitFor({ state: "attached", timeout: 10000 });
    const visibleBlock = smokeLeaf.locator(".markdown-preview-view:visible .owen-mermaid-block:visible").first();
    const inlineToolbar = visibleBlock.locator(".owen-mermaid-inline-toolbar");
    const inlineSvg = visibleBlock.locator("svg:not(.owen-mermaid-liquid-glass-filter-svg)").first();
    const toolbarBeforeHover = await inlineToolbar.evaluate((toolbar) => {
      const style = getComputedStyle(toolbar);
      return { opacity: style.opacity, pointerEvents: style.pointerEvents };
    });
    await inlineSvg.hover();
    await page.waitForTimeout(180);
    const toolbarAfterHover = await inlineToolbar.evaluate((toolbar) => {
      const style = getComputedStyle(toolbar);
      const block = toolbar.closest(".owen-mermaid-block");
      const svg = block?.querySelector("svg:not(.owen-mermaid-liquid-glass-filter-svg)");
      const toolbarRect = toolbar.getBoundingClientRect();
      const blockRect = block?.getBoundingClientRect();
      const svgRect = svg?.getBoundingClientRect();
      return {
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        toolbarCenterX: Math.round(toolbarRect.left + toolbarRect.width / 2),
        blockSize: blockRect ? { width: Math.round(blockRect.width), height: Math.round(blockRect.height) } : null,
        svgSize: svgRect ? { width: Math.round(svgRect.width), height: Math.round(svgRect.height) } : null,
        svgCenterX: svgRect ? Math.round(svgRect.left + svgRect.width / 2) : null,
      };
    });
    if (Number(toolbarAfterHover.opacity) < 0.9 || toolbarAfterHover.pointerEvents !== "auto") throw new Error("Inline toolbar did not become interactive on Mermaid hover.");
    if (toolbarAfterHover.svgCenterX === null || Math.abs(toolbarAfterHover.toolbarCenterX - toolbarAfterHover.svgCenterX) > 8) throw new Error("Inline toolbar is not aligned with the visible Mermaid diagram.");

    ui = await visibleBlock.evaluate((block) => {
      const toolbar = block.querySelector(".owen-mermaid-inline-toolbar");
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
    ui = { ...ui, inlineToolbar: { beforeHover: toolbarBeforeHover, afterHover: toolbarAfterHover } };
    await page.waitForSelector(".owen-mermaid-editor-modal .owen-mermaid-canvas", { timeout: 10000 });
    await page.waitForSelector(".owen-mermaid-editor-modal [role='tablist']", { timeout: 10000 });
    const editorContract = await page.evaluate(() => {
      const modal = document.querySelector(".owen-mermaid-editor-modal");
      const zoomLabel = modal?.querySelector(".owen-mermaid-ribbon-zoom-label");
      return {
        minimapCount: modal?.querySelectorAll(".owen-mermaid-minimap").length ?? -1,
        zoomLabel: zoomLabel?.textContent?.trim() ?? "",
        zoomInRibbon: Boolean(zoomLabel?.closest(".owen-mermaid-editor-ribbon")),
      };
    });
    if (editorContract.minimapCount !== 0) throw new Error("The editor minimap should not be rendered.");
    if (!editorContract.zoomLabel || !editorContract.zoomInRibbon) throw new Error("Ribbon zoom controls were not found.");

    const panResult = await page.evaluate(() => {
      const stage = document.querySelector(".owen-mermaid-editor-stage");
      const canvas = document.querySelector(".owen-mermaid-editor-stage .owen-mermaid-canvas");
      if (!(stage instanceof HTMLElement) || !(canvas instanceof SVGSVGElement)) throw new Error("Editor stage or canvas was not found.");
      const scrollBefore = { left: stage.scrollLeft, top: stage.scrollTop };
      const rect = canvas.getBoundingClientRect();
      const startX = rect.left + Math.min(rect.width - 48, stage.clientWidth - 48);
      const startY = rect.top + Math.min(rect.height - 48, stage.clientHeight - 48);
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: startX, clientY: startY, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, clientX: startX - 120, clientY: startY - 90, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: startX - 120, clientY: startY - 90, pointerId: 1 }));
      return {
        scrollBefore,
        scrollAfter: { left: stage.scrollLeft, top: stage.scrollTop },
        scrollRange: { left: stage.scrollWidth - stage.clientWidth, top: stage.scrollHeight - stage.clientHeight },
      };
    });
    const { scrollBefore, scrollAfter } = panResult;
    if (scrollAfter.left <= scrollBefore.left && scrollAfter.top <= scrollBefore.top) throw new Error("Canvas drag did not pan the editor stage.");
    if (screenshotPath) await page.locator(".owen-mermaid-editor-modal").screenshot({ path: screenshotPath });

    await page.locator(".owen-mermaid-editor-modal [data-inspector-tab-value='source']").click();
    await page.waitForSelector(".owen-mermaid-editor-modal .owen-mermaid-code-preview", { timeout: 10000 });
    await page.locator(".owen-mermaid-editor-actions button").last().click({ force: true });
    await page.waitForSelector(".owen-mermaid-editor-modal", { state: "detached", timeout: 10000 });
    await page.evaluate(async (path) => {
      const app = window.app;
      const leaf = (app?.workspace?.getLeavesOfType?.("markdown") ?? []).find((candidate) => candidate.view?.file?.path === path);
      if (!leaf) throw new Error("Smoke Markdown leaf was not found.");
      await leaf.setViewState({ type: "markdown", state: { file: path, mode: "source", source: false }, active: true });
    }, smokePath);
    await smokeLeaf.locator(".markdown-source-view.mod-cm6:visible .cm-lang-mermaid .owen-mermaid-inline-toolbar").first().waitFor({ state: "attached", timeout: 15000 });
    const livePreview = await smokeLeaf.locator(".markdown-source-view.mod-cm6:visible .cm-lang-mermaid .mermaid").first().evaluate((block) => ({
      marker: block.getAttribute("data-owen-mermaid-enhanced"),
      toolbarCount: block.querySelectorAll(".owen-mermaid-inline-toolbar").length,
      actions: Array.from(block.querySelectorAll(".owen-mermaid-inline-toolbar [data-action]")).map((button) => button.getAttribute("data-action")),
    }));
    if (livePreview.marker !== "true" || livePreview.toolbarCount !== 1) throw new Error("Live Preview Mermaid toolbar was not attached.");
    ui = { ...ui, editor: { ...editorContract, ...panResult }, livePreview };
  }

  console.log(JSON.stringify({ ok: true, ...result, ui }, null, 2));
} finally {
  if (smokePath) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if (!page.url().startsWith("app://obsidian.md")) continue;
      try {
        await page.evaluate(() => {
          for (const modal of document.querySelectorAll(".owen-mermaid-editor-modal")) {
            const buttons = modal.querySelectorAll(".owen-mermaid-editor-actions button");
            buttons[buttons.length - 1]?.click();
          }
        });
        await page.waitForSelector(".owen-mermaid-editor-modal", { state: "detached", timeout: 3000 });
      } catch {
        // Continue cleanup even if the modal was already removed or could not close.
      }
      try {
        await page.evaluate((path) => {
          const leaves = window.app?.workspace?.getLeavesOfType?.("markdown") ?? [];
          for (const leaf of leaves) {
            if (leaf.view?.file?.path === path) leaf.detach();
          }
        }, smokePath);
      } catch {
        // Continue cleanup even if Obsidian already detached the temporary leaf.
      }
      try {
        await page.evaluate(async (path) => {
          const app = window.app;
          const file = app?.vault?.getAbstractFileByPath?.(path);
          if (file) await app.vault.delete(file, true);
        }, smokePath);
      } catch {
        // Best-effort file cleanup. Keep the original smoke-test failure if there was one.
      }
      break;
    }
  }
  await browser.close();
}
