export type ExportFormat = "png" | "jpg";
export type FlowDirection = "TD" | "LR" | "BT" | "RL";
export type DiagramSyntax = "flowchart" | "stateDiagram" | "sequenceDiagram";
export type NodeShape = "rectangle" | "rounded" | "stadium" | "diamond" | "circle";
export type EdgeStyle = "line" | "arrow" | "dotted" | "thick";
export type EdgeRoute = "curve" | "straight" | "elbow";

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface RenderedNodeLayout {
  id?: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedEdgeLayout {
  path: string;
}

export interface MermaidRenderedLayout {
  nodes: RenderedNodeLayout[];
  edges: RenderedEdgeLayout[];
}

export interface MermaidBlockContext {
  sourcePath?: string;
  lineStart?: number;
  lineEnd?: number;
  source?: string;
  blockIndex?: number;
}

export interface DiagramNode {
  id: string;
  label: string;
  shape: NodeShape;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  style: EdgeStyle;
  renderedPath?: string;
  route?: EdgeRoute;
  waypoints?: DiagramPoint[];
  labelOffsetX?: number;
  labelOffsetY?: number;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

export interface DiagramFreeLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  style: EdgeStyle;
  route?: EdgeRoute;
  waypoints?: DiagramPoint[];
  labelOffsetX?: number;
  labelOffsetY?: number;
  strokeColor?: string;
  textColor?: string;
  strokeWidth?: number;
  textSize?: number;
}

export interface FlowDiagram {
  syntax: DiagramSyntax;
  direction: FlowDirection;
  directives: string[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  freeLines: DiagramFreeLine[];
  unsupportedLines: string[];
}
