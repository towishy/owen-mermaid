import type { App } from "obsidian";
import "../styles.css";
import { MermaidEditorModal } from "./editorModal";
import { generateFlowchart, parseFlowchart } from "./flowchart";
import { createTranslator, type Locale } from "./i18n";
import { svgToImageBlob } from "./svgExport";
import type { ExportFormat, FlowDirection, MermaidRenderedLayout, RenderedEdgeLayout, RenderedNodeLayout } from "./types";
import { hasOwenMermaidLayout, renderVisualDiagram } from "./visualRenderer";
import { MermaidZoomModal } from "./zoomModal";

export interface BrowserEditorOptions {
  fallbackDirection?: FlowDirection;
  locale?: Locale;
  onSave: (nextSource: string) => Promise<void> | void;
  renderedSvg?: SVGSVGElement | null;
  source: string;
}

export interface BrowserViewerOptions {
  locale?: Locale;
  svg: SVGSVGElement;
  zoomStep?: number;
}

export interface BrowserExportOptions {
  background?: string;
  format: ExportFormat;
  quality?: number;
  scale?: number;
  svg: SVGSVGElement;
}

export function openEditor(options: BrowserEditorOptions): MermaidEditorModal {
  const renderedLayout = options.renderedSvg && !hasOwenMermaidLayout(options.source)
    ? extractRenderedLayout(options.renderedSvg)
    : undefined;
  const modal = new MermaidEditorModal(
    {} as App,
    options.source,
    options.fallbackDirection ?? inferDirection(options.source),
    async (nextSource) => options.onSave(nextSource),
    renderedLayout,
    options.locale ?? inferLocale(),
  );
  modal.open();
  return modal;
}

export function openViewer(options: BrowserViewerOptions): MermaidZoomModal {
  const locale = options.locale ?? inferLocale();
  const modal = new MermaidZoomModal({} as App, options.svg, options.zoomStep ?? 0.15, createTranslator(locale));
  modal.open();
  return modal;
}

export function exportImage(options: BrowserExportOptions): Promise<Blob> {
  return svgToImageBlob(options.svg, options.format, options.scale ?? 2, options.background ?? "#FFFFFF", options.quality ?? 0.92);
}

export { generateFlowchart, hasOwenMermaidLayout, parseFlowchart, renderVisualDiagram };

export function extractRenderedLayout(svg: SVGSVGElement): MermaidRenderedLayout {
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

function inferDirection(source: string): FlowDirection {
  const match = source.match(/^\s*(?:flowchart|graph)\s+(TD|LR|BT|RL)\b/im);
  return (match?.[1]?.toUpperCase() as FlowDirection | undefined) ?? "TD";
}

function extractRenderedEdges(svg: SVGSVGElement): RenderedEdgeLayout[] {
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>("g.edgePaths path, path.flowchart-link, path.messageLine0, path.messageLine1"));
  const edges: RenderedEdgeLayout[] = [];
  for (const path of paths) {
    const value = path.getAttribute("d")?.trim();
    if (!value || value.length < 4 || edges.some((edge) => edge.path === value)) continue;
    edges.push({ path: value });
  }
  return edges;
}

function readRenderedNode(element: SVGGElement, svg: SVGSVGElement): RenderedNodeLayout | null {
  const label = element.querySelector("text")?.textContent?.trim().replace(/\s+/g, " ") || undefined;
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
      height: Math.max(40, box.height),
      id,
      label,
      width: Math.max(64, box.width),
      x: translated?.x ?? transformed.x,
      y: translated?.y ?? transformed.y,
    };
  } catch {
    return null;
  }
}

function readSvgTranslate(element: Element): { x: number; y: number } | null {
  const match = (element.getAttribute("transform") ?? "").match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*,?\s*(-?\d+(?:\.\d+)?)?\s*\)/);
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

function inferLocale(): Locale {
  const language = document.documentElement.lang || navigator.language || "en";
  return language.toLocaleLowerCase().startsWith("ko") ? "ko" : "en";
}