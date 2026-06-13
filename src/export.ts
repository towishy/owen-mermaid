import * as fs from "fs";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { OwenMermaidSettings } from "./settings";
import type { ExportFormat } from "./types";

const MAX_CANVAS_DIMENSION = 16384;
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_OUTPUT_FOLDER = "exports/images";

interface ElectronRemoteDialog {
  showSaveDialog(options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
    properties: string[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

interface ElectronWindow extends Window {
  electron?: {
    remote?: {
      dialog?: ElectronRemoteDialog;
    };
  };
}

export interface ExportFilenameContext {
  sourceName: string;
  sourcePath?: string;
  lineStart?: number;
  heading?: string;
  index?: number;
}

export interface VaultExportResult {
  path: string;
  fileName: string;
  folder: string;
  format: ExportFormat;
  bytes: number;
}

export async function downloadSvgImage(
  svg: SVGSVGElement,
  format: ExportFormat,
  settings: OwenMermaidSettings,
  source: ExportFilenameContext | string,
  app: App,
): Promise<void> {
  try {
    if (settings.saveLocation === "vault") {
      const result = await exportSvgImageToVault(svg, format, settings, source, app);
      new Notice(`Mermaid diagram saved: ${result.path}`);
    } else {
      const blob = await svgToImageBlob(svg, format, settings.exportScale, settings.imageBackground, settings.imageQuality);
      const path = await saveBlobWithDialog(blob, format, settings, source, svg.ownerDocument.defaultView ?? window);
      if (path) new Notice(`Mermaid diagram saved: ${path}`);
    }
  } catch (error) {
    new Notice(`Mermaid download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function exportSvgImageToVault(
  svg: SVGSVGElement,
  format: ExportFormat,
  settings: OwenMermaidSettings,
  source: ExportFilenameContext | string,
  app: App,
): Promise<VaultExportResult> {
  const blob = await svgToImageBlob(svg, format, settings.exportScale, settings.imageBackground, settings.imageQuality);
  return saveBlobToVault(blob, format, settings, source, app);
}

export async function svgToImageBlob(svg: SVGSVGElement, format: ExportFormat, scale: number, background = "#FFFFFF", quality = 0.92): Promise<Blob> {
  const preparedSvg = prepareSvg(svg);
  const svgString = new XMLSerializer().serializeToString(preparedSvg);
  const win = svg.ownerDocument.defaultView ?? window;
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const imageUrl = win.URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      win.URL.revokeObjectURL(imageUrl);
      const dimensions = getSvgDimensions(preparedSvg, image);
      let canvasWidth = Math.max(1, Math.round(dimensions.width * scale));
      let canvasHeight = Math.max(1, Math.round(dimensions.height * scale));

      if (canvasWidth > MAX_CANVAS_DIMENSION || canvasHeight > MAX_CANVAS_DIMENSION) {
        const downscale = Math.min(MAX_CANVAS_DIMENSION / canvasWidth, MAX_CANVAS_DIMENSION / canvasHeight);
        canvasWidth = Math.floor(canvasWidth * downscale);
        canvasHeight = Math.floor(canvasHeight * downscale);
      }

      const canvas = svg.ownerDocument.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas context is not available"));
        return;
      }

      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export returned no data"))),
        format === "jpg" ? "image/jpeg" : "image/png",
        quality,
      );
    };
    image.onerror = () => {
      win.URL.revokeObjectURL(imageUrl);
      reject(new Error("SVG could not be loaded as an image"));
    };
    image.src = imageUrl;
  });
}

function prepareSvg(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.querySelectorAll("script").forEach((script) => script.remove());
  clone.querySelectorAll("foreignObject").forEach((foreignObject) => replaceForeignObjectWithText(foreignObject, svg));
  ensureDimensions(clone, svg);
  inlineComputedSvgStyles(clone, svg);
  return clone;
}

function replaceForeignObjectWithText(foreignObject: Element, originalSvg: SVGSVGElement): void {
  const bounds = readBounds(foreignObject);
  const lines = (foreignObject.textContent ?? "").split(/\s*\n\s*/).map((line) => line.trim()).filter(Boolean);
  const text = originalSvg.ownerDocument.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(bounds.x + bounds.width / 2));
  text.setAttribute("y", String(bounds.y + bounds.height / 2));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  text.setAttribute("fill", "currentColor");
  text.setAttribute("font-size", "14");

  if (lines.length <= 1) {
    text.textContent = lines[0] ?? foreignObject.textContent ?? "";
  } else {
    const offset = -((lines.length - 1) * 16) / 2;
    for (const [index, line] of lines.entries()) {
      const tspan = originalSvg.ownerDocument.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(bounds.x + bounds.width / 2));
      tspan.setAttribute("dy", index === 0 ? String(offset) : "16");
      tspan.textContent = line;
      text.appendChild(tspan);
    }
  }

  foreignObject.replaceWith(text);
}

function ensureDimensions(clone: SVGSVGElement, original: SVGSVGElement): void {
  const dimensions = getElementDimensions(original);
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(dimensions.width));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(dimensions.height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`);
}

function getSvgDimensions(svg: SVGSVGElement, image: HTMLImageElement): { width: number; height: number } {
  const width = parseFloat(svg.getAttribute("width") ?? "") || image.naturalWidth || 800;
  const height = parseFloat(svg.getAttribute("height") ?? "") || image.naturalHeight || 600;
  return { width, height };
}

function getElementDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    width: parseFloat(svg.getAttribute("width") ?? "") || rect.width || viewBox.width || 800,
    height: parseFloat(svg.getAttribute("height") ?? "") || rect.height || viewBox.height || 600,
  };
}

function readBounds(element: Element): { x: number; y: number; width: number; height: number } {
  return {
    x: parseFloat(element.getAttribute("x") ?? "0") || 0,
    y: parseFloat(element.getAttribute("y") ?? "0") || 0,
    width: parseFloat(element.getAttribute("width") ?? "0") || 0,
    height: parseFloat(element.getAttribute("height") ?? "0") || 0,
  };
}

function inlineComputedSvgStyles(clone: SVGSVGElement, original: SVGSVGElement): void {
  const selector = "text, path, rect, circle, ellipse, polygon, polyline, line";
  const originalElements = Array.from(original.querySelectorAll<SVGElement>(selector));
  Array.from(clone.querySelectorAll<SVGElement>(selector)).forEach((element, index) => {
    const source = originalElements[index];
    if (!source) return;
    const style = getComputedStyle(source);

    setPresentationAttribute(element, "fill", style.fill || style.color);
    setPresentationAttribute(element, "stroke", style.stroke);
    setPresentationAttribute(element, "stroke-width", style.strokeWidth);
    setPresentationAttribute(element, "stroke-dasharray", style.strokeDasharray);
    setPresentationAttribute(element, "stroke-linecap", style.strokeLinecap);
    setPresentationAttribute(element, "stroke-linejoin", style.strokeLinejoin);
    setPresentationAttribute(element, "opacity", style.opacity);

    if (element.tagName.toLowerCase() === "text") {
      setPresentationAttribute(element, "font-family", style.fontFamily || "Arial, sans-serif");
      setPresentationAttribute(element, "font-size", style.fontSize || "14px");
      setPresentationAttribute(element, "font-weight", style.fontWeight);
    }
  });
}

function setPresentationAttribute(element: SVGElement, name: string, value: string): void {
  const normalized = value.trim();
  if (!normalized || normalized === "normal" || normalized === "auto") return;
  element.setAttribute(name, normalized);
}

async function saveBlobWithDialog(blob: Blob, format: ExportFormat, settings: OwenMermaidSettings, source: ExportFilenameContext | string, win: Window): Promise<string | null> {
  const electron = (win as ElectronWindow).electron;
  if (!electron?.remote?.dialog) {
    new Notice("Download requires the Obsidian desktop app.");
    return null;
  }

  const extension = format === "jpg" ? "jpg" : "png";
  const result = await electron.remote.dialog.showSaveDialog({
    defaultPath: `${formatFilename(settings.filenameTemplate, source, extension, settings.exportScale)}.${extension}`,
    filters: [{ name: format === "jpg" ? "JPG Images" : "PNG Images", extensions: [extension] }],
    properties: ["showOverwriteConfirmation"],
  });

  if (result.canceled || !result.filePath) return null;
  const buffer = Buffer.from(await blob.arrayBuffer());
  await fs.promises.writeFile(result.filePath, buffer);
  return result.filePath;
}

async function saveBlobToVault(blob: Blob, format: ExportFormat, settings: OwenMermaidSettings, source: ExportFilenameContext | string, app: App): Promise<VaultExportResult> {
  const extension = format === "jpg" ? "jpg" : "png";
  const folder = getVaultExportFolder(settings);
  const baseName = formatFilename(settings.filenameTemplate, source, extension, settings.exportScale);
  await ensureVaultFolder(app, folder);
  const buffer = await blob.arrayBuffer();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = await getAvailableVaultPath(app, folder, baseName, extension);
    try {
      await app.vault.adapter.writeBinary(target.path, buffer);
      return { ...target, folder, format, bytes: blob.size };
    } catch (error) {
      if (attempt === 4) throw error;
      await ensureVaultFolder(app, folder);
    }
  }

  throw new Error("Vault export failed after retries");
}

export function getVaultExportFolder(settings: Pick<OwenMermaidSettings, "outputFolder">): string {
  return normalizeVaultFolderPath(settings.outputFolder) || DEFAULT_OUTPUT_FOLDER;
}

export async function ensureVaultFolder(app: App, folder: string): Promise<void> {
  const normalized = normalizeVaultFolderPath(folder);
  if (!normalized) return;

  let current = "";
  for (const segment of normalized.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (await app.vault.adapter.exists(current)) continue;
    try {
      await app.vault.adapter.mkdir(current);
    } catch (error) {
      if (!(await app.vault.adapter.exists(current))) throw error;
    }
  }
}

export async function getAvailableVaultPath(app: App, folder: string, baseName: string, extension: string): Promise<{ path: string; fileName: string }> {
  const normalizedFolder = normalizeVaultFolderPath(folder);
  const safeBaseName = sanitizeFilename(baseName).replace(/\s+/g, " ").trim() || "mermaid-diagram";
  let counter = 1;

  while (true) {
    const suffix = counter === 1 ? "" : `-${counter}`;
    const fileName = `${safeBaseName}${suffix}.${extension}`;
    const path = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
    if (!(await app.vault.adapter.exists(path))) return { path, fileName };
    counter += 1;
  }
}

export async function writeTextToAvailableVaultPath(app: App, folder: string, baseName: string, extension: string, content: string): Promise<{ path: string; fileName: string }> {
  await ensureVaultFolder(app, folder);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = await getAvailableVaultPath(app, folder, baseName, extension);
    try {
      await app.vault.adapter.write(target.path, content);
      return target;
    } catch (error) {
      if (attempt === 4) throw error;
      await ensureVaultFolder(app, folder);
    }
  }

  throw new Error("Vault text write failed after retries");
}

function normalizeVaultFolderPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function formatFilename(template: string, source: ExportFilenameContext | string, format: string, scale: number): string {
  const context = normalizeFilenameContext(source);
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const sourcePath = context.sourcePath ?? context.sourceName;
  const rawName = sourcePath.split("/").pop() ?? context.sourceName;
  const note = rawName.replace(/\.md$/i, "") || context.sourceName;
  const folder = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "";
  const index = String(context.index ?? (context.lineStart === undefined ? 1 : context.lineStart + 1));
  const base = template
    .replace(/\{\{name\}\}/g, context.sourceName || note || "mermaid-diagram")
    .replace(/\{\{rawName\}\}/g, rawName || context.sourceName || "mermaid-diagram")
    .replace(/\{\{note\}\}/g, note || context.sourceName || "mermaid-diagram")
    .replace(/\{\{folder\}\}/g, folder)
    .replace(/\{\{heading\}\}/g, context.heading ?? "")
    .replace(/\{\{index\}\}/g, index)
    .replace(/\{\{format\}\}/g, format)
    .replace(/\{\{scale\}\}/g, String(scale))
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time);
  return sanitizeFilename(base).replace(/\s+/g, " ").trim() || `mermaid-diagram-${Date.now()}`;
}

function sanitizeFilename(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || /[<>:"/\\|?*]/.test(character) ? "-" : character;
  }).join("");
}

function normalizeFilenameContext(source: ExportFilenameContext | string): ExportFilenameContext {
  if (typeof source === "string") return { sourceName: source || "mermaid-diagram" };
  return { ...source, sourceName: source.sourceName || "mermaid-diagram" };
}
