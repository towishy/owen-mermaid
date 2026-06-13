import { MarkdownPostProcessorContext, MarkdownView, Menu, Notice, Plugin, TFile, setIcon } from "obsidian";
import { MermaidEditorModal } from "./editorModal";
import { downloadSvgImage, exportSvgImageToVault, getVaultExportFolder, writeTextToAvailableVaultPath, type ExportFilenameContext } from "./export";
import { ensureLiquidGlassFilter } from "./liquidGlass";
import { DEFAULT_SETTINGS, OwenMermaidSettingTab, type OwenMermaidSettings } from "./settings";
import type { ExportFormat, MermaidBlockContext, MermaidRenderedLayout, RenderedEdgeLayout, RenderedNodeLayout } from "./types";
import { MermaidZoomModal } from "./zoomModal";

const MARKER_ATTR = "data-owen-mermaid-enhanced";
const MERMAID_SELECTOR = ".mermaid, .block-language-mermaid";

interface SectionInfo {
  text: string;
  lineStart: number;
  lineEnd: number;
}

interface MermaidFenceInfo {
  source: string;
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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new OwenMermaidSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((el, ctx) => {
      if (this.processMermaidBlocks(el, ctx)) return;
      this.observeForLateMermaid(el, ctx);
    }, 100);

    this.addCommand({
      id: "scan-mermaid-diagrams",
      name: "Scan Mermaid diagrams",
      callback: () => this.processOpenDocuments(),
    });

    this.addCommand({
      id: "export-active-note-mermaid-diagrams",
      name: "Export Mermaid diagrams in active note",
      callback: () => void this.exportActiveNoteMermaidDiagrams(),
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.processOpenDocuments()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.processOpenDocuments()));
    this.app.workspace.onLayoutReady(() => this.processOpenDocuments());
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<OwenMermaidSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  processMermaidBlocks(el: HTMLElement, ctx?: MarkdownPostProcessorContext): boolean {
    const blocks = this.collectMermaidBlocks(el);
    for (const block of blocks) this.attachBlockUi(block, ctx);
    return blocks.length > 0;
  }

  private collectMermaidBlocks(el: HTMLElement): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (el.matches(MERMAID_SELECTOR)) blocks.push(el);
    blocks.push(...Array.from(el.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)));
    const uniqueBlocks = Array.from(new Set(blocks));
    return uniqueBlocks.filter((block) => !uniqueBlocks.some((other) => other !== block && other.contains(block)));
  }

  private attachBlockUi(block: HTMLElement, ctx?: MarkdownPostProcessorContext): void {
    if (block.hasAttribute(MARKER_ATTR)) return;
    block.setAttribute(MARKER_ATTR, "true");
    block.addClass("owen-mermaid-block");
    ensureLiquidGlassFilter(block.ownerDocument);

    const svg = block.querySelector<SVGSVGElement>("svg");
    if (!svg) {
      this.pollForSvg(block, ctx);
      return;
    }

    const blockContext = this.createBlockContext(block, ctx);
    const toolbar = block.createDiv({ cls: "owen-mermaid-inline-toolbar" });
    this.createInlineButton(toolbar, "maximize-2", "Open zoom viewer", () => this.openZoom(svg));
    this.createInlineButton(toolbar, "edit-3", "Edit Mermaid diagram", () => void this.openEditor(blockContext, svg));
    this.createInlineButton(toolbar, "download", "Download Mermaid image", () => void this.download(svg, this.settings.exportFormat, blockContext));

    this.registerDomEvent(block, "contextmenu", (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("svg")) return;
      event.preventDefault();
      this.showContextMenu(event, svg, blockContext);
    });
  }

  private pollForSvg(block: HTMLElement, ctx?: MarkdownPostProcessorContext): void {
    const win = block.ownerDocument.defaultView ?? window;
    let tries = 0;
    const timer = win.setInterval(() => {
      tries += 1;
      const svg = block.querySelector<SVGSVGElement>("svg");
      if (svg || tries >= 25) {
        win.clearInterval(timer);
        block.removeAttribute(MARKER_ATTR);
        if (svg) this.attachBlockUi(block, ctx);
      }
    }, 200);
    this.register(() => win.clearInterval(timer));
  }

  private observeForLateMermaid(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const win = el.ownerDocument.defaultView ?? window;
    let done = false;
    const observer = new MutationObserver(() => {
      if (!this.processMermaidBlocks(el, ctx)) return;
      finish();
    });
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      win.clearTimeout(timeoutId);
    };
    observer.observe(el, { childList: true, subtree: true });
    const timeoutId = win.setTimeout(finish, 5000);
    this.register(finish);
  }

  private processOpenDocuments(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const container = leaf.view.containerEl;
      this.processMermaidBlocks(container);
    }
  }

  private createInlineButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-icon-button", attr: { type: "button", "aria-label": label, title: label } });
    setIcon(button, icon);
    this.registerDomEvent(button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private showContextMenu(event: MouseEvent, svg: SVGSVGElement, context: MermaidBlockContext): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Open zoom viewer").setIcon("maximize-2").onClick(() => this.openZoom(svg)));
    menu.addItem((item) => item.setTitle("Edit Mermaid diagram").setIcon("edit-3").onClick(() => void this.openEditor(context, svg)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Download PNG").setIcon("download").onClick(() => void this.download(svg, "png", context)));
    menu.addItem((item) => item.setTitle("Download JPG").setIcon("image").onClick(() => void this.download(svg, "jpg", context)));
    menu.showAtMouseEvent(event);
  }

  private openZoom(svg: SVGSVGElement): void {
    new MermaidZoomModal(this.app, svg, this.settings.zoomStep).open();
  }

  private async openEditor(context: MermaidBlockContext, svg?: SVGSVGElement): Promise<void> {
    const resolvedContext = await this.resolveEditableContext(context, svg?.textContent ?? "");
    if (!resolvedContext.sourcePath || resolvedContext.lineStart === undefined || resolvedContext.lineEnd === undefined) {
      new Notice("Mermaid 원본 코드블록을 찾지 못했습니다. 노트를 연 상태에서 다시 시도해 주세요.");
      return;
    }

    new MermaidEditorModal(
      this.app,
      resolvedContext.source ?? "",
      this.settings.defaultEditorDirection,
      async (nextSource) => this.replaceMermaidSource(resolvedContext, nextSource),
      svg ? extractRenderedLayout(svg) : undefined,
    ).open();
  }

  private async download(svg: SVGSVGElement, format: ExportFormat, context: MermaidBlockContext): Promise<void> {
    await downloadSvgImage(svg, format, this.settings, this.createFilenameContext(context), this.app);
  }

  private async exportActiveNoteMermaidDiagrams(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!view || !file) {
      new Notice("활성 Markdown 노트를 찾지 못했습니다.");
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
      new Notice("렌더링된 Mermaid SVG를 찾지 못했습니다. 읽기 보기나 라이브 프리뷰에서 다시 시도해 주세요.");
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
    const reportSuffix = reportPath ? ` Report: ${reportPath}` : "";
    if (failures.length > 0) {
      new Notice(`Mermaid batch export finished with ${failures.length} failure(s).${reportSuffix}`);
      return;
    }

    new Notice(`Exported ${results.length} Mermaid diagram(s).${reportSuffix}`);
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
      "# Owen Mermaid Batch Export",
      "",
      `- Note: ${file.path}`,
      `- Format: ${this.settings.exportFormat.toUpperCase()}`,
      `- Completed: ${new Date().toISOString()}`,
      `- Total: ${results.length}`,
      `- Failed: ${failures.length}`,
      "",
      "| # | Source line | Status | Output | Message |",
      "| --- | --- | --- | --- | --- |",
    ];

    for (const result of results) {
      const sourceLine = result.context.lineStart === undefined ? "" : String(result.context.lineStart + 1);
      lines.push(
        `| ${result.index} | ${sourceLine} | ${result.error ? "Failed" : "Saved"} | ${formatReportCell(result.path)} | ${formatReportCell(result.error)} |`,
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
      source: sectionInfo ? extractMermaidSource(sectionInfo.text) : undefined,
      blockIndex: this.getBlockIndex(block),
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
      new Notice("Mermaid source file was not found.");
      return;
    }

    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const rangeStart = Math.max(0, context.lineStart);
    const rangeEnd = Math.min(lines.length - 1, context.lineEnd);
    const opening = findFenceLine(lines, rangeStart, rangeEnd, true);
    const closing = opening === -1 ? -1 : findFenceLine(lines, opening + 1, rangeEnd, false);
    const nextLines = nextSource.trimEnd().split(/\r?\n/);

    if (opening >= 0 && closing > opening) {
      lines.splice(opening + 1, closing - opening - 1, ...nextLines);
    } else {
      lines.splice(rangeStart, rangeEnd - rangeStart + 1, "```mermaid", ...nextLines, "```");
    }

    await this.app.vault.modify(file, lines.join("\n"));
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

function extractMermaidSource(sectionText: string): string {
  const lines = sectionText.split(/\r?\n/);
  const opening = findFenceLine(lines, 0, lines.length - 1, true);
  const closing = opening === -1 ? -1 : findFenceLine(lines, opening + 1, lines.length - 1, false);
  if (opening >= 0 && closing > opening) return lines.slice(opening + 1, closing).join("\n");
  return sectionText;
}

function findMermaidFences(content: string): MermaidFenceInfo[] {
  const lines = content.split(/\r?\n/);
  const fences: MermaidFenceInfo[] = [];
  let opening = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (opening === -1) {
      if (/^```\s*mermaid\b/i.test(line)) opening = index;
      continue;
    }

    if (/^```\s*$/.test(line)) {
      fences.push({
        lineStart: opening,
        lineEnd: index,
        source: lines.slice(opening + 1, index).join("\n"),
      });
      opening = -1;
    }
  }

  return fences;
}

function findFenceLine(lines: string[], start: number, end: number, opening: boolean): number {
  for (let index = start; index <= end; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (opening && /^```\s*mermaid\b/i.test(line)) return index;
    if (!opening && /^```\s*$/.test(line)) return index;
  }
  return -1;
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
