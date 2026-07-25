import { MarkdownPostProcessorContext, MarkdownView, Menu, Notice, Plugin, TFile, moment, setIcon } from "obsidian";
import { MermaidEditorModal } from "./editorModal";
import { downloadSvgImage, exportSvgImageToVault, getVaultExportFolder, writeTextToAvailableVaultPath, type ExportFilenameContext } from "./export";
import { createTranslator, normalizeLocalePreference, resolveLocale, type Locale, type LocalePreference, type TranslationKey } from "./i18n";
import { ensureLiquidGlassFilter } from "./liquidGlass";
import { extractMermaidSource, findMermaidFences, replaceMermaidSourceInContent, type MermaidFenceInfo } from "./markdown";
import { DEFAULT_SETTINGS, OwenMermaidSettingTab, type OwenMermaidSettings } from "./settings";
import type { ExportFormat, MermaidBlockContext, MermaidRenderedLayout, RenderedEdgeLayout, RenderedNodeLayout } from "./types";
import { hasOwenMermaidLayout, renderVisualDiagram } from "./visualRenderer";
import { MermaidZoomModal } from "./zoomModal";

const MARKER_ATTR = "data-owen-mermaid-enhanced";
const MERMAID_SELECTOR = ".mermaid, .block-language-mermaid";
const MERMAID_CODE_SELECTOR = "pre > code.language-mermaid";
const EARLY_RENDER_SORT_ORDER = -1000;
const ENHANCE_RENDER_SORT_ORDER = 100;

interface SectionInfo {
  text: string;
  lineStart: number;
  lineEnd: number;
}

interface BatchExportResult {
  index: number;
  context: MermaidBlockContext;
  path?: string;
  error?: string;
}

export default class OwenMermaidPlugin extends Plugin {
  settings: OwenMermaidSettings = { ...DEFAULT_SETTINGS };
  private openDocumentsProcessTimeout?: number;
  private readonly observedMarkdownContainers = new WeakSet<HTMLElement>();

  get locale(): Locale {
    return resolveLocale(this.settings.language, moment.locale());
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new OwenMermaidSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.renderStoredLayoutCodeBlocks(el, ctx);
    }, EARLY_RENDER_SORT_ORDER);

    this.registerMarkdownPostProcessor((el, ctx) => {
      if (this.processMermaidBlocks(el, ctx)) return;
      this.observeForLateMermaid(el, ctx);
    }, ENHANCE_RENDER_SORT_ORDER);

    this.addCommand({
      id: "scan-mermaid-diagrams",
      name: this.t("command.scan"),
      callback: () => this.processOpenDocuments(),
    });

    this.addCommand({
      id: "export-active-note-mermaid-diagrams",
      name: this.t("command.exportActive"),
      callback: () => void this.exportActiveNoteMermaidDiagrams(),
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.queueProcessOpenDocuments()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueProcessOpenDocuments()));
    this.app.workspace.onLayoutReady(() => this.queueProcessOpenDocuments(0));
    this.register(() => {
      if (this.openDocumentsProcessTimeout !== undefined) window.clearTimeout(this.openDocumentsProcessTimeout);
      this.openDocumentsProcessTimeout = undefined;
    });
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<OwenMermaidSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.settings.language = normalizeLocalePreference(this.settings.language);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  t(key: TranslationKey, variables?: Record<string, string | number>): string {
    return createTranslator(this.locale)(key, variables);
  }

  async setLanguage(language: LocalePreference): Promise<void> {
    this.settings.language = language;
    await this.saveSettings();
    this.refreshInlineToolbarLabels();
  }

  processMermaidBlocks(el: HTMLElement, ctx?: MarkdownPostProcessorContext): boolean {
    const blocks = this.collectMermaidBlocks(el);
    for (const block of blocks) void this.attachBlockUi(block, ctx);
    return blocks.length > 0;
  }

  private collectMermaidBlocks(el: HTMLElement): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (el.matches(MERMAID_SELECTOR)) blocks.push(el);
    blocks.push(...Array.from(el.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)));
    const uniqueBlocks = Array.from(new Set(blocks));
    return uniqueBlocks.filter((block) => !uniqueBlocks.some((other) => other !== block && other.contains(block)));
  }

  private renderStoredLayoutCodeBlocks(el: HTMLElement, ctx: MarkdownPostProcessorContext): boolean {
    if (!this.settings.renderStoredLayoutsImmediately) return false;
    let rendered = false;

    for (const code of this.collectUnrenderedMermaidCodeBlocks(el)) {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== "PRE") continue;
      const source = code.textContent ?? "";
      if (!hasOwenMermaidLayout(source)) continue;

      const block = el.ownerDocument.createElement("div");
      block.classList.add("block-language-mermaid", "owen-mermaid-block");
      block.setAttribute(MARKER_ATTR, "true");
      ensureLiquidGlassFilter(block.ownerDocument);

      const visualSvg = this.renderStoredLayoutSvg(block, source);
      if (!visualSvg) continue;

      const blockContext = this.createCodeBlockContext(source, pre, ctx);
      pre.replaceWith(block);
      blockContext.blockIndex = this.getBlockIndex(block);
      this.attachSvgActions(block, visualSvg, blockContext);
      this.watchStoredLayoutBlock(block, blockContext);
      rendered = true;
    }

    return rendered;
  }

  private collectUnrenderedMermaidCodeBlocks(el: HTMLElement): HTMLElement[] {
    const codes: HTMLElement[] = [];
    if (el.matches(MERMAID_CODE_SELECTOR)) codes.push(el);
    codes.push(...Array.from(el.querySelectorAll<HTMLElement>(MERMAID_CODE_SELECTOR)));
    return Array.from(new Set(codes));
  }

  private async attachBlockUi(block: HTMLElement, ctx?: MarkdownPostProcessorContext): Promise<void> {
    if (block.hasAttribute(MARKER_ATTR)) return;
    block.setAttribute(MARKER_ATTR, "true");
    block.addClass("owen-mermaid-block");
    ensureLiquidGlassFilter(block.ownerDocument);

    let blockContext = this.createBlockContext(block, ctx);
    const initialVisualSvg = this.renderStoredLayoutSvg(block, blockContext.source);
    if (initialVisualSvg) {
      this.attachSvgActions(block, initialVisualSvg, blockContext);
      this.watchStoredLayoutBlock(block, blockContext);
      return;
    }

    const nativeSvg = block.querySelector<SVGSVGElement>("svg");
    if (!nativeSvg) {
      this.waitForSvg(block, ctx);
      return;
    }

    if (!hasOwenMermaidLayout(blockContext.source ?? "")) {
      blockContext = await this.resolveEditableContext(blockContext, nativeSvg.textContent ?? "");
      if (!block.isConnected) return;
    }

    const visualSvg = this.renderStoredLayoutSvg(block, blockContext.source);
    this.attachSvgActions(block, visualSvg ?? nativeSvg, blockContext);
    if (visualSvg) this.watchStoredLayoutBlock(block, blockContext);
  }

  private attachSvgActions(block: HTMLElement, svg: SVGSVGElement, blockContext: MermaidBlockContext): void {
    const toolbar = block.createDiv({ cls: "owen-mermaid-inline-toolbar" });
    this.createInlineButton(toolbar, "maximize-2", "zoom", this.t("inline.zoom"), () => this.openZoom(svg));
    this.createInlineButton(toolbar, "edit-3", "edit", this.t("inline.edit"), () => void this.openEditor(blockContext, svg));
    this.createInlineButton(toolbar, "download", "download", this.t("inline.download"), () => void this.download(svg, this.settings.exportFormat, blockContext));

    this.registerDomEvent(block, "contextmenu", (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("svg")) return;
      event.preventDefault();
      this.showContextMenu(event, svg, blockContext);
    });
  }

  private waitForSvg(block: HTMLElement, ctx?: MarkdownPostProcessorContext): void {
    const win = block.ownerDocument.defaultView ?? window;
    let done = false;
    let timeoutId: number | undefined;
    const observer = new MutationObserver(() => {
      const svg = block.querySelector<SVGSVGElement>("svg");
      if (svg) finish(svg);
    });
    const finish = (svg?: SVGSVGElement) => {
      if (done) return;
      done = true;
      observer.disconnect();
      if (timeoutId !== undefined) win.clearTimeout(timeoutId);
      block.removeAttribute(MARKER_ATTR);
      if (svg) void this.attachBlockUi(block, ctx);
    };

    observer.observe(block, { childList: true, subtree: true });
    const currentSvg = block.querySelector<SVGSVGElement>("svg");
    if (currentSvg) {
      finish(currentSvg);
      return;
    }

    timeoutId = win.setTimeout(() => finish(), 5000);
    this.register(finish);
  }

  private watchStoredLayoutBlock(block: HTMLElement, blockContext: MermaidBlockContext): void {
    const source = blockContext.source;
    if (!source || !hasOwenMermaidLayout(source)) return;

    const win = block.ownerDocument.defaultView ?? window;
    let done = false;
    let timeoutId: number | undefined;
    const observer = new MutationObserver(() => {
      if (block.querySelector("svg.owen-mermaid-visual-svg") && block.querySelector(".owen-mermaid-inline-toolbar")) return;
      const visualSvg = this.renderStoredLayoutSvg(block, source);
      if (!visualSvg) return;
      block.setAttribute(MARKER_ATTR, "true");
      this.attachSvgActions(block, visualSvg, blockContext);
    });
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      if (timeoutId !== undefined) win.clearTimeout(timeoutId);
    };

    observer.observe(block, { childList: true });
    timeoutId = win.setTimeout(finish, 5000);
    this.register(finish);
  }

  private observeForLateMermaid(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const win = el.ownerDocument.defaultView ?? window;
    let done = false;
    let queuedProcess: number | undefined;
    const observer = new MutationObserver(() => {
      if (queuedProcess !== undefined) return;
      queuedProcess = win.setTimeout(() => {
        queuedProcess = undefined;
        if (!this.processMermaidBlocks(el, ctx)) return;
        finish();
      }, 50);
    });
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      if (queuedProcess !== undefined) win.clearTimeout(queuedProcess);
      win.clearTimeout(timeoutId);
    };
    observer.observe(el, { childList: true, subtree: true });
    const timeoutId = win.setTimeout(finish, 5000);
    this.register(finish);
  }

  private processOpenDocuments(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const container = leaf.view.containerEl;
      this.observeMarkdownContainer(container);
      this.processMermaidBlocks(container);
    }
  }

  private observeMarkdownContainer(container: HTMLElement): void {
    if (this.observedMarkdownContainers.has(container)) return;
    this.observedMarkdownContainers.add(container);

    const observer = new MutationObserver((mutations) => {
      const hasUnprocessedMermaid = mutations.some((mutation) => {
        if (mutation.type === "attributes") {
          return mutation.target instanceof HTMLElement
            && mutation.target.matches(MERMAID_SELECTOR)
            && !mutation.target.hasAttribute(MARKER_ATTR);
        }

        return Array.from(mutation.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.matches(MERMAID_SELECTOR) && !node.hasAttribute(MARKER_ATTR)) return true;
          return Boolean(node.querySelector(`${MERMAID_SELECTOR}:not([${MARKER_ATTR}])`));
        });
      });
      if (hasUnprocessedMermaid) this.queueProcessOpenDocuments(20);
    });

    observer.observe(container, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    this.register(() => observer.disconnect());
  }

  private queueProcessOpenDocuments(delay = 80): void {
    const win = window;
    if (this.openDocumentsProcessTimeout !== undefined) win.clearTimeout(this.openDocumentsProcessTimeout);
    this.openDocumentsProcessTimeout = win.setTimeout(() => {
      this.openDocumentsProcessTimeout = undefined;
      this.processOpenDocuments();
    }, delay);
  }

  private createInlineButton(parent: HTMLElement, icon: string, action: "zoom" | "edit" | "download", label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-icon-button", attr: { type: "button", "data-action": action, "aria-label": label, title: label } });
    setIcon(button, icon);
    this.registerDomEvent(button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private showContextMenu(event: MouseEvent, svg: SVGSVGElement, context: MermaidBlockContext): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.t("inline.zoom")).setIcon("maximize-2").onClick(() => this.openZoom(svg)));
    menu.addItem((item) => item.setTitle(this.t("inline.edit")).setIcon("edit-3").onClick(() => void this.openEditor(context, svg)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("menu.downloadPng")).setIcon("download").onClick(() => void this.download(svg, "png", context)));
    menu.addItem((item) => item.setTitle(this.t("menu.downloadJpg")).setIcon("image").onClick(() => void this.download(svg, "jpg", context)));
    menu.showAtMouseEvent(event);
  }

  private openZoom(svg: SVGSVGElement): void {
    new MermaidZoomModal(this.app, svg, this.settings.zoomStep, createTranslator(this.locale)).open();
  }

  private async openEditor(context: MermaidBlockContext, svg?: SVGSVGElement): Promise<void> {
    const resolvedContext = await this.resolveEditableContext(context, svg?.textContent ?? "");
    if (!resolvedContext.sourcePath || resolvedContext.lineStart === undefined || resolvedContext.lineEnd === undefined) {
      new Notice(this.t("notice.sourceBlockMissing"));
      return;
    }

    new MermaidEditorModal(
      this.app,
      resolvedContext.source ?? "",
      this.settings.defaultEditorDirection,
      async (nextSource) => this.replaceMermaidSource(resolvedContext, nextSource),
      svg && !hasOwenMermaidLayout(resolvedContext.source ?? "") ? extractRenderedLayout(svg) : undefined,
      this.locale,
    ).open();
  }

  private renderStoredLayoutSvg(block: HTMLElement, source: string | undefined): SVGSVGElement | undefined {
    if (!source || !hasOwenMermaidLayout(source)) return undefined;
    const svg = renderVisualDiagram(source, block.ownerDocument, this.settings.defaultEditorDirection, this.t("visual.diagramAria"));
    if (!svg) return undefined;
    block.empty();
    block.appendChild(svg);
    return svg;
  }

  private async download(svg: SVGSVGElement, format: ExportFormat, context: MermaidBlockContext): Promise<void> {
    await downloadSvgImage(svg, format, this.settings, this.createFilenameContext(context), this.app, createTranslator(this.locale));
  }

  private async exportActiveNoteMermaidDiagrams(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!view || !file) {
      new Notice(this.t("notice.activeNoteMissing"));
      return;
    }

    this.processMermaidBlocks(view.containerEl);
    const content = await this.app.vault.read(file);
    const fences = findMermaidFences(content);
    const blocks = this.collectMermaidBlocks(view.containerEl);
    const entries = blocks
      .map((block, index) => ({ block, svg: findRenderedMermaidSvg(block), index }))
      .filter((entry): entry is { block: HTMLElement; svg: SVGSVGElement; index: number } => Boolean(entry.svg));

    if (entries.length === 0) {
      new Notice(this.t("notice.renderedSvgMissing"));
      return;
    }

    const results: BatchExportResult[] = [];
    for (const entry of entries) {
      const fence = this.findFenceForRenderedText(fences, entry.svg.textContent ?? "") ?? fences[Math.min(entry.index, fences.length - 1)];
      const context: MermaidBlockContext = {
        sourcePath: file.path,
        lineStart: fence?.lineStart,
        lineEnd: fence?.lineEnd,
        source: fence?.source,
        blockIndex: entry.index,
      };

      try {
        const saved = await exportSvgImageToVault(entry.svg, this.settings.exportFormat, this.settings, this.createFilenameContext(context), this.app);
        results.push({ index: entry.index + 1, context, path: saved.path });
      } catch (error) {
        results.push({ index: entry.index + 1, context, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const failures = results.filter((result) => result.error);
    const reportPath = await this.writeBatchReportIfNeeded(file, results);
    const reportSuffix = reportPath ? this.t("notice.reportSuffix", { path: reportPath }) : "";
    if (failures.length > 0) {
      new Notice(this.t("notice.batchFailed", { count: failures.length, report: reportSuffix }));
      return;
    }

    new Notice(this.t("notice.batchSucceeded", { count: results.length, report: reportSuffix }));
  }

  private async writeBatchReportIfNeeded(file: TFile, results: BatchExportResult[]): Promise<string | undefined> {
    const failures = results.filter((result) => result.error);
    const shouldWrite = this.settings.batchReportMode === "always" || (this.settings.batchReportMode === "failures" && failures.length > 0);
    if (!shouldWrite) return undefined;

    const folder = getVaultExportFolder(this.settings);
    const timestamp = formatBatchTimestamp(new Date());
    const baseName = sanitizeReportName(`${file.basename}-mermaid-export-${timestamp}`);
    const target = await writeTextToAvailableVaultPath(this.app, folder, baseName, "md", this.createBatchReport(file, results));
    return target.path;
  }

  private createBatchReport(file: TFile, results: BatchExportResult[]): string {
    const failures = results.filter((result) => result.error);
    const lines = [
      `# ${this.t("report.title")}`,
      "",
      `- ${this.t("common.note")}: ${file.path}`,
      `- ${this.t("common.format")}: ${this.settings.exportFormat.toUpperCase()}`,
      `- ${this.t("common.completed")}: ${new Date().toISOString()}`,
      `- ${this.t("common.total")}: ${results.length}`,
      `- ${this.t("common.failedCount")}: ${failures.length}`,
      "",
      `| # | ${this.t("common.sourceLine")} | ${this.t("common.status")} | ${this.t("common.output")} | ${this.t("common.message")} |`,
      "| --- | --- | --- | --- | --- |",
    ];

    for (const result of results) {
      const sourceLine = result.context.lineStart === undefined ? "" : String(result.context.lineStart + 1);
      lines.push(
        `| ${result.index} | ${sourceLine} | ${result.error ? this.t("common.failed") : this.t("common.saved")} | ${formatReportCell(result.path)} | ${formatReportCell(result.error)} |`,
      );
    }

    return `${lines.join("\n")}\n`;
  }

  private createBlockContext(block: HTMLElement, ctx?: MarkdownPostProcessorContext): MermaidBlockContext {
    const sectionInfo = ctx ? this.getSectionInfo(ctx, block) : null;
    return {
      sourcePath: ctx?.sourcePath,
      lineStart: sectionInfo?.lineStart,
      lineEnd: sectionInfo?.lineEnd,
      source: sectionInfo ? extractMermaidSource(sectionInfo.text) : readUnrenderedMermaidSource(block),
      blockIndex: this.getBlockIndex(block),
    };
  }

  private createCodeBlockContext(source: string, codeBlock: HTMLElement, ctx: MarkdownPostProcessorContext): MermaidBlockContext {
    const sectionInfo = this.getSectionInfo(ctx, codeBlock);
    return {
      sourcePath: ctx.sourcePath,
      lineStart: sectionInfo?.lineStart,
      lineEnd: sectionInfo?.lineEnd,
      source: sectionInfo ? extractMermaidSource(sectionInfo.text) : source,
    };
  }

  private async resolveEditableContext(context: MermaidBlockContext, renderedText = ""): Promise<MermaidBlockContext> {
    if (!renderedText && context.sourcePath && context.lineStart !== undefined && context.lineEnd !== undefined) return context;

    const sourcePath = context.sourcePath ?? this.app.workspace.getActiveFile()?.path;
    if (!sourcePath) return context;

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return context;

    const content = await this.app.vault.read(file);
    const fences = findMermaidFences(content);
    if (fences.length === 0) return { ...context, sourcePath };

    const source = context.source?.trim();
    const matchedFence = source ? fences.find((fence) => fence.source.trim() === source) : undefined;
    const renderedFence = this.findFenceForRenderedText(fences, renderedText);
    const fallbackFence = fences[Math.min(context.blockIndex ?? 0, fences.length - 1)];
    const fence = renderedFence ?? matchedFence ?? fallbackFence;

    return {
      ...context,
      sourcePath,
      lineStart: fence.lineStart,
      lineEnd: fence.lineEnd,
      source: fence.source,
    };
  }

  private findFenceForRenderedText(fences: MermaidFenceInfo[], renderedText: string): MermaidFenceInfo | undefined {
    const rendered = normalizeRenderedText(renderedText);
    if (!rendered) return undefined;

    let best: { fence: MermaidFenceInfo; score: number } | undefined;
    for (const fence of fences) {
      const score = scoreFenceAgainstRenderedText(fence.source, rendered);
      if (score < 2) continue;
      if (!best || score > best.score) best = { fence, score };
    }
    return best?.fence;
  }

  private getBlockIndex(block: HTMLElement): number {
    const root = block.closest<HTMLElement>(".markdown-preview-view, .markdown-reading-view, .markdown-source-view, .view-content") ?? block.parentElement;
    if (!root) return 0;
    const blocks = this.collectMermaidBlocks(root);
    const index = blocks.indexOf(block);
    return index >= 0 ? index : 0;
  }

  private getSectionInfo(ctx: MarkdownPostProcessorContext, block: HTMLElement): SectionInfo | null {
    const maybeContext = ctx as MarkdownPostProcessorContext & { getSectionInfo?: (el: HTMLElement) => SectionInfo | null };
    return maybeContext.getSectionInfo?.(block) ?? null;
  }

  private async replaceMermaidSource(context: MermaidBlockContext, nextSource: string): Promise<void> {
    if (!context.sourcePath || context.lineStart === undefined || context.lineEnd === undefined) return;
    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice(this.t("notice.sourceFileMissing"));
      return;
    }

    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, replaceMermaidSourceInContent(content, context, nextSource));
    this.refreshRenderedMermaidBlocks(context.sourcePath);
  }

  private refreshRenderedMermaidBlocks(sourcePath?: string): void {
    const win = window;
    const refresh = () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as MarkdownView & { previewMode?: { rerender?: (force?: boolean) => void } };
        if (sourcePath && view.file?.path !== sourcePath) continue;
        view.previewMode?.rerender?.(true);
        this.processMermaidBlocks(view.containerEl);
      }
    };
    refresh();
    for (const delay of [120, 360, 900]) win.setTimeout(refresh, delay);
  }

  private refreshInlineToolbarLabels(): void {
    const labels: Record<string, string> = {
      zoom: this.t("inline.zoom"),
      edit: this.t("inline.edit"),
      download: this.t("inline.download"),
    };
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      leaf.view.containerEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-inline-toolbar [data-action]").forEach((button) => {
        const label = labels[button.dataset.action ?? ""];
        if (!label) return;
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);
      });
    }
  }

  private sourceName(context: MermaidBlockContext): string {
    const path = context.sourcePath ?? "mermaid-diagram";
    return path.split("/").pop()?.replace(/\.md$/i, "") || "mermaid-diagram";
  }

  private createFilenameContext(context: MermaidBlockContext): ExportFilenameContext {
    return {
      sourceName: this.sourceName(context),
      sourcePath: context.sourcePath,
      lineStart: context.lineStart,
      index: context.lineStart === undefined ? undefined : context.lineStart + 1,
    };
  }
}

function extractRenderedLayout(svg: SVGSVGElement): MermaidRenderedLayout {
  const nodes: RenderedNodeLayout[] = [];
  const candidates = Array.from(svg.querySelectorAll<SVGGElement>("g.node, g[class*='node']"));
  for (const candidate of candidates) {
    if (candidate.querySelector("g.node")) continue;
    const layout = readRenderedNode(candidate, svg);
    if (!layout) continue;
    if (nodes.some((node) => Math.abs(node.x - layout.x) < 2 && Math.abs(node.y - layout.y) < 2 && node.label === layout.label)) continue;
    nodes.push(layout);
  }
  return { nodes, edges: extractRenderedEdges(svg) };
}

function extractRenderedEdges(svg: SVGSVGElement): RenderedEdgeLayout[] {
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>("g.edgePaths path, path.flowchart-link, path.messageLine0, path.messageLine1"));
  const edges: RenderedEdgeLayout[] = [];
  for (const path of paths) {
    const value = path.getAttribute("d")?.trim();
    if (!value || value.length < 4) continue;
    if (edges.some((edge) => edge.path === value)) continue;
    edges.push({ path: value });
  }
  return edges;
}

function readRenderedNode(element: SVGGElement, svg: SVGSVGElement): RenderedNodeLayout | null {
  const text = element.querySelector("text")?.textContent?.trim().replace(/\s+/g, " ") || undefined;
  const id = readRenderedNodeId(element);
  try {
    const box = element.getBBox();
    if (!Number.isFinite(box.x) || box.width < 8 || box.height < 8) return null;
    const translated = readSvgTranslate(element);
    const point = svg.createSVGPoint();
    point.x = box.x + box.width / 2;
    point.y = box.y + box.height / 2;
    const matrix = element.getCTM();
    const transformed = matrix ? point.matrixTransform(matrix) : point;
    return {
      id,
      label: text,
      x: translated?.x ?? transformed.x,
      y: translated?.y ?? transformed.y,
      width: Math.max(64, box.width),
      height: Math.max(40, box.height),
    };
  } catch {
    return null;
  }
}

function readSvgTranslate(element: Element): { x: number; y: number } | null {
  const transform = element.getAttribute("transform") ?? "";
  const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*,?\s*(-?\d+(?:\.\d+)?)?\s*\)/);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2] ?? 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function readRenderedNodeId(element: Element): string | undefined {
  for (const value of [element.id, element.getAttribute("data-id"), element.getAttribute("data-node")]) {
    const id = value?.trim();
    if (!id) continue;
    const match = id.match(/^(?:flowchart-|node-)?([A-Za-z][\w-]*?)(?:-\d+)?$/);
    if (match) return match[1];
  }
  return undefined;
}

function scoreFenceAgainstRenderedText(source: string, renderedText: string): number {
  let score = 0;
  for (const token of extractFenceTextTokens(source)) {
    if (renderedText.includes(normalizeRenderedText(token))) score += Math.min(6, Math.max(1, token.length / 4));
  }
  return score;
}

function extractFenceTextTokens(source: string): string[] {
  const tokens = new Set<string>();
  const add = (value: string | undefined) => {
    const token = value?.replace(/["'`]/g, "").replace(/\s+/g, " ").trim();
    if (token && token.length >= 2 && !/^(flowchart|graph|sequenceDiagram|stateDiagram-v2?|participant|actor)$/i.test(token)) tokens.add(token);
  };

  for (const match of source.matchAll(/\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\)/g)) add(match[1] ?? match[2] ?? match[3]);
  for (const match of source.matchAll(/\b(?:participant|actor)\s+[A-Za-z][\w-]*(?:\s+as\s+(.+))?/gi)) add(match[1]);
  for (const match of source.matchAll(/:\s*([^\n]+)/g)) add(match[1]);
  for (const match of source.matchAll(/^\s*([A-Za-z][\w-]*)\s*-->/gm)) add(match[1]);
  for (const match of source.matchAll(/-->\s*([A-Za-z][\w-]*)/g)) add(match[1]);

  return Array.from(tokens);
}

function normalizeRenderedText(value: string): string {
  return value.replace(/[#.][A-Za-z0-9_-]+\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
}

function readUnrenderedMermaidSource(block: HTMLElement): string | undefined {
  if (block.querySelector("svg")) return undefined;
  const text = block.textContent?.trim();
  if (!text) return undefined;
  return extractMermaidSource(text);
}

function findRenderedMermaidSvg(block: HTMLElement): SVGSVGElement | undefined {
  return Array.from(block.querySelectorAll<SVGSVGElement>("svg")).find((svg) => !svg.closest(".owen-mermaid-inline-toolbar"));
}

function formatBatchTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sanitizeReportName(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim() || "mermaid-export-report";
}

function formatReportCell(value: string | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
