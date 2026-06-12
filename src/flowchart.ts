import type { DiagramEdge, DiagramFreeLine, DiagramNode, FlowDiagram, FlowDirection, NodeShape } from "./types";

const DIRECTION_PATTERN = /^(?:flowchart|graph)\s+(TD|LR|BT|RL)\s*$/i;
const STATE_DIAGRAM_PATTERN = /^stateDiagram(?:-v2)?\s*$/i;
const STATE_EDGE_PATTERN = /^\s*(\[\*\]|[A-Za-z][\w-]*)\s*-->\s*(\[\*\]|[A-Za-z][\w-]*)(?:\s*:\s*(.+))?\s*$/;
const STATE_NODE_PATTERN = /^\s*state\s+"([^"]+)"\s+as\s+([A-Za-z][\w-]*)\s*$/i;
const SEQUENCE_DIAGRAM_PATTERN = /^sequenceDiagram\s*$/i;
const SEQUENCE_PARTICIPANT_PATTERN = /^\s*(?:participant|actor)\s+([A-Za-z][\w-]*)(?:\s+as\s+(.+))?\s*$/i;
const SEQUENCE_MESSAGE_PATTERN = /^\s*([A-Za-z][\w-]*?)\s*(-{1,2}>>|-->|->)\s*([A-Za-z][\w-]*)\s*:\s*(.+)\s*$/;
const LABELLED_EDGE_PATTERN = /^\s*([A-Za-z][\w-]*)(?:\s*(\[[^\]]+\]|\([^)]*\)|\{[^}]+\}))?\s*(--|-.|==)\s*(.+?)\s*(-->|---|\.->|==>)\s*([A-Za-z][\w-]*)(?:\s*(\[[^\]]+\]|\([^)]*\)|\{[^}]+\}))?\s*$/;
const EDGE_PATTERN = /^\s*([A-Za-z][\w-]*)(?:\s*(\[[^\]]+\]|\([^)]*\)|\{[^}]+\}))?\s*(?:(-->|---|==>|-.->)\s*(?:\|([^|]+)\|)?|--\s*([^\-|]+?)\s*-->)\s*([A-Za-z][\w-]*)(?:\s*(\[[^\]]+\]|\([^)]*\)|\{[^}]+\}))?\s*$/;
const NODE_PATTERN = /^\s*([A-Za-z][\w-]*)\s*(\[[^\]]+\]|\([^)]*\)|\{[^}]+\})\s*$/;
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
}

interface LayoutMeta {
  nodes?: Record<string, NodeLayoutMeta>;
  freeLines?: DiagramFreeLine[];
}

export function parseFlowchart(source: string, fallbackDirection: FlowDirection): FlowDiagram {
  const diagram: FlowDiagram = {
    syntax: "flowchart",
    direction: fallbackDirection,
    nodes: [],
    edges: [],
    freeLines: [],
    unsupportedLines: [],
  };
  const nodeMap = new Map<string, DiagramNode>();
  let layoutMeta: LayoutMeta | null = null;

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let sawHeader = false;

  for (const line of lines) {
    if (line.startsWith("%%")) {
      const meta = parseLayoutMeta(line);
      if (meta) {
        layoutMeta = meta;
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

    if (diagram.syntax === "stateDiagram") {
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
  diagram.freeLines = readFreeLines(layoutMeta);
  return diagram;
}

export function generateFlowchart(diagram: FlowDiagram, includeLayout = true): string {
  if (diagram.syntax === "stateDiagram") return generateStateDiagram(diagram, includeLayout);
  if (diagram.syntax === "sequenceDiagram") return generateSequenceDiagram(diagram, includeLayout);

  const lines = [`flowchart ${diagram.direction}`];
  if (includeLayout) lines.push(`  ${serializeLayoutMeta(diagram)}`);

  for (const node of diagram.nodes) {
    lines.push(`  ${node.id}${formatNodeShape(node)}`);
  }

  if (diagram.nodes.length > 0 && diagram.edges.length > 0) lines.push("");

  for (const edge of diagram.edges) {
    lines.push(`  ${edge.from} ${formatEdge(edge)} ${edge.to}`);
  }

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
    nodes: diagram.nodes.map((node) => ({ ...node })),
    edges: diagram.edges.map((edge) => ({ ...edge })),
    freeLines: diagram.freeLines.map((line) => ({ ...line })),
    unsupportedLines: [...diagram.unsupportedLines],
  };
}

function generateStateDiagram(diagram: FlowDiagram, includeLayout: boolean): string {
  const lines = ["stateDiagram-v2"];
  if (includeLayout) lines.push(`  ${serializeLayoutMeta(diagram)}`);

  const connectedIds = new Set<string>();
  for (const edge of diagram.edges) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  for (const node of diagram.nodes) {
    if (isStateMarker(node.id) || connectedIds.has(node.id)) continue;
    lines.push(`  state "${sanitizeStateLabel(node.label)}" as ${node.id}`);
  }

  for (const edge of diagram.edges) {
    const label = edge.label.trim() ? `: ${sanitizeStateLabel(edge.label)}` : "";
    lines.push(`  ${formatStateEndpoint(edge.from, "from")} --> ${formatStateEndpoint(edge.to, "to")}${label}`);
  }

  if (diagram.unsupportedLines.length > 0) {
    lines.push("", "  %% Preserved unsupported lines");
    for (const line of diagram.unsupportedLines) lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function generateSequenceDiagram(diagram: FlowDiagram, includeLayout: boolean): string {
  const lines = ["sequenceDiagram"];
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
    };
  });
}

function serializeLayoutMeta(diagram: FlowDiagram): string {
  const nodes: Record<string, Required<NodeLayoutMeta>> = {};
  for (const node of diagram.nodes) {
    nodes[node.id] = {
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
    };
  }
  const meta: LayoutMeta = { nodes };
  if (diagram.freeLines.length > 0) meta.freeLines = diagram.freeLines.map((line) => ({ ...line }));
  return `${LAYOUT_META_PREFIX} ${JSON.stringify(meta)}`;
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
    }));
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extractLabel(id: string, syntax: string): string {
  let label = syntax.trim();
  if (label.startsWith("[")) label = label.slice(1, -1);
  else if (label.startsWith("{") || label.startsWith("(")) label = label.slice(1, -1);
  if (label.startsWith("(")) label = label.slice(1, -1);
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
      return `(( ${label} ))`;
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
  return label.replace(/[\r\n\[\]{}]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
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
