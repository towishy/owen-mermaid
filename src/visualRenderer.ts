import { createConnectorPath, getConnectorLabelPoint } from "./editorGeometry";
import { parseFlowchart } from "./flowchart";
import type { DiagramEdge, DiagramFreeLine, DiagramNode, FlowDiagram, FlowDirection } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const LAYOUT_META_PATTERN = /^\s*%%\s+owen-mermaid:/m;
const BASE_CANVAS_WIDTH = 980;
const BASE_CANVAS_HEIGHT = 680;
const CANVAS_PADDING = 88;
const SEQUENCE_TOP_Y = 82;
const SEQUENCE_MESSAGE_START_Y = 176;
const SEQUENCE_MESSAGE_GAP = 62;
const SEQUENCE_BOTTOM_PADDING = 96;

let renderId = 0;

type CanvasPoint = { x: number; y: number };
type CanvasBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };

export function hasOwenMermaidLayout(source: string): boolean {
  return LAYOUT_META_PATTERN.test(source);
}

export function renderVisualDiagram(source: string, document: Document, fallbackDirection: FlowDirection, ariaLabel = "Owen Mermaid diagram"): SVGSVGElement | null {
  if (!hasOwenMermaidLayout(source)) return null;
  const diagram = parseFlowchart(source, fallbackDirection);
  const bounds = getCanvasBounds(diagram);
  const svg = createSvg(document, "svg", {
    class: "owen-mermaid-visual-svg",
    viewBox: `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`,
    width: String(Math.round(bounds.width)),
    height: String(Math.round(bounds.height)),
    role: "img",
    "aria-label": ariaLabel,
  }) as SVGSVGElement;
  renderId += 1;
  if (diagram.syntax === "sequenceDiagram") renderSequenceDiagram(svg, diagram, renderId);
  else renderNodeDiagram(svg, diagram, renderId);
  return svg;
}

function renderNodeDiagram(svg: SVGSVGElement, diagram: FlowDiagram, id: number): void {
  const defs = createSvg(svg.ownerDocument, "defs");
  svg.appendChild(defs);
  createArrowMarker(defs, "#64748b", `owen-mermaid-visual-arrow-${id}`);

  const edges = createSvg(svg.ownerDocument, "g", { class: "owen-mermaid-edges" });
  svg.appendChild(edges);
  for (const edge of diagram.edges) renderEdge(edges, diagram, edge, id);
  for (const line of diagram.freeLines) renderFreeLine(edges, line, id);

  const nodes = createSvg(svg.ownerDocument, "g", { class: "owen-mermaid-nodes" });
  svg.appendChild(nodes);
  for (const node of diagram.nodes) renderNode(nodes, node);
}

function renderSequenceDiagram(svg: SVGSVGElement, diagram: FlowDiagram, id: number): void {
  const defs = createSvg(svg.ownerDocument, "defs");
  svg.appendChild(defs);
  createArrowMarker(defs, "#64748b", `owen-mermaid-visual-arrow-${id}`);

  const participants = createSvg(svg.ownerDocument, "g", { class: "owen-mermaid-sequence-participants" });
  const messages = createSvg(svg.ownerDocument, "g", { class: "owen-mermaid-sequence-messages" });
  svg.appendChild(messages);
  svg.appendChild(participants);

  const bottomY = getSequenceBottomY(diagram);
  for (const node of diagram.nodes) {
    participants.appendChild(createSvg(svg.ownerDocument, "line", {
      class: "owen-mermaid-sequence-lifeline",
      x1: String(node.x),
      y1: String(SEQUENCE_TOP_Y + node.height / 2),
      x2: String(node.x),
      y2: String(bottomY - node.height / 2),
      ...strokeStyleAttrs(node.strokeColor, node.strokeWidth),
    }));
  }

  diagram.edges.forEach((edge, index) => renderSequenceMessage(messages, diagram, edge, index, id));
  for (const line of diagram.freeLines) renderFreeLine(messages, line, id);
  for (const node of diagram.nodes) {
    renderSequenceParticipant(participants, node, SEQUENCE_TOP_Y);
    renderSequenceParticipant(participants, node, bottomY);
  }
}

function renderNode(parent: SVGElement, node: DiagramNode): void {
  const group = createSvg(parent.ownerDocument, "g", {
    class: "owen-mermaid-node",
    transform: `translate(${node.x}, ${node.y})`,
    "data-id": node.id,
  });
  parent.appendChild(group);
  appendShape(group, node);
  const text = createSvg(parent.ownerDocument, "text", {
    x: "0",
    y: "5",
    "text-anchor": "middle",
    ...textStyleAttrs(node.textColor, node.textSize),
  });
  text.textContent = node.label;
  group.appendChild(text);
}

function appendShape(group: SVGElement, node: DiagramNode): void {
  const width = node.width;
  const height = node.height;
  const attrs = nodeStyleAttrs(node);
  if (node.shape === "diamond") {
    group.appendChild(createSvg(group.ownerDocument, "polygon", { points: `0,${-height / 2} ${width / 2},0 0,${height / 2} ${-width / 2},0`, ...attrs }));
    return;
  }
  if (node.shape === "circle") {
    group.appendChild(createSvg(group.ownerDocument, "ellipse", { cx: "0", cy: "0", rx: String(width / 2), ry: String(height / 2), ...attrs }));
    return;
  }
  const radius = node.shape === "rounded" ? Math.min(12, height / 2) : node.shape === "stadium" ? height / 2 : 6;
  group.appendChild(createSvg(group.ownerDocument, "rect", { x: String(-width / 2), y: String(-height / 2), width: String(width), height: String(height), rx: String(radius), ...attrs }));
}

function renderEdge(parent: SVGElement, diagram: FlowDiagram, edge: DiagramEdge, renderIndex: number): void {
  const from = diagram.nodes.find((node) => node.id === edge.from);
  const to = diagram.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return;
  const endpoints = getEdgeEndpoints(from, to);
  const path = createConnectorPath(endpoints.from, endpoints.to, edge.route, edge.waypoints);
  const group = createSvg(parent.ownerDocument, "g", { class: `owen-mermaid-edge is-${edge.style}` });
  parent.appendChild(group);
  group.appendChild(createSvg(parent.ownerDocument, "path", { class: "owen-mermaid-edge-hit", d: path, fill: "none" }));
  const markerId = edge.strokeColor ? createArrowMarker(parent.ownerSVGElement?.querySelector("defs") ?? parent, edge.strokeColor, `owen-mermaid-visual-arrow-${renderIndex}-${sanitizeId(edge.strokeColor)}`) : `owen-mermaid-visual-arrow-${renderIndex}`;
  group.appendChild(createSvg(parent.ownerDocument, "path", {
    class: "owen-mermaid-edge-line",
    d: path,
    fill: "none",
    ...strokeStyleAttrs(edge.strokeColor, edge.strokeWidth),
    ...(edge.style === "line" ? {} : { "marker-end": `url(#${markerId})` }),
  }));
  if (edge.label) appendLabel(group, getConnectorLabelPoint(endpoints.from, endpoints.to, edge.waypoints, edge.labelOffsetX, edge.labelOffsetY), edge.label, edge.textColor, edge.textSize);
}

function renderFreeLine(parent: SVGElement, line: DiagramFreeLine, renderIndex: number): void {
  const path = createConnectorPath({ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }, line.route, line.waypoints);
  const group = createSvg(parent.ownerDocument, "g", { class: `owen-mermaid-free-line is-${line.style}` });
  parent.appendChild(group);
  group.appendChild(createSvg(parent.ownerDocument, "path", { class: "owen-mermaid-edge-hit", d: path, fill: "none" }));
  const markerId = line.strokeColor ? createArrowMarker(parent.ownerSVGElement?.querySelector("defs") ?? parent, line.strokeColor, `owen-mermaid-visual-arrow-${renderIndex}-${sanitizeId(line.strokeColor)}`) : `owen-mermaid-visual-arrow-${renderIndex}`;
  group.appendChild(createSvg(parent.ownerDocument, "path", {
    class: "owen-mermaid-edge-line",
    d: path,
    fill: "none",
    ...strokeStyleAttrs(line.strokeColor, line.strokeWidth),
    ...(line.style === "line" ? {} : { "marker-end": `url(#${markerId})` }),
  }));
  if (line.label) appendLabel(group, getConnectorLabelPoint({ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }, line.waypoints, line.labelOffsetX, line.labelOffsetY), line.label, line.textColor, line.textSize);
}

function renderSequenceParticipant(parent: SVGElement, node: DiagramNode, y: number): void {
  const group = createSvg(parent.ownerDocument, "g", { class: "owen-mermaid-sequence-participant", transform: `translate(${node.x}, ${y})`, "data-id": node.id });
  parent.appendChild(group);
  group.appendChild(createSvg(parent.ownerDocument, "rect", { x: String(-node.width / 2), y: String(-node.height / 2), width: String(node.width), height: String(node.height), rx: "7", ...nodeStyleAttrs(node) }));
  const text = createSvg(parent.ownerDocument, "text", { x: "0", y: "5", "text-anchor": "middle", ...textStyleAttrs(node.textColor, node.textSize) });
  text.textContent = node.label;
  group.appendChild(text);
}

function renderSequenceMessage(parent: SVGElement, diagram: FlowDiagram, edge: DiagramEdge, index: number, renderIndex: number): void {
  const from = diagram.nodes.find((node) => node.id === edge.from);
  const to = diagram.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return;
  const y = SEQUENCE_MESSAGE_START_Y + index * SEQUENCE_MESSAGE_GAP;
  const direction = from.x <= to.x ? 1 : -1;
  const startX = from.x + direction * 4;
  const endX = to.x - direction * 4;
  const group = createSvg(parent.ownerDocument, "g", { class: `owen-mermaid-sequence-message${edge.style === "dotted" ? " is-dotted" : ""}` });
  parent.appendChild(group);
  const path = `M ${startX} ${y} L ${endX} ${y}`;
  group.appendChild(createSvg(parent.ownerDocument, "path", { class: "owen-mermaid-edge-hit", d: path, fill: "none" }));
  const markerId = edge.strokeColor ? createArrowMarker(parent.ownerSVGElement?.querySelector("defs") ?? parent, edge.strokeColor, `owen-mermaid-visual-arrow-${renderIndex}-${sanitizeId(edge.strokeColor)}`) : `owen-mermaid-visual-arrow-${renderIndex}`;
  group.appendChild(createSvg(parent.ownerDocument, "path", { class: "owen-mermaid-edge-line", d: path, fill: "none", ...strokeStyleAttrs(edge.strokeColor, edge.strokeWidth), "marker-end": `url(#${markerId})` }));
  if (edge.label) appendLabel(group, { x: (startX + endX) / 2, y: y - 16 }, edge.label, edge.textColor, edge.textSize, "owen-mermaid-sequence-message-label");
}

function appendLabel(parent: SVGElement, point: CanvasPoint, label: string, color?: string, size?: number, className = "owen-mermaid-edge-label"): void {
  const text = createSvg(parent.ownerDocument, "text", { class: className, x: String(point.x), y: String(point.y), "text-anchor": "middle", ...textStyleAttrs(color, size) });
  text.textContent = label;
  parent.appendChild(text);
}

function getCanvasBounds(diagram: FlowDiagram): CanvasBounds {
  if (diagram.syntax === "sequenceDiagram") {
    const nodeMinX = Math.min(0, ...diagram.nodes.map((node) => node.x - node.width / 2 - CANVAS_PADDING));
    const nodeMaxX = Math.max(BASE_CANVAS_WIDTH, ...diagram.nodes.map((node) => node.x + node.width / 2 + CANVAS_PADDING));
    const maxY = getSequenceBottomY(diagram) + 68 + CANVAS_PADDING;
    return makeBounds(nodeMinX, 0, nodeMaxX, Math.max(BASE_CANVAS_HEIGHT, maxY));
  }

  const nodeMinX = Math.min(0, ...diagram.nodes.map((node) => node.x - node.width / 2 - CANVAS_PADDING));
  const nodeMinY = Math.min(0, ...diagram.nodes.map((node) => node.y - node.height / 2 - CANVAS_PADDING));
  const nodeMaxX = Math.max(BASE_CANVAS_WIDTH, ...diagram.nodes.map((node) => node.x + node.width / 2 + CANVAS_PADDING));
  const nodeMaxY = Math.max(BASE_CANVAS_HEIGHT, ...diagram.nodes.map((node) => node.y + node.height / 2 + CANVAS_PADDING));
  const linePoints = diagram.freeLines.flatMap((line) => [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]);
  const lineMinX = Math.min(0, ...linePoints.map((point) => point.x - CANVAS_PADDING));
  const lineMinY = Math.min(0, ...linePoints.map((point) => point.y - CANVAS_PADDING));
  const lineMaxX = Math.max(BASE_CANVAS_WIDTH, ...linePoints.map((point) => point.x + CANVAS_PADDING));
  const lineMaxY = Math.max(BASE_CANVAS_HEIGHT, ...linePoints.map((point) => point.y + CANVAS_PADDING));
  return makeBounds(Math.min(nodeMinX, lineMinX), Math.min(nodeMinY, lineMinY), Math.max(nodeMaxX, lineMaxX), Math.max(nodeMaxY, lineMaxY));
}

function makeBounds(minX: number, minY: number, maxX: number, maxY: number): CanvasBounds {
  const width = Math.max(BASE_CANVAS_WIDTH, maxX - minX);
  const height = Math.max(BASE_CANVAS_HEIGHT, maxY - minY);
  return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

function getSequenceBottomY(diagram: FlowDiagram): number {
  return SEQUENCE_MESSAGE_START_Y + Math.max(1, diagram.edges.length) * SEQUENCE_MESSAGE_GAP + SEQUENCE_BOTTOM_PADDING;
}

function getEdgeEndpoints(from: DiagramNode, to: DiagramNode): { from: CanvasPoint; to: CanvasPoint } {
  if (from.id === to.id) {
    return { from: { x: from.x + from.width / 2, y: from.y - from.height / 4 }, to: { x: from.x, y: from.y - from.height / 2 } };
  }
  return { from: getBoundaryPointToward(from, to), to: getBoundaryPointToward(to, from) };
}

function getBoundaryPointToward(node: DiagramNode, target: CanvasPoint): CanvasPoint {
  const dx = target.x - node.x;
  const dy = target.y - node.y;
  if (Math.abs(dx) / Math.max(1, node.width) > Math.abs(dy) / Math.max(1, node.height)) return { x: node.x + Math.sign(dx || 1) * node.width / 2, y: node.y };
  return { x: node.x, y: node.y + Math.sign(dy || 1) * node.height / 2 };
}

function nodeStyleAttrs(node: DiagramNode): Record<string, string> {
  const styles = [node.fillColor ? `fill: ${node.fillColor}` : "", node.strokeColor ? `stroke: ${node.strokeColor}` : "", node.strokeWidth ? `stroke-width: ${node.strokeWidth}` : ""].filter(Boolean);
  return styles.length > 0 ? { style: styles.join("; ") } : {};
}

function strokeStyleAttrs(color: string | undefined, width?: number): Record<string, string> {
  const styles = [color ? `stroke: ${color}` : "", width ? `stroke-width: ${width}` : ""].filter(Boolean);
  return styles.length > 0 ? { style: styles.join("; ") } : {};
}

function textStyleAttrs(color: string | undefined, size?: number): Record<string, string> {
  const styles = [color ? `fill: ${color}` : "", size ? `font-size: ${size}px` : ""].filter(Boolean);
  return styles.length > 0 ? { style: styles.join("; ") } : {};
}

function createArrowMarker(parent: Element, color: string, id: string): string {
  const existing = parent.querySelector(`#${id}`);
  if (existing) return id;
  const marker = createSvg(parent.ownerDocument, "marker", { id, markerWidth: "10", markerHeight: "10", refX: "9", refY: "3", orient: "auto", markerUnits: "strokeWidth" });
  marker.appendChild(createSvg(parent.ownerDocument, "path", { d: "M0,0 L0,6 L9,3 z", class: "owen-mermaid-arrow-head", style: `fill: ${color}` }));
  parent.appendChild(marker);
  return id;
}

function createSvg(document: Document, tag: string, attrs: Record<string, string> = {}): SVGElement {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function sanitizeId(value: string): string {
  return value.replace(/[^0-9a-z_-]/gi, "").toLowerCase() || "color";
}
