import type { DiagramEdge, DiagramFreeLine, DiagramNode, EdgeRoute, FlowDiagram, FlowDirection, NodeShape } from "./types";

const DIRECTION_PATTERN = /^(?:flowchart|graph)\s+(TD|LR|BT|RL)\s*$/i;
const STATE_DIAGRAM_PATTERN = /^stateDiagram(?:-v2)?\s*$/i;
const STATE_EDGE_PATTERN = /^\s*(\[\*\]|[A-Za-z][\w-]*)\s*-->\s*(\[\*\]|[A-Za-z][\w-]*)(?:\s*:\s*(.+))?\s*$/;
const STATE_NODE_PATTERN = /^\s*state\s+"([^"]+)"\s+as\s+([A-Za-z][\w-]*)\s*$/i;
const SEQUENCE_DIAGRAM_PATTERN = /^sequenceDiagram\s*$/i;
const SEQUENCE_PARTICIPANT_PATTERN = /^\s*(?:participant|actor)\s+([A-Za-z][\w-]*)(?:\s+as\s+(.+))?\s*$/i;
const SEQUENCE_MESSAGE_PATTERN = /^\s*([A-Za-z][\w-]*?)\s*(-{1,2}>>|-->|->)\s*([A-Za-z][\w-]*)\s*:\s*(.+)\s*$/;
const FLOW_NODE_SHAPE_PATTERN = String.raw`(?:\[[^\]]+\]|\(\([^)]*\)\)|\([^)]*\)|\{[^}]+\})`;
const LABELLED_EDGE_PATTERN = new RegExp(String.raw`^\s*([A-Za-z][\w-]*)(?:\s*(${FLOW_NODE_SHAPE_PATTERN}))?\s*(--|-.|==)\s*(.+?)\s*(-->|---|\.->|==>)\s*([A-Za-z][\w-]*)(?:\s*(${FLOW_NODE_SHAPE_PATTERN}))?\s*$`);
const EDGE_PATTERN = new RegExp(String.raw`^\s*([A-Za-z][\w-]*)(?:\s*(${FLOW_NODE_SHAPE_PATTERN}))?\s*(?:(-->|---|==>|-.->)\s*(?:\|([^|]+)\|)?|--\s*([^\-|]+?)\s*-->)\s*([A-Za-z][\w-]*)(?:\s*(${FLOW_NODE_SHAPE_PATTERN}))?\s*$`);
const NODE_PATTERN = new RegExp(String.raw`^\s*([A-Za-z][\w-]*)\s*(${FLOW_NODE_SHAPE_PATTERN})\s*$`);
const NODE_STYLE_PATTERN = /^\s*style\s+([A-Za-z][\w-]*)\s+(.+)\s*$/i;
const LINK_STYLE_PATTERN = /^\s*linkStyle\s+(\d+)\s+(.+)\s*$/i;
const STATE_CLASSDEF_PREFIX = "owenMermaidState";
const STATE_CLASSDEF_PATTERN = new RegExp(String.raw`^\s*classDef\s+(${STATE_CLASSDEF_PREFIX}\d+)\s+(.+)\s*$`, "i");
const STATE_CLASS_PATTERN = new RegExp(String.raw`^\s*class\s+([A-Za-z][\w-]*)\s+(${STATE_CLASSDEF_PREFIX}\d+)\s*$`, "i");
const INIT_DIRECTIVE_PATTERN = /^%%\{[\s\S]*\}%%$/;
const FLOWCHART_PRESERVED_LINE_PATTERN = /^\s*(?:classDef|class|style|click|linkStyle)\b/i;
const SUBGRAPH_START_PATTERN = /^\s*subgraph\b/i;
const SUBGRAPH_END_PATTERN = /^\s*end\s*$/i;
const LAYOUT_META_PREFIX = "%% owen-mermaid:";
const DEFAULT_NODE_WIDTH = 152;
const DEFAULT_NODE_HEIGHT = 68;
const STATE_START_ID = "__start";
const STATE_END_ID = "__end";

interface NodeLayoutMeta {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fillColor?: string;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

interface EdgeLayoutMeta {
  route?: EdgeRoute;
  labelOffsetX?: number;
  labelOffsetY?: number;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

interface LayoutMeta {
  nodes?: Record<string, NodeLayoutMeta>;
  edges?: Record<string, EdgeLayoutMeta>;
  freeLines?: DiagramFreeLine[];
}

interface VisualStyleMeta {
  fillColor?: string;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

export function parseFlowchart(source: string, fallbackDirection: FlowDirection): FlowDiagram {
  const diagram: FlowDiagram = {
    syntax: "flowchart",
    direction: fallbackDirection,
    directives: [],
    nodes: [],
    edges: [],
    freeLines: [],
    unsupportedLines: [],
  };
  const nodeMap = new Map<string, DiagramNode>();
  const stateStyleClasses = new Map<string, VisualStyleMeta>();
  let layoutMeta: LayoutMeta | null = null;

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let sawHeader = false;
  let preservedFlowchartBlockDepth = 0;

  for (const line of lines) {
    if (preservedFlowchartBlockDepth > 0) {
      diagram.unsupportedLines.push(line);
      if (SUBGRAPH_START_PATTERN.test(line)) preservedFlowchartBlockDepth += 1;
      if (SUBGRAPH_END_PATTERN.test(line)) preservedFlowchartBlockDepth -= 1;
      continue;
    }

    if (line.startsWith("%%")) {
      const meta = parseLayoutMeta(line);
      if (meta) {
        layoutMeta = meta;
        continue;
      }
      if (INIT_DIRECTIVE_PATTERN.test(line)) {
        diagram.directives.push(line);
        continue;
      }
      diagram.unsupportedLines.push(line);
      continue;
    }

    if (STATE_DIAGRAM_PATTERN.test(line)) {
      diagram.syntax = "stateDiagram";
      sawHeader = true;
      continue;
    }

    if (SEQUENCE_DIAGRAM_PATTERN.test(line)) {
      diagram.syntax = "sequenceDiagram";
      diagram.direction = "LR";
      sawHeader = true;
      continue;
    }

    const header = line.match(DIRECTION_PATTERN);
    if (header) {
      diagram.syntax = "flowchart";
      diagram.direction = header[1].toUpperCase() as FlowDirection;
      sawHeader = true;
      continue;
    }

    if (diagram.syntax === "flowchart") {
      const nodeStyle = line.match(NODE_STYLE_PATTERN);
      if (nodeStyle && applyNodeColorStyle(nodeMap, nodeStyle[1], nodeStyle[2])) continue;

      const linkStyle = line.match(LINK_STYLE_PATTERN);
      if (linkStyle && applyEdgeColorStyle(diagram.edges, Number(linkStyle[1]), linkStyle[2])) continue;
    }

    if (diagram.syntax === "flowchart" && FLOWCHART_PRESERVED_LINE_PATTERN.test(line)) {
      diagram.unsupportedLines.push(line);
      continue;
    }

    if (diagram.syntax === "flowchart" && SUBGRAPH_START_PATTERN.test(line)) {
      diagram.unsupportedLines.push(line);
      preservedFlowchartBlockDepth = 1;
      continue;
    }

    if (diagram.syntax === "stateDiagram") {
      const classDef = line.match(STATE_CLASSDEF_PATTERN);
      if (classDef) {
        const colors = parseColorStyle(classDef[2], true);
        if (colors) {
          stateStyleClasses.set(classDef[1], colors);
          continue;
        }
      }

      const classLine = line.match(STATE_CLASS_PATTERN);
      if (classLine && applyStateClassStyle(nodeMap, classLine[1], stateStyleClasses.get(classLine[2]))) continue;

      const stateNode = line.match(STATE_NODE_PATTERN);
      if (stateNode) {
        ensureNode(nodeMap, stateNode[2], `[${stateNode[1]}]`);
        continue;
      }

      const stateEdge = line.match(STATE_EDGE_PATTERN);
      if (stateEdge) {
        const from = normalizeStateEndpoint(stateEdge[1], "from");
        const to = normalizeStateEndpoint(stateEdge[2], "to");
        ensureStateNode(nodeMap, from);
        ensureStateNode(nodeMap, to);
        diagram.edges.push({
          id: createEdgeId(from, to, diagram.edges.length),
          from,
          to,
          label: stateEdge[3]?.trim() ?? "",
          style: "arrow",
        });
        continue;
      }
    }

    if (diagram.syntax === "sequenceDiagram") {
      const participant = line.match(SEQUENCE_PARTICIPANT_PATTERN);
      if (participant) {
        ensureSequenceParticipant(nodeMap, participant[1], participant[2]?.trim());
        continue;
      }

      const message = line.match(SEQUENCE_MESSAGE_PATTERN);
      if (message) {
        const from = message[1];
        const token = message[2];
        const to = message[3];
        ensureSequenceParticipant(nodeMap, from);
        ensureSequenceParticipant(nodeMap, to);
        diagram.edges.push({
          id: createEdgeId(from, to, diagram.edges.length),
          from,
          to,
          label: message[4]?.trim() ?? "",
          style: token.startsWith("--") ? "dotted" : "arrow",
        });
        continue;
      }
    }

    const labelledEdge = line.match(LABELLED_EDGE_PATTERN);
    if (labelledEdge) {
      const from = labelledEdge[1];
      const fromShape = labelledEdge[2];
      const label = labelledEdge[4]?.trim() ?? "";
      const token = labelledEdge[5];
      const to = labelledEdge[6];
      const toShape = labelledEdge[7];
      ensureNode(nodeMap, from, fromShape);
      ensureNode(nodeMap, to, toShape);
      diagram.edges.push({
        id: createEdgeId(from, to, diagram.edges.length),
        from,
        to,
        label,
        style: edgeStyleFromToken(token),
      });
      continue;
    }

    const edge = line.match(EDGE_PATTERN);
    if (edge) {
      const from = edge[1];
      const fromShape = edge[2];
      const token = edge[3] ?? "-->";
      const label = (edge[4] ?? edge[5] ?? "").trim();
      const to = edge[6];
      const toShape = edge[7];
      ensureNode(nodeMap, from, fromShape);
      ensureNode(nodeMap, to, toShape);
      diagram.edges.push({
        id: createEdgeId(from, to, diagram.edges.length),
        from,
        to,
        label,
        style: edgeStyleFromToken(token),
      });
      continue;
    }

    const node = line.match(NODE_PATTERN);
    if (node) {
      ensureNode(nodeMap, node[1], node[2]);
      continue;
    }

    diagram.unsupportedLines.push(line);
  }

  if (!sawHeader && !source.trim()) {
    ensureNode(nodeMap, "A", "[Start]");
    ensureNode(nodeMap, "B", "[Next]");
    diagram.edges.push({ id: createEdgeId("A", "B", 0), from: "A", to: "B", label: "", style: "arrow" });
  }

  const nodes = Array.from(nodeMap.values());
  diagram.nodes = applyLayoutMeta(
    diagram.syntax === "sequenceDiagram" ? layoutSequenceParticipants(nodes) : layoutNodes(nodes, diagram.edges, diagram.direction),
    layoutMeta,
  );
  applyEdgeMeta(diagram.edges, layoutMeta);
  diagram.freeLines = readFreeLines(layoutMeta);
  return diagram;
}

export function generateFlowchart(diagram: FlowDiagram, includeLayout = true): string {
  if (diagram.syntax === "stateDiagram") return generateStateDiagram(diagram, includeLayout);
  if (diagram.syntax === "sequenceDiagram") return generateSequenceDiagram(diagram, includeLayout);

  const lines = [...diagram.directives, `flowchart ${diagram.direction}`];
  if (includeLayout) lines.push(`  ${serializeLayoutMeta(diagram)}`);

  for (const node of diagram.nodes) {
    lines.push(`  ${node.id}${formatNodeShape(node)}`);
  }

  if (diagram.nodes.length > 0 && diagram.edges.length > 0) lines.push("");

  for (const edge of diagram.edges) {
    lines.push(`  ${edge.from} ${formatEdge(edge)} ${edge.to}`);
  }

  const styleLines = serializeFlowchartStyleLines(diagram);
  if (styleLines.length > 0) lines.push("", ...styleLines);

  if (diagram.unsupportedLines.length > 0) {
    lines.push("", "  %% Preserved unsupported lines");
    for (const line of diagram.unsupportedLines) lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

export function createNode(diagram: FlowDiagram, shape: NodeShape): DiagramNode {
  const id = nextNodeId(diagram.nodes.map((node) => node.id));
  const node: DiagramNode = {
    id,
    label: "New node",
    shape,
    x: 120 + (diagram.nodes.length % 4) * 180,
    y: 100 + Math.floor(diagram.nodes.length / 4) * 130,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
  };
  diagram.nodes.push(node);
  return node;
}

export function createEdge(diagram: FlowDiagram, from: string, to: string): DiagramEdge {
  const edge: DiagramEdge = {
    id: createEdgeId(from, to, diagram.edges.length),
    from,
    to,
    label: "",
    style: "arrow",
  };
  diagram.edges.push(edge);
  return edge;
}

export function cloneDiagram(diagram: FlowDiagram): FlowDiagram {
  return {
    syntax: diagram.syntax,
    direction: diagram.direction,
    directives: [...diagram.directives],
    nodes: diagram.nodes.map((node) => ({ ...node })),
    edges: diagram.edges.map((edge) => ({ ...edge })),
    freeLines: diagram.freeLines.map((line) => ({ ...line })),
    unsupportedLines: [...diagram.unsupportedLines],
  };
}

function generateStateDiagram(diagram: FlowDiagram, includeLayout: boolean): string {
  const lines = [...diagram.directives, "stateDiagram-v2"];
  if (includeLayout) lines.push(`  ${serializeLayoutMeta(diagram)}`);

  const connectedIds = new Set<string>();
  for (const edge of diagram.edges) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  for (const node of diagram.nodes) {
    if (isStateMarker(node.id)) continue;
    if (connectedIds.has(node.id) && node.label === node.id) continue;
    lines.push(`  state "${sanitizeStateLabel(node.label)}" as ${node.id}`);
  }

  for (const edge of diagram.edges) {
    const label = edge.label.trim() ? `: ${sanitizeStateLabel(edge.label)}` : "";
    lines.push(`  ${formatStateEndpoint(edge.from, "from")} --> ${formatStateEndpoint(edge.to, "to")}${label}`);
  }

  const styleLines = serializeStateDiagramStyleLines(diagram);
  if (styleLines.length > 0) lines.push("", ...styleLines);

  if (diagram.unsupportedLines.length > 0) {
    lines.push("", "  %% Preserved unsupported lines");
    for (const line of diagram.unsupportedLines) lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function generateSequenceDiagram(diagram: FlowDiagram, includeLayout: boolean): string {
  const lines = [...diagram.directives, "sequenceDiagram"];
  if (includeLayout) lines.push(`  ${serializeLayoutMeta(diagram)}`);

  for (const node of diagram.nodes) {
    lines.push(`  participant ${node.id} as ${sanitizeSequenceText(node.label)}`);
  }

  if (diagram.nodes.length > 0 && diagram.edges.length > 0) lines.push("");

  for (const edge of diagram.edges) {
    const token = edge.style === "dotted" ? "-->>" : "->>";
    lines.push(`  ${edge.from}${token}${edge.to}: ${sanitizeSequenceText(edge.label)}`);
  }

  if (diagram.unsupportedLines.length > 0) {
    lines.push("", "  %% Preserved unsupported lines");
    for (const line of diagram.unsupportedLines) lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function ensureNode(nodeMap: Map<string, DiagramNode>, id: string, syntax?: string): DiagramNode {
  const existing = nodeMap.get(id);
  if (existing) {
    if (syntax) {
      existing.label = extractLabel(id, syntax);
      existing.shape = extractShape(syntax);
    }
    return existing;
  }

  const node: DiagramNode = {
    id,
    label: syntax ? extractLabel(id, syntax) : id,
    shape: syntax ? extractShape(syntax) : "rectangle",
    x: 0,
    y: 0,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
  };
  nodeMap.set(id, node);
  return node;
}

function ensureStateNode(nodeMap: Map<string, DiagramNode>, id: string): DiagramNode {
  if (!isStateMarker(id)) return nodeMap.get(id) ?? ensureNode(nodeMap, id, `[${id}]`);

  const syntax = isStateMarker(id) ? "(( ))" : `[${id}]`;
  const node = ensureNode(nodeMap, id, syntax);
  if (id === STATE_START_ID) node.label = "Start";
  if (id === STATE_END_ID) node.label = "End";
  if (isStateMarker(id)) {
    node.shape = "circle";
    node.width = 72;
    node.height = 72;
  }
  return node;
}

function ensureSequenceParticipant(nodeMap: Map<string, DiagramNode>, id: string, label?: string): DiagramNode {
  const existing = nodeMap.get(id);
  const node = existing ?? ensureNode(nodeMap, id, `[${label || id}]`);
  if (existing && label) node.label = label;
  node.shape = "rounded";
  node.width = Math.max(DEFAULT_NODE_WIDTH, 96 + node.label.length * 8);
  node.height = DEFAULT_NODE_HEIGHT;
  return node;
}

function normalizeStateEndpoint(value: string, role: "from" | "to"): string {
  if (value === "[*]") return role === "from" ? STATE_START_ID : STATE_END_ID;
  return value;
}

function formatStateEndpoint(id: string, role: "from" | "to"): string {
  if (role === "from" && id === STATE_START_ID) return "[*]";
  if (role === "to" && id === STATE_END_ID) return "[*]";
  return id;
}

function isStateMarker(id: string): boolean {
  return id === STATE_START_ID || id === STATE_END_ID;
}

function layoutNodes(nodes: DiagramNode[], edges: DiagramEdge[], direction: FlowDirection): DiagramNode[] {
  const order = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)?.push(edge.to);
  }

  let index = 0;
  const visit = (id: string, depth: number) => {
    if (order.has(id)) return;
    order.set(id, depth);
    for (const next of adjacency.get(id) ?? []) visit(next, depth + 1);
  };
  for (const node of nodes) visit(node.id, index++);

  const lanes = new Map<number, number>();
  return nodes.map((node, fallbackIndex) => {
    const depth = order.get(node.id) ?? fallbackIndex;
    const lane = lanes.get(depth) ?? 0;
    lanes.set(depth, lane + 1);
    const horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "BT" || direction === "RL" ? -1 : 1;
    return {
      ...node,
      x: horizontal ? 120 + sign * depth * 190 : 150 + lane * 190,
      y: horizontal ? 110 + lane * 130 : 110 + sign * depth * 130,
    };
  });
}

function layoutSequenceParticipants(nodes: DiagramNode[]): DiagramNode[] {
  return nodes.map((node, index) => ({
    ...node,
    x: 180 + index * 260,
    y: 90,
  }));
}

function parseLayoutMeta(line: string): LayoutMeta | null {
  if (!line.startsWith(LAYOUT_META_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(LAYOUT_META_PREFIX.length).trim()) as LayoutMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function applyLayoutMeta(nodes: DiagramNode[], meta: LayoutMeta | null): DiagramNode[] {
  if (!meta?.nodes) return nodes;
  return nodes.map((node) => {
    const layout = meta.nodes?.[node.id];
    if (!layout) return node;
    return {
      ...node,
      x: readFiniteNumber(layout.x, node.x),
      y: readFiniteNumber(layout.y, node.y),
      width: Math.max(64, readFiniteNumber(layout.width, node.width)),
      height: Math.max(40, readFiniteNumber(layout.height, node.height)),
      fillColor: readColor(layout.fillColor, node.fillColor),
      strokeColor: readColor(layout.strokeColor, node.strokeColor),
      textColor: readColor(layout.textColor, node.textColor),
      strokeWidth: readStyleNumber(layout.strokeWidth, node.strokeWidth),
      textSize: readStyleNumber(layout.textSize, node.textSize),
    };
  });
}

function serializeLayoutMeta(diagram: FlowDiagram): string {
  const nodes: Record<string, NodeLayoutMeta> = {};
  for (const node of diagram.nodes) {
    nodes[node.id] = {
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
      ...(node.fillColor ? { fillColor: node.fillColor } : {}),
      ...(node.strokeColor ? { strokeColor: node.strokeColor } : {}),
      ...(node.textColor ? { textColor: node.textColor } : {}),
      ...(node.strokeWidth ? { strokeWidth: node.strokeWidth } : {}),
      ...(node.textSize ? { textSize: node.textSize } : {}),
    };
  }
  const meta: LayoutMeta = { nodes };
  const edges = serializeEdgeMeta(diagram.edges);
  if (Object.keys(edges).length > 0) meta.edges = edges;
  if (diagram.freeLines.length > 0) meta.freeLines = diagram.freeLines.map((line) => ({ ...line }));
  return `${LAYOUT_META_PREFIX} ${JSON.stringify(meta)}`;
}

function applyEdgeMeta(edges: DiagramEdge[], meta: LayoutMeta | null): void {
  if (!meta?.edges) return;
  for (const edge of edges) {
    const layout = meta.edges[edge.id];
    if (!layout) continue;
    edge.route = readEdgeRoute(layout.route, edge.route);
    edge.labelOffsetX = readFiniteNumber(layout.labelOffsetX, edge.labelOffsetX ?? 0);
    edge.labelOffsetY = readFiniteNumber(layout.labelOffsetY, edge.labelOffsetY ?? 0);
    edge.strokeColor = readColor(layout.strokeColor, edge.strokeColor);
    edge.textColor = readColor(layout.textColor, edge.textColor);
    edge.strokeWidth = readStyleNumber(layout.strokeWidth, edge.strokeWidth);
    edge.textSize = readStyleNumber(layout.textSize, edge.textSize);
  }
}

function serializeEdgeMeta(edges: DiagramEdge[]): Record<string, EdgeLayoutMeta> {
  const meta: Record<string, EdgeLayoutMeta> = {};
  for (const edge of edges) {
    const route = readEdgeRoute(edge.route, "curve");
    const labelOffsetX = Math.round(readFiniteNumber(edge.labelOffsetX, 0));
    const labelOffsetY = Math.round(readFiniteNumber(edge.labelOffsetY, 0));
    const strokeColor = readColor(edge.strokeColor, undefined);
    const textColor = readColor(edge.textColor, undefined);
    const strokeWidth = readStyleNumber(edge.strokeWidth, undefined);
    const textSize = readStyleNumber(edge.textSize, undefined);
    const hasMeta = route !== "curve" || labelOffsetX !== 0 || labelOffsetY !== 0 || Boolean(strokeColor || textColor || strokeWidth || textSize);
    if (!hasMeta) continue;
    meta[edge.id] = { route, labelOffsetX, labelOffsetY, ...(strokeColor ? { strokeColor } : {}), ...(textColor ? { textColor } : {}), ...(strokeWidth ? { strokeWidth } : {}), ...(textSize ? { textSize } : {}) };
  }
  return meta;
}

function readFreeLines(meta: LayoutMeta | null): DiagramFreeLine[] {
  if (!Array.isArray(meta?.freeLines)) return [];
  return meta.freeLines
    .filter((line) => line && typeof line.id === "string")
    .map((line, index) => ({
      id: line.id || `line-${index + 1}`,
      x1: readFiniteNumber(line.x1, 0),
      y1: readFiniteNumber(line.y1, 0),
      x2: readFiniteNumber(line.x2, 120),
      y2: readFiniteNumber(line.y2, 0),
      label: typeof line.label === "string" ? line.label : "",
      style: ["line", "arrow", "dotted", "thick"].includes(line.style) ? line.style : "line",
      route: readEdgeRoute(line.route, "curve"),
      labelOffsetX: readFiniteNumber(line.labelOffsetX, 0),
      labelOffsetY: readFiniteNumber(line.labelOffsetY, 0),
      strokeColor: readColor(line.strokeColor, undefined),
      textColor: readColor(line.textColor, undefined),
      strokeWidth: readStyleNumber(line.strokeWidth, undefined),
      textSize: readStyleNumber(line.textSize, undefined),
    }));
}

function readEdgeRoute(value: unknown, fallback: EdgeRoute | undefined): EdgeRoute | undefined {
  return value === "curve" || value === "straight" || value === "elbow" ? value : fallback;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function applyStateClassStyle(nodeMap: Map<string, DiagramNode>, id: string, style: VisualStyleMeta | undefined): boolean {
  if (!style) return false;
  const node = nodeMap.get(id) ?? ensureNode(nodeMap, id, `[${id}]`);
  node.fillColor = style.fillColor ?? node.fillColor;
  node.strokeColor = style.strokeColor ?? node.strokeColor;
  node.textColor = style.textColor ?? node.textColor;
  node.strokeWidth = style.strokeWidth ?? node.strokeWidth;
  node.textSize = style.textSize ?? node.textSize;
  return true;
}

function applyNodeColorStyle(nodeMap: Map<string, DiagramNode>, id: string, style: string): boolean {
  const node = nodeMap.get(id);
  if (!node) return false;
  const visualStyle = parseColorStyle(style, true);
  if (!visualStyle) return false;
  node.fillColor = visualStyle.fillColor ?? node.fillColor;
  node.strokeColor = visualStyle.strokeColor ?? node.strokeColor;
  node.textColor = visualStyle.textColor ?? node.textColor;
  node.strokeWidth = visualStyle.strokeWidth ?? node.strokeWidth;
  node.textSize = visualStyle.textSize ?? node.textSize;
  return true;
}

function applyEdgeColorStyle(edges: DiagramEdge[], index: number, style: string): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  const edge = edges[index];
  if (!edge) return false;
  const visualStyle = parseColorStyle(style, false);
  if (!visualStyle) return false;
  edge.strokeColor = visualStyle.strokeColor ?? edge.strokeColor;
  edge.textColor = visualStyle.textColor ?? edge.textColor;
  edge.strokeWidth = visualStyle.strokeWidth ?? edge.strokeWidth;
  edge.textSize = visualStyle.textSize ?? edge.textSize;
  return true;
}

function parseColorStyle(style: string, allowFill: boolean): VisualStyleMeta | null {
  const parsed: VisualStyleMeta = {};
  const declarations = style.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  if (declarations.length === 0) return null;
  for (const declaration of declarations) {
    const match = declaration.match(/^([A-Za-z-]+)\s*:\s*(#[0-9a-f]{3}(?:[0-9a-f]{3})?|\d+(?:\.\d+)?(?:px)?)$/i);
    if (!match) return null;
    const property = match[1].toLowerCase();
    const value = match[2];
    if (property === "fill" && allowFill && isColorValue(value)) parsed.fillColor = value;
    else if (property === "stroke" && isColorValue(value)) parsed.strokeColor = value;
    else if (property === "color" && isColorValue(value)) parsed.textColor = value;
    else if (property === "stroke-width") parsed.strokeWidth = readStyleNumber(value, undefined);
    else if (property === "font-size") parsed.textSize = readStyleNumber(value, undefined);
    else return null;
  }
  return parsed;
}

function readColor(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && isColorValue(value) ? value : fallback;
}

function readStyleNumber(value: unknown, fallback: number | undefined): number | undefined {
  const raw = typeof value === "string" ? Number(value.replace(/px$/i, "")) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const rounded = Math.round(raw * 10) / 10;
  return rounded > 0 ? rounded : fallback;
}

function isColorValue(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
}

function serializeFlowchartStyleLines(diagram: FlowDiagram): string[] {
  if (diagram.syntax !== "flowchart") return [];
  const lines: string[] = [];
  for (const node of diagram.nodes) {
    const styles = [
      node.fillColor ? `fill:${node.fillColor}` : "",
      node.strokeColor ? `stroke:${node.strokeColor}` : "",
      node.textColor ? `color:${node.textColor}` : "",
      node.strokeWidth ? `stroke-width:${node.strokeWidth}px` : "",
      node.textSize ? `font-size:${node.textSize}px` : "",
    ].filter(Boolean);
    if (styles.length > 0) lines.push(`  style ${node.id} ${styles.join(",")}`);
  }
  diagram.edges.forEach((edge, index) => {
    const styles = [
      edge.strokeColor ? `stroke:${edge.strokeColor}` : "",
      edge.textColor ? `color:${edge.textColor}` : "",
      edge.strokeWidth ? `stroke-width:${edge.strokeWidth}px` : "",
      edge.textSize ? `font-size:${edge.textSize}px` : "",
    ].filter(Boolean);
    if (styles.length > 0) lines.push(`  linkStyle ${index} ${styles.join(",")}`);
  });
  return lines;
}

function serializeStateDiagramStyleLines(diagram: FlowDiagram): string[] {
  if (diagram.syntax !== "stateDiagram") return [];
  const lines: string[] = [];
  let classIndex = 0;
  for (const node of diagram.nodes) {
    if (isStateMarker(node.id)) continue;
    const styles = [
      node.fillColor ? `fill:${node.fillColor}` : "",
      node.strokeColor ? `stroke:${node.strokeColor}` : "",
      node.textColor ? `color:${node.textColor}` : "",
      node.strokeWidth ? `stroke-width:${node.strokeWidth}px` : "",
      node.textSize ? `font-size:${node.textSize}px` : "",
    ].filter(Boolean);
    if (styles.length === 0) continue;
    const className = `${STATE_CLASSDEF_PREFIX}${classIndex}`;
    classIndex += 1;
    lines.push(`  classDef ${className} ${styles.join(",")}`);
    lines.push(`  class ${node.id} ${className}`);
  }
  return lines;
}

function extractLabel(id: string, syntax: string): string {
  let label = syntax.trim();
  if (label.startsWith("[")) label = label.slice(1, -1);
  else if (label.startsWith("{") || label.startsWith("(")) label = label.slice(1, -1);
  if (label.startsWith("(")) label = label.slice(1, -1);
  label = label.replace(/^(["'`])(.*)\1$/, "$2");
  return label.trim() || id;
}

function extractShape(syntax: string): NodeShape {
  const value = syntax.trim();
  if (value.startsWith("{")) return "diamond";
  if (value.startsWith("((")) return "circle";
  if (value.startsWith("([")) return "stadium";
  if (value.startsWith("(")) return "rounded";
  return "rectangle";
}

function formatNodeShape(node: DiagramNode): string {
  const label = sanitizeLabel(node.label);
  switch (node.shape) {
    case "diamond":
      return `{${label}}`;
    case "circle":
      return `((${label}))`;
    case "rounded":
      return `(${label})`;
    case "stadium":
      return `([${label}])`;
    default:
      return `[${label}]`;
  }
}

function formatEdge(edge: DiagramEdge): string {
  if (edge.label.trim()) {
    const label = sanitizeLabel(edge.label);
    if (edge.style === "line") return `-- ${label} ---`;
    if (edge.style === "dotted") return `-. ${label} .->`;
    if (edge.style === "thick") return `== ${label} ==>`;
    return `-- ${label} -->`;
  }
  if (edge.style === "line") return "---";
  if (edge.style === "dotted") return "-.->";
  if (edge.style === "thick") return "==>";
  return "-->";
}

function edgeStyleFromToken(token: string): DiagramEdge["style"] {
  if (token === "==>") return "thick";
  if (token === "-.->" || token === ".->") return "dotted";
  if (token === "---") return "line";
  return "arrow";
}

function sanitizeLabel(label: string): string {
  return label.replace(/[\r\n[\]{}]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function sanitizeStateLabel(label: string): string {
  return label.replace(/[\r\n"]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function sanitizeSequenceText(label: string): string {
  return label.replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function nextNodeId(existingIds: string[]): string {
  const used = new Set(existingIds);
  for (let index = 0; index < 702; index++) {
    const id = toLetters(index);
    if (!used.has(id)) return id;
  }
  return `N${existingIds.length + 1}`;
}

function toLetters(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function createEdgeId(from: string, to: string, index: number): string {
  return `${from}-${to}-${index}`;
}
