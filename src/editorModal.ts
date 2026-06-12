import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import { cloneDiagram, createEdge, createNode, generateFlowchart, parseFlowchart } from "./flowchart";
import { ensureLiquidGlassFilter } from "./liquidGlass";
import type { DiagramEdge, DiagramFreeLine, DiagramNode, EdgeStyle, FlowDiagram, FlowDirection, MermaidRenderedLayout, NodeShape } from "./types";

const BASE_CANVAS_WIDTH = 980;
const BASE_CANVAS_HEIGHT = 680;
const CANVAS_PADDING = 220;
const NODE_EDGE_PADDING = 60;
const MIN_EDITOR_ZOOM = 0.4;
const MAX_EDITOR_ZOOM = 2.5;
const EDITOR_ZOOM_STEP = 0.15;
const SNAP_SIZE = 20;
const MIN_NODE_WIDTH = 80;
const MIN_NODE_HEIGHT = 44;
const CONNECT_TARGET_REVEAL_DISTANCE = 46;
const SEQUENCE_TOP_Y = 82;
const SEQUENCE_MESSAGE_START_Y = 176;
const SEQUENCE_MESSAGE_GAP = 62;
const SEQUENCE_BOTTOM_PADDING = 96;

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "freeLine"; id: string } | null;
type ShapePlacement = { shape: NodeShape; nodeId?: string };
type ConnectorTool = { style: EdgeStyle } | undefined;
type CanvasPoint = { x: number; y: number };
type ConnectionHandle = "top" | "right" | "bottom" | "left";
type ResizeHandle = "nw" | "ne" | "se" | "sw";

interface ResizeState {
  nodeId: string;
  handle: ResizeHandle;
  startPointer: CanvasPoint;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface ReconnectState {
  edgeId: string;
  endpoint: "from" | "to";
  fixedNodeId: string;
}

interface FreeLineDraft {
  style: EdgeStyle;
  start: CanvasPoint;
  current: CanvasPoint;
}

export class MermaidEditorModal extends Modal {
  private diagram: FlowDiagram;
  private selection: Selection = null;
  private stage?: HTMLElement;
  private canvas?: SVGSVGElement;
  private zoomLabel?: HTMLElement;
  private inspector?: HTMLElement;
  private codePreview?: HTMLTextAreaElement;
  private draggingNodeId?: string;
  private dragOffset = { x: 0, y: 0 };
  private connectingFromNodeId?: string;
  private connectingPoint?: CanvasPoint;
  private connectTargetNodeId?: string;
  private connectTargetHandle?: ConnectionHandle;
  private selectedShape?: NodeShape;
  private selectedConnector?: ConnectorTool;
  private previewPoint?: CanvasPoint;
  private placement?: ShapePlacement;
  private freeLineDraft?: FreeLineDraft;
  private removePlacementListeners?: () => void;
  private removeNodeDragListeners?: () => void;
  private removeConnectionListeners?: () => void;
  private removeResizeListeners?: () => void;
  private removeFreeLineListeners?: () => void;
  private resizeState?: ResizeState;
  private reconnectState?: ReconnectState;
  private suppressNextCanvasClick = false;
  private suppressNextPaletteClick = false;
  private editorZoom = 1;

  constructor(
    app: App,
    source: string,
    fallbackDirection: FlowDirection,
    private readonly onSave: (nextSource: string) => Promise<void>,
    renderedLayout?: MermaidRenderedLayout,
  ) {
    super(app);
    this.diagram = parseFlowchart(source, fallbackDirection);
    if (renderedLayout) this.applyRenderedLayout(renderedLayout);
  }

  onOpen(): void {
    ensureLiquidGlassFilter(this.containerEl.ownerDocument);
    this.modalEl.addClass("owen-mermaid-editor-modal");
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-editor-shell" });
    const header = shell.createDiv({ cls: "owen-mermaid-editor-header" });
    header.createEl("div", { cls: "owen-mermaid-editor-title", text: "Owen Mermaid" });

    const actions = header.createDiv({ cls: "owen-mermaid-editor-actions" });
    this.createButton(actions, "rotate-ccw", "Auto layout", () => this.autoLayout());
    this.createButton(actions, "save", "Apply", () => void this.save());
    this.createButton(actions, "x", "Close", () => this.close());

    const ribbon = shell.createDiv({ cls: "owen-mermaid-editor-ribbon" });
    this.renderPalette(ribbon);

    const body = shell.createDiv({ cls: "owen-mermaid-editor-body" });
    this.stage = body.createDiv({ cls: "owen-mermaid-editor-stage" });
    this.renderStageZoomControls(this.stage);
    this.canvas = this.stage.createSvg("svg", { cls: "owen-mermaid-canvas" });
    this.bindCanvas(this.canvas);

    this.inspector = body.createDiv({ cls: "owen-mermaid-inspector" });
    this.render();
  }

  onClose(): void {
    this.cancelShapePlacement();
    this.endDrag();
    this.endResize();
    this.endConnectionDrag();
    this.endFreeLineDraw();
    this.contentEl.empty();
  }

  private applyRenderedLayout(layout: MermaidRenderedLayout): void {
    if (this.diagram.syntax === "sequenceDiagram" || layout.nodes.length === 0) return;
    const used = new Set<number>();
    const matches: Array<{ node: DiagramNode; layout: MermaidRenderedLayout["nodes"][number] }> = [];
    for (const node of this.diagram.nodes) {
      const matchIndex = this.findRenderedLayoutMatch(node, layout, used);
      if (matchIndex === -1) continue;
      const match = layout.nodes[matchIndex];
      used.add(matchIndex);
      matches.push({ node, layout: match });
    }

    if (matches.length === 0) return;
    for (const { node, layout: match } of matches) {
      node.x = Math.round(match.x);
      node.y = Math.round(match.y);
      node.width = Math.max(80, Math.round(match.width));
      node.height = Math.max(44, Math.round(match.height));
    }
    this.diagram.freeLines = [];
    layout.edges.forEach((edge, index) => {
      if (this.diagram.edges[index]) this.diagram.edges[index].renderedPath = edge.path;
    });
  }

  private findRenderedLayoutMatch(node: DiagramNode, layout: MermaidRenderedLayout, used: Set<number>): number {
    const idIndex = layout.nodes.findIndex((item, index) => !used.has(index) && item.id === node.id);
    if (idIndex >= 0) return idIndex;
    const normalizedLabel = this.normalizeText(node.label);
    return layout.nodes.findIndex((item, index) => !used.has(index) && this.normalizeText(item.label ?? "") === normalizedLabel);
  }

  private normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  private renderPalette(parent: HTMLElement): void {
    const shapesGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    shapesGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Shapes" });
    const shapeButtons = shapesGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    const shapes: Array<{ shape: NodeShape; label: string; icon: string }> = [
      { shape: "rectangle", label: "Rectangle", icon: "square" },
      { shape: "rounded", label: "Rounded", icon: "box" },
      { shape: "stadium", label: "Stadium", icon: "pill" },
      { shape: "diamond", label: "Decision", icon: "diamond" },
      { shape: "circle", label: "Circle", icon: "circle" },
    ];

    for (const item of shapes) {
      const button = shapeButtons.createEl("button", {
        cls: "owen-mermaid-palette-item",
        attr: { type: "button", "data-shape": item.shape, "aria-pressed": "false", title: `${item.label}: click, then click the canvas. You can also drag it onto the canvas.` },
      });
      setIcon(button, item.icon);
      button.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: item.label });
      button.addEventListener("pointerdown", (event) => this.beginShapePlacement(item.shape, event));
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (this.suppressNextPaletteClick) {
          this.suppressNextPaletteClick = false;
          return;
        }
        if (event.detail === 0) this.placeShapeAtCenter(item.shape);
        else this.setSelectedShapeTool(item.shape);
      });
    }

    const connectorGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    connectorGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Connect" });
    const connectorButtons = connectorGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    const connectors: Array<{ style: EdgeStyle; label: string; icon: string }> = [
      { style: "arrow", label: "Arrow", icon: "arrow-right" },
      { style: "line", label: "Line", icon: "minus" },
      { style: "dotted", label: "Dotted", icon: "ellipsis" },
    ];
    for (const item of connectors) {
      const button = connectorButtons.createEl("button", {
        cls: "owen-mermaid-palette-item owen-mermaid-connector-tool",
        attr: { type: "button", "data-connector-style": item.style, "aria-pressed": "false", title: `${item.label}: click, then choose two shapes.` },
      });
      setIcon(button, item.icon);
      button.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: item.label });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        this.setConnectorTool(item.style);
      });
    }

    const diagramGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    diagramGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Diagram" });
    const direction = diagramGroup.createEl("select", { cls: "owen-mermaid-select owen-mermaid-direction-select" });
    for (const value of ["LR", "TD", "RL", "BT"] as FlowDirection[]) {
      direction.createEl("option", { text: value, value });
    }
    direction.value = this.diagram.direction;
    direction.addEventListener("change", () => {
      this.diagram.direction = direction.value as FlowDirection;
      this.autoLayout();
    });
  }

  private bindCanvas(canvas: SVGSVGElement): void {
    canvas.addEventListener("pointermove", (event) => {
      this.updateSelectedShapePreview(event);
      this.updateConnectionPreview(event);
    });
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.selectedConnector || event.target !== canvas) return;
      this.beginFreeLineDraw(event);
    });
    canvas.addEventListener("pointerleave", () => {
      this.clearShapePreview();
    });
    canvas.addEventListener("click", (event) => {
      if (this.suppressNextCanvasClick) {
        this.suppressNextCanvasClick = false;
        return;
      }
      if (event.target === canvas) {
        if (this.connectingFromNodeId) {
          this.clearConnectionMode();
          this.render();
          return;
        }
        if (this.selectedShape) {
          this.placeSelectedShape(event);
          return;
        }
        this.selection = null;
        this.render();
      }
    });
  }

  private render(): void {
    this.renderCanvas();
    this.renderInspector();
    this.updateCodePreview();
  }

  private renderCanvas(): void {
    if (!this.canvas) return;
    this.applyCanvasViewport();
    this.canvas.empty();
    if (this.diagram.syntax === "sequenceDiagram") {
      this.renderSequenceCanvas();
      return;
    }

    const defs = this.canvas.createSvg("defs");
    const marker = defs.createSvg("marker", {
      attr: { id: "owen-mermaid-arrow", markerWidth: "10", markerHeight: "10", refX: "9", refY: "3", orient: "auto", markerUnits: "strokeWidth" },
    });
    marker.createSvg("path", { attr: { d: "M0,0 L0,6 L9,3 z", class: "owen-mermaid-arrow-head" } });

    const edges = this.canvas.createSvg("g", { cls: "owen-mermaid-edges" });
    for (const edge of this.diagram.edges) this.renderEdge(edges, edge);
    this.renderFreeLines(edges);
    this.renderConnectionPreview(edges);
    this.renderFreeLineDraft(edges);

    const nodes = this.canvas.createSvg("g", { cls: "owen-mermaid-nodes" });
    for (const node of this.diagram.nodes) this.renderNode(nodes, node);
    this.renderShapePreview(nodes);
  }

  private renderSequenceCanvas(): void {
    if (!this.canvas) return;
    const defs = this.canvas.createSvg("defs");
    const marker = defs.createSvg("marker", {
      attr: { id: "owen-mermaid-arrow", markerWidth: "10", markerHeight: "10", refX: "9", refY: "3", orient: "auto", markerUnits: "strokeWidth" },
    });
    marker.createSvg("path", { attr: { d: "M0,0 L0,6 L9,3 z", class: "owen-mermaid-arrow-head" } });

    const participants = this.canvas.createSvg("g", { cls: "owen-mermaid-sequence-participants" });
    const messages = this.canvas.createSvg("g", { cls: "owen-mermaid-sequence-messages" });
    const bottomY = this.getSequenceBottomY();

    for (const node of this.diagram.nodes) {
      const selected = this.selection?.kind === "node" && this.selection.id === node.id;
      const lifeline = participants.createSvg("line", {
        cls: "owen-mermaid-sequence-lifeline",
        attr: { x1: String(node.x), y1: String(SEQUENCE_TOP_Y + node.height / 2), x2: String(node.x), y2: String(bottomY - node.height / 2) },
      });
      if (selected) lifeline.addClass("is-selected");
      lifeline.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selection = { kind: "node", id: node.id };
        this.render();
      });
      lifeline.addEventListener("contextmenu", (event) => this.showNodeMenu(event, node));
      lifeline.addEventListener("dblclick", () => this.promptNodeLabel(node));
    }

    for (const edge of this.diagram.edges) this.renderSequenceMessage(messages, edge);
    this.renderFreeLines(messages);
    this.renderFreeLineDraft(messages);

    for (const node of this.diagram.nodes) {
      this.renderSequenceParticipant(participants, node, SEQUENCE_TOP_Y);
      this.renderSequenceParticipant(participants, node, bottomY);
    }
  }

  private renderSequenceParticipant(parent: SVGGElement, node: DiagramNode, y: number): void {
    const selected = this.selection?.kind === "node" && this.selection.id === node.id;
    const group = parent.createSvg("g", { cls: "owen-mermaid-sequence-participant" });
    if (selected) group.addClass("is-selected");
    group.setAttribute("transform", `translate(${node.x}, ${y})`);
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.selectedConnector) {
        if (this.connectingFromNodeId) this.handleConnectorToolNodeClick(node.id);
        else this.beginConnectionDrag(node.id, event);
        return;
      }
      this.selection = { kind: "node", id: node.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showNodeMenu(event, node));
    group.addEventListener("dblclick", () => this.promptNodeLabel(node));
    group.createSvg("rect", { attr: { x: String(-node.width / 2), y: String(-node.height / 2), width: String(node.width), height: String(node.height), rx: "7" } });
    group.createSvg("text", { attr: { x: "0", y: "5", "text-anchor": "middle" } }).setText(node.label);
  }

  private renderSequenceMessage(parent: SVGGElement, edge: DiagramEdge): void {
    const from = this.diagram.nodes.find((node) => node.id === edge.from);
    const to = this.diagram.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return;

    const selected = this.selection?.kind === "edge" && this.selection.id === edge.id;
    const index = this.diagram.edges.indexOf(edge);
    const y = SEQUENCE_MESSAGE_START_Y + index * SEQUENCE_MESSAGE_GAP;
    const direction = from.x <= to.x ? 1 : -1;
    const startX = from.x + direction * 4;
    const endX = to.x - direction * 4;
    const labelX = (startX + endX) / 2;
    const group = parent.createSvg("g", { cls: "owen-mermaid-sequence-message" });
    if (edge.style === "dotted") group.addClass("is-dotted");
    if (selected) group.addClass("is-selected");
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: `M ${startX} ${y} L ${endX} ${y}`, fill: "none" } });
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: `M ${startX} ${y} L ${endX} ${y}`, fill: "none", "marker-end": "url(#owen-mermaid-arrow)" } });
    group
      .createSvg("text", { cls: "owen-mermaid-sequence-message-label", attr: { x: String(labelX), y: String(y - 16), "text-anchor": "middle" } })
      .setText(edge.label);
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.selection = { kind: "edge", id: edge.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showEdgeMenu(event, edge));
    group.addEventListener("dblclick", () => this.promptEdgeLabel(edge));
  }

  private renderNode(parent: SVGGElement, node: DiagramNode): void {
    const selected = this.selection?.kind === "node" && this.selection.id === node.id;
    const connectingSource = this.connectingFromNodeId === node.id;
    const connectTarget = this.connectTargetNodeId === node.id;
    const group = parent.createSvg("g", {
      cls: "owen-mermaid-node",
      attr: { tabindex: "0" },
    });
    if (selected) group.addClass("is-selected");
    if (connectingSource) group.addClass("is-connecting-source");
    if (connectTarget) group.addClass("is-connect-target");
    group.setAttribute("transform", `translate(${node.x}, ${node.y})`);
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.selectedConnector) {
        if (this.connectingFromNodeId) this.handleConnectorToolNodeClick(node.id);
        else this.beginConnectionDrag(node.id, event);
        return;
      }
      this.setSelectedShapeTool(undefined);
      if (this.connectingFromNodeId) {
        this.finishConnectionTo(node.id);
        return;
      }
      this.selection = { kind: "node", id: node.id };
      this.beginNodeDrag(node, event);
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showNodeMenu(event, node));
    group.addEventListener("dblclick", () => this.promptNodeLabel(node));

    this.createShape(group, node);
    group.createSvg("text", { attr: { x: "0", y: "5", "text-anchor": "middle" } }).setText(node.label);
    if (selected || connectingSource || connectTarget) this.renderNodeHandles(group, node, connectTarget ? this.connectTargetHandle : undefined, !connectTarget);
  }

  private createShape(group: SVGGElement, node: DiagramNode): void {
    const width = node.width;
    const height = node.height;
    if (node.shape === "diamond") {
      group.createSvg("polygon", { attr: { points: `0,${-height / 2} ${width / 2},0 0,${height / 2} ${-width / 2},0` } });
      return;
    }
    if (node.shape === "circle") {
      group.createSvg("ellipse", { attr: { cx: "0", cy: "0", rx: String(width / 2), ry: String(height / 2) } });
      return;
    }

    const radius = node.shape === "rounded" ? Math.min(12, height / 2) : node.shape === "stadium" ? height / 2 : 6;
    group.createSvg("rect", { attr: { x: String(-width / 2), y: String(-height / 2), width: String(width), height: String(height), rx: String(radius) } });
  }

  private renderNodeHandles(group: SVGGElement, node: DiagramNode, snapHandle?: ConnectionHandle, includeResize = true): void {
    const handles = group.createSvg("g", { cls: "owen-mermaid-node-handles" });

    if (includeResize) {
      const moveHandle = handles.createSvg("circle", { cls: "owen-mermaid-move-handle", attr: { cx: "0", cy: String(-node.height / 2 - 20), r: "8" } });
      moveHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.setSelectedShapeTool(undefined);
        this.selection = { kind: "node", id: node.id };
        this.beginNodeDrag(node, event);
      });
    }

    for (const handle of ["top", "right", "bottom", "left"] as ConnectionHandle[]) {
      const point = this.getRelativeConnectionPoint(node, handle);
      const control = handles.createSvg("circle", { cls: "owen-mermaid-connect-handle", attr: { cx: String(point.x), cy: String(point.y), r: "7" } });
      if (snapHandle) control.addClass("is-target-anchor");
      if (snapHandle === handle) control.addClass("is-snap-target");
      control.addEventListener("pointerdown", (event) => {
        if (this.connectingFromNodeId && this.connectingFromNodeId !== node.id) {
          event.preventDefault();
          event.stopPropagation();
          this.finishConnectionTo(node.id);
          return;
        }
        this.beginConnectionDrag(node.id, event);
      });
    }

    if (!includeResize) return;

    for (const handle of ["nw", "ne", "se", "sw"] as ResizeHandle[]) {
      const point = this.getRelativeResizePoint(node, handle);
      const control = handles.createSvg("rect", {
        cls: "owen-mermaid-resize-handle",
        attr: { x: String(point.x - 5), y: String(point.y - 5), width: "10", height: "10", rx: "2" },
      });
      control.addClass(`is-${handle}`);
      control.addEventListener("pointerdown", (event) => this.beginResize(node, handle, event));
    }
  }

  private getRelativeConnectionPoint(node: DiagramNode, handle: ConnectionHandle): CanvasPoint {
    switch (handle) {
      case "top":
        return { x: 0, y: -node.height / 2 };
      case "right":
        return { x: node.width / 2, y: 0 };
      case "bottom":
        return { x: 0, y: node.height / 2 };
      case "left":
        return { x: -node.width / 2, y: 0 };
    }
  }

  private getConnectionAnchorPoint(node: DiagramNode, handle: ConnectionHandle): CanvasPoint {
    const point = this.getRelativeConnectionPoint(node, handle);
    return { x: node.x + point.x, y: node.y + point.y };
  }

  private getRelativeResizePoint(node: DiagramNode, handle: ResizeHandle): CanvasPoint {
    const x = handle.endsWith("e") ? node.width / 2 : -node.width / 2;
    const y = handle.startsWith("s") ? node.height / 2 : -node.height / 2;
    return { x, y };
  }

  private renderEdge(parent: SVGGElement, edge: DiagramEdge): void {
    const from = this.diagram.nodes.find((node) => node.id === edge.from);
    const to = this.diagram.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return;

    const selected = this.selection?.kind === "edge" && this.selection.id === edge.id;
    const group = parent.createSvg("g", { cls: "owen-mermaid-edge" });
    group.addClass(`is-${edge.style}`);
    if (selected) group.addClass("is-selected");
    const endpoints = this.getEdgeEndpoints(from, to);
    const path = edge.renderedPath ?? this.createConnectorPath(endpoints.from, endpoints.to);
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: path, fill: "none" } });
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: path, fill: "none", ...(edge.style === "line" ? {} : { "marker-end": "url(#owen-mermaid-arrow)" }) } });
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSelectedShapeTool(undefined);
      this.selection = { kind: "edge", id: edge.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showEdgeMenu(event, edge));
    if (edge.label) {
      group
        .createSvg("text", { attr: { x: String((endpoints.from.x + endpoints.to.x) / 2), y: String((endpoints.from.y + endpoints.to.y) / 2 - 8), "text-anchor": "middle" } })
        .setText(edge.label);
    }
    if (selected) this.renderEdgeEndpointHandles(group, edge, endpoints);
  }

  private renderFreeLines(parent: SVGGElement): void {
    for (const line of this.diagram.freeLines) this.renderFreeLine(parent, line);
  }

  private renderFreeLine(parent: SVGGElement, line: DiagramFreeLine): void {
    const selected = this.selection?.kind === "freeLine" && this.selection.id === line.id;
    const path = this.createConnectorPath({ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 });
    const group = parent.createSvg("g", { cls: "owen-mermaid-free-line" });
    group.addClass(`is-${line.style}`);
    if (selected) group.addClass("is-selected");
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: path, fill: "none" } });
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: path, fill: "none", ...(line.style === "line" ? {} : { "marker-end": "url(#owen-mermaid-arrow)" }) } });
    if (line.label) {
      group.createSvg("text", { attr: { x: String((line.x1 + line.x2) / 2), y: String((line.y1 + line.y2) / 2 - 8), "text-anchor": "middle" } }).setText(line.label);
    }
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSelectedShapeTool(undefined);
      this.selection = { kind: "freeLine", id: line.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showFreeLineMenu(event, line));
    group.addEventListener("dblclick", () => this.promptFreeLineLabel(line));
  }

  private renderFreeLineDraft(parent: SVGGElement): void {
    if (!this.freeLineDraft) return;
    const path = this.createConnectorPath(this.freeLineDraft.start, this.freeLineDraft.current);
    const preview = parent.createSvg("path", { cls: "owen-mermaid-connection-preview", attr: { d: path, ...(this.freeLineDraft.style === "line" ? {} : { "marker-end": "url(#owen-mermaid-arrow)" }) } });
    if (this.freeLineDraft.style === "dotted") preview.addClass("is-dotted");
    if (this.freeLineDraft.style === "thick") preview.addClass("is-thick");
  }

  private renderEdgeEndpointHandles(group: SVGGElement, edge: DiagramEdge, endpoints: { from: CanvasPoint; to: CanvasPoint }): void {
    const fromHandle = group.createSvg("circle", { cls: "owen-mermaid-edge-endpoint-handle", attr: { cx: String(endpoints.from.x), cy: String(endpoints.from.y), r: "7" } });
    fromHandle.addEventListener("pointerdown", (event) => this.beginReconnectEdge(edge, "from", event));
    const toHandle = group.createSvg("circle", { cls: "owen-mermaid-edge-endpoint-handle", attr: { cx: String(endpoints.to.x), cy: String(endpoints.to.y), r: "7" } });
    toHandle.addEventListener("pointerdown", (event) => this.beginReconnectEdge(edge, "to", event));
  }

  private renderInspector(): void {
    if (!this.inspector) return;
    this.inspector.empty();
    this.inspector.createEl("div", { cls: "owen-mermaid-section-title", text: "Inspector" });

    if (!this.selection) {
      this.renderConnectControls(this.inspector);
      this.inspector.createEl("p", { cls: "owen-mermaid-empty-state", text: "Select a node or connector." });
      this.renderCodePreview(this.inspector);
      return;
    }

    if (this.selection.kind === "node") {
      const node = this.diagram.nodes.find((item) => item.id === this.selection?.id);
      if (node) this.renderNodeInspector(this.inspector, node);
    } else if (this.selection.kind === "freeLine") {
      const line = this.diagram.freeLines.find((item) => item.id === this.selection?.id);
      if (line) this.renderFreeLineInspector(this.inspector, line);
    } else {
      const edge = this.diagram.edges.find((item) => item.id === this.selection?.id);
      if (edge) this.renderEdgeInspector(this.inspector, edge);
    }

    this.renderCodePreview(this.inspector);
  }

  private renderNodeInspector(parent: HTMLElement, node: DiagramNode): void {
    this.createTextField(parent, "ID", node.id, (value) => this.renameNode(node, value));
    this.createTextField(parent, "Text", node.label, (value) => {
      node.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const shape = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["rectangle", "rounded", "stadium", "diamond", "circle"] as NodeShape[]) shape.createEl("option", { text: value, value });
    shape.value = node.shape;
    shape.addEventListener("change", () => {
      node.shape = shape.value as NodeShape;
      this.render();
    });

    this.createDangerButton(parent, "Delete node", () => this.deleteNode(node.id));
  }

  private renderEdgeInspector(parent: HTMLElement, edge: DiagramEdge): void {
    this.createTextField(parent, "Label", edge.label, (value) => {
      edge.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const style = parent.createEl("select", { cls: "owen-mermaid-select" });
    const styles = this.diagram.syntax === "sequenceDiagram" ? (["arrow", "dotted"] as const) : (["line", "arrow", "dotted", "thick"] as const);
    for (const value of styles) style.createEl("option", { text: value, value });
    style.value = edge.style;
    style.addEventListener("change", () => {
      edge.style = style.value as DiagramEdge["style"];
      this.render();
    });

    this.createDangerButton(parent, "Delete connector", () => this.deleteEdge(edge.id));
  }

  private renderFreeLineInspector(parent: HTMLElement, line: DiagramFreeLine): void {
    this.createTextField(parent, "Label", line.label, (value) => {
      line.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const style = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["line", "arrow", "dotted", "thick"] as const) style.createEl("option", { text: value, value });
    style.value = line.style;
    style.addEventListener("change", () => {
      line.style = style.value as EdgeStyle;
      this.render();
    });

    this.createDangerButton(parent, "Delete line", () => this.deleteFreeLine(line.id));
  }

  private renderConnectControls(parent: HTMLElement): void {
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Connector" });
    const row = parent.createDiv({ cls: "owen-mermaid-connect-row" });
    const from = row.createEl("select", { cls: "owen-mermaid-select" });
    const to = row.createEl("select", { cls: "owen-mermaid-select" });
    for (const node of this.diagram.nodes) {
      from.createEl("option", { value: node.id, text: node.id });
      to.createEl("option", { value: node.id, text: node.id });
    }
    if (this.diagram.nodes[1]) to.value = this.diagram.nodes[1].id;

    const button = parent.createEl("button", { cls: "owen-mermaid-action-button", text: "Connect", attr: { type: "button" } });
    button.addEventListener("click", () => {
      if (!from.value || !to.value || from.value === to.value) return;
      const edge = createEdge(this.diagram, from.value, to.value);
      this.selection = { kind: "edge", id: edge.id };
      this.render();
    });
  }

  private renderCodePreview(parent: HTMLElement): void {
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Mermaid" });
    this.codePreview = parent.createEl("textarea", { cls: "owen-mermaid-code-preview" });
    this.codePreview.value = generateFlowchart(this.diagram);
    this.codePreview.addEventListener("change", () => {
      this.diagram = parseFlowchart(this.codePreview?.value ?? "", this.diagram.direction);
      this.selection = null;
      this.render();
    });
  }

  private createTextField(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void, live = false): void {
    const wrapper = parent.createDiv({ cls: "owen-mermaid-field" });
    wrapper.createEl("label", { text: label });
    const input = wrapper.createEl("input", { value, attr: { type: "text" } });
    if (live) input.addEventListener("input", () => onChange(input.value.trim()));
    input.addEventListener("change", () => onChange(input.value.trim()));
  }

  private createDangerButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-danger-button", text: label, attr: { type: "button" } });
    button.addEventListener("click", onClick);
  }

  private createButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-icon-button", attr: { "aria-label": label, title: label, type: "button" } });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
  }

  private promptNodeLabel(node: DiagramNode): void {
    this.selection = { kind: "node", id: node.id };
    this.render();
    this.openTextEditor("Edit node text", "Text", node.label, false, (value) => {
      node.label = value;
      this.selection = { kind: "node", id: node.id };
      this.render();
    });
  }

  private promptEdgeLabel(edge: DiagramEdge): void {
    this.selection = { kind: "edge", id: edge.id };
    this.render();
    this.openTextEditor("Edit connector label", "Label", edge.label, true, (value) => {
      edge.label = value;
      this.selection = { kind: "edge", id: edge.id };
      this.render();
    });
  }

  private promptFreeLineLabel(line: DiagramFreeLine): void {
    this.selection = { kind: "freeLine", id: line.id };
    this.render();
    this.openTextEditor("Edit line label", "Label", line.label, true, (value) => {
      line.label = value;
      this.selection = { kind: "freeLine", id: line.id };
      this.render();
    });
  }

  private openTextEditor(title: string, label: string, value: string, allowEmpty: boolean, onSubmit: (value: string) => void): void {
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.setTimeout(() => {
      new MermaidTextEditModal(this.app, title, label, value, allowEmpty, onSubmit).open();
    }, 0);
  }

  private showNodeMenu(event: MouseEvent, node: DiagramNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.selection = { kind: "node", id: node.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Edit text").setIcon("type").onClick(() => this.promptNodeLabel(node)));
    menu.addItem((item) => item.setTitle("Start connector").setIcon("move-up-right").onClick(() => this.startConnectionFrom(node.id)));
    menu.addItem((item) => item.setTitle("Duplicate shape").setIcon("copy").onClick(() => this.duplicateNode(node)));
    if (this.connectingFromNodeId) {
      menu.addItem((item) => item.setTitle("Cancel connector").setIcon("x").onClick(() => {
        this.clearConnectionMode();
        this.render();
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Delete shape").setIcon("trash").onClick(() => this.deleteNode(node.id)));
    menu.showAtMouseEvent(event);
  }

  private showEdgeMenu(event: MouseEvent, edge: DiagramEdge): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.selection = { kind: "edge", id: edge.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Edit label").setIcon("type").onClick(() => this.promptEdgeLabel(edge)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Reverse direction").setIcon("arrow-left-right").onClick(() => this.reverseEdge(edge)));
    menu.addSeparator();
    if (this.diagram.syntax !== "sequenceDiagram") {
      menu.addItem((item) => item.setTitle("Line connector").setIcon("minus").onClick(() => this.setEdgeStyle(edge, "line")));
    }
    menu.addItem((item) => item.setTitle("Arrow connector").setIcon("arrow-right").onClick(() => this.setEdgeStyle(edge, "arrow")));
    menu.addItem((item) => item.setTitle("Dotted connector").setIcon("ellipsis").onClick(() => this.setEdgeStyle(edge, "dotted")));
    if (this.diagram.syntax !== "sequenceDiagram") {
      menu.addItem((item) => item.setTitle("Thick connector").setIcon("grip-horizontal").onClick(() => this.setEdgeStyle(edge, "thick")));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Delete connector").setIcon("trash").onClick(() => this.deleteEdge(edge.id)));
    menu.showAtMouseEvent(event);
  }

  private showFreeLineMenu(event: MouseEvent, line: DiagramFreeLine): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.selection = { kind: "freeLine", id: line.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Edit label").setIcon("type").onClick(() => this.promptFreeLineLabel(line)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Line").setIcon("minus").onClick(() => this.setFreeLineStyle(line, "line")));
    menu.addItem((item) => item.setTitle("Arrow line").setIcon("arrow-right").onClick(() => this.setFreeLineStyle(line, "arrow")));
    menu.addItem((item) => item.setTitle("Dotted line").setIcon("ellipsis").onClick(() => this.setFreeLineStyle(line, "dotted")));
    menu.addItem((item) => item.setTitle("Thick line").setIcon("grip-horizontal").onClick(() => this.setFreeLineStyle(line, "thick")));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Delete line").setIcon("trash").onClick(() => this.deleteFreeLine(line.id)));
    menu.showAtMouseEvent(event);
  }

  private duplicateNode(node: DiagramNode): void {
    const copy = createNode(this.diagram, node.shape);
    copy.label = node.label;
    copy.x = node.x + 34;
    copy.y = node.y + 34;
    this.selection = { kind: "node", id: copy.id };
    this.render();
  }

  private deleteNode(nodeId: string): void {
    this.diagram.nodes = this.diagram.nodes.filter((item) => item.id !== nodeId);
    this.diagram.edges = this.diagram.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    if (this.connectingFromNodeId === nodeId) this.clearConnectionMode();
    this.selection = null;
    this.render();
  }

  private deleteEdge(edgeId: string): void {
    this.diagram.edges = this.diagram.edges.filter((item) => item.id !== edgeId);
    this.selection = null;
    this.render();
  }

  private deleteFreeLine(lineId: string): void {
    this.diagram.freeLines = this.diagram.freeLines.filter((item) => item.id !== lineId);
    this.selection = null;
    this.render();
  }

  private setEdgeStyle(edge: DiagramEdge, style: DiagramEdge["style"]): void {
    edge.style = style;
    this.selection = { kind: "edge", id: edge.id };
    this.render();
  }

  private setFreeLineStyle(line: DiagramFreeLine, style: EdgeStyle): void {
    line.style = style;
    this.selection = { kind: "freeLine", id: line.id };
    this.render();
  }

  private reverseEdge(edge: DiagramEdge): void {
    const from = edge.from;
    edge.from = edge.to;
    edge.to = from;
    this.selection = { kind: "edge", id: edge.id };
    this.render();
  }

  private renameNode(node: DiagramNode, value: string): void {
    const nextId = value.replace(/[^A-Za-z0-9_-]/g, "");
    if (!nextId || this.diagram.nodes.some((item) => item.id === nextId && item !== node)) {
      new Notice("Use a unique Mermaid node ID.");
      return;
    }
    const oldId = node.id;
    node.id = nextId;
    for (const edge of this.diagram.edges) {
      if (edge.from === oldId) edge.from = nextId;
      if (edge.to === oldId) edge.to = nextId;
    }
    this.selection = { kind: "node", id: nextId };
    this.render();
  }

  private autoLayout(): void {
    this.diagram = parseFlowchart(generateFlowchart(this.diagram, false), this.diagram.direction);
    this.render();
  }

  private async save(): Promise<void> {
    await this.onSave(generateFlowchart(this.diagram));
    new Notice("Mermaid diagram updated.");
    this.close();
  }

  private updateCodePreview(): void {
    if (this.codePreview) this.codePreview.value = generateFlowchart(this.diagram);
  }

  private renderConnectionPreview(parent: SVGGElement): void {
    if (!this.connectingFromNodeId || !this.connectingPoint) return;
    const from = this.diagram.nodes.find((node) => node.id === this.connectingFromNodeId);
    if (!from) return;
    const start = this.getBoundaryPointToward(from, this.connectingPoint);
    const path = this.createConnectorPath(start, this.connectingPoint);
    parent.createSvg("path", { attr: { class: "owen-mermaid-connection-preview", d: path, ...(this.selectedConnector?.style === "line" ? {} : { "marker-end": "url(#owen-mermaid-arrow)" }) } });
  }

  private startConnectionFrom(nodeId: string): void {
    this.setSelectedShapeTool(undefined);
    this.connectingFromNodeId = nodeId;
    const node = this.diagram.nodes.find((item) => item.id === nodeId);
    this.connectingPoint = node ? { x: node.x + 160, y: node.y } : undefined;
    this.connectTargetNodeId = undefined;
    this.connectTargetHandle = undefined;
    this.selection = { kind: "node", id: nodeId };
    this.render();
  }

  private finishConnectionTo(targetNodeId: string): void {
    if (!this.connectingFromNodeId || this.connectingFromNodeId === targetNodeId) {
      this.clearConnectionMode();
      this.render();
      return;
    }

    const existing = this.diagram.edges.find((edge) => edge.from === this.connectingFromNodeId && edge.to === targetNodeId);
    if (existing) {
      if (this.selectedConnector) existing.style = this.selectedConnector.style;
      this.selection = { kind: "edge", id: existing.id };
      this.clearConnectionMode();
      this.render();
      return;
    }

    const edge = createEdge(this.diagram, this.connectingFromNodeId, targetNodeId);
    if (this.selectedConnector) edge.style = this.selectedConnector.style;
    this.selection = { kind: "edge", id: edge.id };
    this.clearConnectionMode();
    this.render();
  }

  private updateConnectionPreview(event: PointerEvent): void {
    if (!this.connectingFromNodeId || !this.canvas || !this.isPointerInsideCanvas(event)) return;
    const point = this.toCanvasPoint(event);
    const target = this.findConnectionTargetAtPoint(point, this.connectingFromNodeId);
    this.connectTargetNodeId = target?.node.id;
    this.connectTargetHandle = target?.handle;
    this.connectingPoint = target ? this.getConnectionAnchorPoint(target.node, target.handle) : point;
    this.renderCanvas();
  }

  private clearConnectionMode(): void {
    this.connectingFromNodeId = undefined;
    this.connectingPoint = undefined;
    this.connectTargetNodeId = undefined;
    this.connectTargetHandle = undefined;
  }

  private beginConnectionDrag(fromNodeId: string, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endConnectionDrag();
    this.setSelectedShapeTool(undefined);
    this.connectingFromNodeId = fromNodeId;
    this.connectingPoint = this.toCanvasPoint(event);
    this.connectTargetNodeId = undefined;
    this.connectTargetHandle = undefined;

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateConnectionPreview(moveEvent);
    const up = (upEvent: PointerEvent) => this.finishConnectionDrag(upEvent);
    const cancel = () => {
      this.endConnectionDrag();
      this.clearConnectionMode();
      this.render();
    };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", cancel, { once: true });
    this.removeConnectionListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
    };
    this.render();
  }

  private finishConnectionDrag(event: PointerEvent): void {
    this.endConnectionDrag();
    if (!this.connectingFromNodeId) return;
    const target = this.findConnectionTargetAtPoint(this.toCanvasPoint(event), this.connectingFromNodeId)?.node;
    if (target) this.finishConnectionTo(target.id);
    else {
      if (this.selectedConnector && this.connectingFromNodeId) {
        const source = this.diagram.nodes.find((node) => node.id === this.connectingFromNodeId);
        this.connectingPoint = source ? { x: source.x + source.width / 2 + 80, y: source.y } : undefined;
        this.connectTargetNodeId = undefined;
        this.connectTargetHandle = undefined;
        this.selection = { kind: "node", id: this.connectingFromNodeId };
        this.render();
        return;
      }
      this.clearConnectionMode();
      this.render();
    }
  }

  private endConnectionDrag(): void {
    this.removeConnectionListeners?.();
    this.removeConnectionListeners = undefined;
  }

  private beginReconnectEdge(edge: DiagramEdge, endpoint: "from" | "to", event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endConnectionDrag();
    const fixedNodeId = endpoint === "from" ? edge.to : edge.from;
    this.reconnectState = { edgeId: edge.id, endpoint, fixedNodeId };
    this.connectingFromNodeId = fixedNodeId;
    this.connectingPoint = this.toCanvasPoint(event);
    this.connectTargetNodeId = undefined;
    this.connectTargetHandle = undefined;

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateConnectionPreview(moveEvent);
    const up = (upEvent: PointerEvent) => this.finishReconnectEdge(upEvent);
    const cancel = () => {
      this.endConnectionDrag();
      this.reconnectState = undefined;
      this.clearConnectionMode();
      this.render();
    };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", cancel, { once: true });
    this.removeConnectionListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
    };
    this.render();
  }

  private finishReconnectEdge(event: PointerEvent): void {
    this.endConnectionDrag();
    const state = this.reconnectState;
    if (!state) return;
    const target = this.findConnectionTargetAtPoint(this.toCanvasPoint(event), state.fixedNodeId)?.node;
    const edge = this.diagram.edges.find((item) => item.id === state.edgeId);
    if (edge && target) {
      if (state.endpoint === "from") edge.from = target.id;
      else edge.to = target.id;
      this.selection = { kind: "edge", id: edge.id };
    }
    this.reconnectState = undefined;
    this.clearConnectionMode();
    this.render();
  }

  private renderShapePreview(parent: SVGGElement): void {
    if (!this.selectedShape || !this.previewPoint) return;
    const group = parent.createSvg("g", { cls: "owen-mermaid-node-preview" });
    group.setAttribute("transform", `translate(${this.previewPoint.x}, ${this.previewPoint.y})`);
    this.createShape(group, {
      id: "preview",
      label: "",
      shape: this.selectedShape,
      x: this.previewPoint.x,
      y: this.previewPoint.y,
      width: 152,
      height: 68,
    });
  }

  private setSelectedShapeTool(shape: NodeShape | undefined): void {
    this.selectedShape = shape;
    if (shape) this.selectedConnector = undefined;
    this.previewPoint = undefined;
    this.canvas?.toggleClass("is-placing", Boolean(shape));
    this.updatePaletteState();
    this.renderCanvas();
  }

  private setConnectorTool(style: EdgeStyle | undefined): void {
    this.selectedConnector = style ? { style } : undefined;
    if (style) {
      this.selectedShape = undefined;
      this.previewPoint = undefined;
      this.canvas?.removeClass("is-placing");
    }
    this.clearConnectionMode();
    this.updatePaletteState();
    this.renderCanvas();
  }

  private handleConnectorToolNodeClick(nodeId: string): void {
    if (!this.selectedConnector) return;
    if (!this.connectingFromNodeId) {
      this.connectingFromNodeId = nodeId;
      this.selection = { kind: "node", id: nodeId };
      const node = this.diagram.nodes.find((item) => item.id === nodeId);
      this.connectingPoint = node ? { x: node.x + node.width / 2 + 80, y: node.y } : undefined;
      this.render();
      return;
    }

    if (this.connectingFromNodeId === nodeId) {
      this.clearConnectionMode();
      this.render();
      return;
    }

    const existing = this.diagram.edges.find((edge) => edge.from === this.connectingFromNodeId && edge.to === nodeId);
    const edge = existing ?? createEdge(this.diagram, this.connectingFromNodeId, nodeId);
    edge.style = this.selectedConnector.style;
    this.selection = { kind: "edge", id: edge.id };
    this.clearConnectionMode();
    this.updatePaletteState();
    this.render();
  }

  private updatePaletteState(): void {
    const buttons = this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-palette-item[data-shape]");
    for (const button of Array.from(buttons)) {
      const active = button.dataset.shape === this.selectedShape;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const connectorButtons = this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-connector-tool[data-connector-style]");
    for (const button of Array.from(connectorButtons)) {
      const active = button.dataset.connectorStyle === this.selectedConnector?.style;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  private updateSelectedShapePreview(event: PointerEvent): void {
    if (!this.selectedShape || this.draggingNodeId || this.placement || !this.canvas || !this.isPointerInsideCanvas(event)) return;
    this.previewPoint = this.toBoundedCanvasPoint(event);
    this.renderCanvas();
  }

  private clearShapePreview(): void {
    if (!this.previewPoint) return;
    this.previewPoint = undefined;
    this.renderCanvas();
  }

  private placeSelectedShape(event: MouseEvent): void {
    if (!this.selectedShape) return;
    const node = createNode(this.diagram, this.selectedShape);
    const point = this.toBoundedCanvasPoint(event);
    const snapped = this.snapPoint(point);
    node.x = snapped.x;
    node.y = snapped.y;
    this.selection = { kind: "node", id: node.id };
    this.setSelectedShapeTool(undefined);
    this.render();
  }

  private renderStageZoomControls(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "owen-mermaid-editor-zoom-toolbar owen-mermaid-glass-toolbar" });
    this.createButton(toolbar, "zoom-out", "Zoom out", () => this.setEditorZoom(this.editorZoom - EDITOR_ZOOM_STEP));
    this.zoomLabel = toolbar.createSpan({ cls: "owen-mermaid-editor-zoom-label", text: "100%" });
    this.createButton(toolbar, "zoom-in", "Zoom in", () => this.setEditorZoom(this.editorZoom + EDITOR_ZOOM_STEP));
    this.createButton(toolbar, "rotate-ccw", "Reset zoom", () => this.setEditorZoom(1));
  }

  private setEditorZoom(nextZoom: number): void {
    const next = this.clamp(nextZoom, MIN_EDITOR_ZOOM, MAX_EDITOR_ZOOM);
    if (next === this.editorZoom) return;

    const stage = this.stage;
    const previousZoom = this.editorZoom;
    const centerX = stage ? (stage.scrollLeft + stage.clientWidth / 2) / previousZoom : 0;
    const centerY = stage ? (stage.scrollTop + stage.clientHeight / 2) / previousZoom : 0;

    this.editorZoom = next;
    this.applyCanvasViewport();

    if (stage) {
      stage.scrollLeft = Math.max(0, centerX * next - stage.clientWidth / 2);
      stage.scrollTop = Math.max(0, centerY * next - stage.clientHeight / 2);
    }
  }

  private applyCanvasViewport(): void {
    if (!this.canvas) return;
    const bounds = this.getCanvasBounds();
    this.canvas.setAttribute("viewBox", `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`);
    this.canvas.style.width = `${Math.round(bounds.width * this.editorZoom)}px`;
    this.canvas.style.height = `${Math.round(bounds.height * this.editorZoom)}px`;
    if (this.zoomLabel) this.zoomLabel.setText(`${Math.round(this.editorZoom * 100)}%`);
  }

  private getCanvasBounds(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
    if (this.diagram.syntax === "sequenceDiagram") {
      const nodeMinX = Math.min(0, ...this.diagram.nodes.map((node) => node.x - node.width / 2 - CANVAS_PADDING));
      const nodeMaxX = Math.max(BASE_CANVAS_WIDTH, ...this.diagram.nodes.map((node) => node.x + node.width / 2 + CANVAS_PADDING));
      const maxY = this.getSequenceBottomY() + 68 + CANVAS_PADDING;
      const width = Math.max(BASE_CANVAS_WIDTH, nodeMaxX - nodeMinX);
      const height = Math.max(BASE_CANVAS_HEIGHT, maxY);
      return { minX: nodeMinX, minY: 0, maxX: nodeMinX + width, maxY: height, width, height };
    }

    const nodeMinX = Math.min(0, ...this.diagram.nodes.map((node) => node.x - node.width / 2 - CANVAS_PADDING));
    const nodeMinY = Math.min(0, ...this.diagram.nodes.map((node) => node.y - node.height / 2 - CANVAS_PADDING));
    const nodeMaxX = Math.max(BASE_CANVAS_WIDTH, ...this.diagram.nodes.map((node) => node.x + node.width / 2 + CANVAS_PADDING));
    const nodeMaxY = Math.max(BASE_CANVAS_HEIGHT, ...this.diagram.nodes.map((node) => node.y + node.height / 2 + CANVAS_PADDING));
    const linePoints = this.getFreeLineBoundsPoints();
    const lineMinX = Math.min(0, ...linePoints.map((point) => point.x - CANVAS_PADDING));
    const lineMinY = Math.min(0, ...linePoints.map((point) => point.y - CANVAS_PADDING));
    const lineMaxX = Math.max(BASE_CANVAS_WIDTH, ...linePoints.map((point) => point.x + CANVAS_PADDING));
    const lineMaxY = Math.max(BASE_CANVAS_HEIGHT, ...linePoints.map((point) => point.y + CANVAS_PADDING));
    const minX = Math.min(nodeMinX, lineMinX);
    const minY = Math.min(nodeMinY, lineMinY);
    const maxX = Math.max(nodeMaxX, lineMaxX);
    const maxY = Math.max(nodeMaxY, lineMaxY);
    const width = Math.max(BASE_CANVAS_WIDTH, maxX - minX);
    const height = Math.max(BASE_CANVAS_HEIGHT, maxY - minY);
    return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
  }

  private getFreeLineBoundsPoints(): CanvasPoint[] {
    const points = this.diagram.freeLines.flatMap((line) => [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]);
    if (this.freeLineDraft) points.push(this.freeLineDraft.start, this.freeLineDraft.current);
    return points;
  }

  private getSequenceBottomY(): number {
    return SEQUENCE_MESSAGE_START_Y + Math.max(1, this.diagram.edges.length) * SEQUENCE_MESSAGE_GAP + SEQUENCE_BOTTOM_PADDING;
  }

  private beginNodeDrag(node: DiagramNode, event: PointerEvent): void {
    this.endDrag();
    this.draggingNodeId = node.id;
    const point = this.toCanvasPoint(event);
    this.dragOffset = { x: point.x - node.x, y: point.y - node.y };

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.onPointerMove(moveEvent);
    const up = () => this.endDrag();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeNodeDragListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.draggingNodeId) return;
    const node = this.diagram.nodes.find((item) => item.id === this.draggingNodeId);
    if (!node) return;
    event.preventDefault();
    this.clearRenderedPathsForNode(node.id);
    const point = this.toCanvasPoint(event);
    const snapped = this.snapPoint({ x: point.x - this.dragOffset.x, y: point.y - this.dragOffset.y });
    node.x = snapped.x;
    node.y = snapped.y;
    this.renderCanvas();
    this.updateCodePreview();
  }

  private endDrag(): void {
    this.removeNodeDragListeners?.();
    this.removeNodeDragListeners = undefined;
    this.draggingNodeId = undefined;
  }

  private beginResize(node: DiagramNode, handle: ResizeHandle, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endResize();
    this.setSelectedShapeTool(undefined);
    this.selection = { kind: "node", id: node.id };
    this.resizeState = {
      nodeId: node.id,
      handle,
      startPointer: this.toCanvasPoint(event),
      startX: node.x,
      startY: node.y,
      startWidth: node.width,
      startHeight: node.height,
    };

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateResize(moveEvent);
    const up = () => this.endResize();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeResizeListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private updateResize(event: PointerEvent): void {
    const state = this.resizeState;
    if (!state) return;
    const node = this.diagram.nodes.find((item) => item.id === state.nodeId);
    if (!node) return;
    event.preventDefault();
    this.clearRenderedPathsForNode(node.id);

    const pointer = this.snapPoint(this.toCanvasPoint(event));
    const startLeft = state.startX - state.startWidth / 2;
    const startRight = state.startX + state.startWidth / 2;
    const startTop = state.startY - state.startHeight / 2;
    const startBottom = state.startY + state.startHeight / 2;

    let left = startLeft;
    let right = startRight;
    let top = startTop;
    let bottom = startBottom;

    if (state.handle.includes("w")) left = Math.min(pointer.x, startRight - MIN_NODE_WIDTH);
    if (state.handle.includes("e")) right = Math.max(pointer.x, startLeft + MIN_NODE_WIDTH);
    if (state.handle.includes("n")) top = Math.min(pointer.y, startBottom - MIN_NODE_HEIGHT);
    if (state.handle.includes("s")) bottom = Math.max(pointer.y, startTop + MIN_NODE_HEIGHT);

    node.width = right - left;
    node.height = bottom - top;
    node.x = (left + right) / 2;
    node.y = (top + bottom) / 2;
    this.renderCanvas();
    this.updateCodePreview();
  }

  private endResize(): void {
    this.removeResizeListeners?.();
    this.removeResizeListeners = undefined;
    this.resizeState = undefined;
  }

  private clearRenderedPathsForNode(nodeId: string): void {
    for (const edge of this.diagram.edges) {
      if (edge.from === nodeId || edge.to === nodeId) edge.renderedPath = undefined;
    }
  }

  private beginFreeLineDraw(event: PointerEvent): void {
    if (!this.selectedConnector) return;
    event.preventDefault();
    event.stopPropagation();
    this.endFreeLineDraw();
    const start = this.snapPoint(this.toCanvasPoint(event));
    this.freeLineDraft = { style: this.selectedConnector.style, start, current: start };
    this.selection = null;

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateFreeLineDraw(moveEvent);
    const up = (upEvent: PointerEvent) => this.finishFreeLineDraw(upEvent);
    const cancel = () => {
      this.endFreeLineDraw();
      this.render();
    };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", cancel, { once: true });
    this.removeFreeLineListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
    };
    this.renderCanvas();
  }

  private updateFreeLineDraw(event: PointerEvent): void {
    if (!this.freeLineDraft || !this.canvas) return;
    event.preventDefault();
    this.freeLineDraft.current = this.snapPoint(this.toCanvasPoint(event));
    this.renderCanvas();
  }

  private finishFreeLineDraw(event: PointerEvent): void {
    const draft = this.freeLineDraft;
    this.endFreeLineDraw();
    if (!draft || !this.canvas) return;
    const end = this.snapPoint(this.toCanvasPoint(event));
    if (Math.hypot(end.x - draft.start.x, end.y - draft.start.y) < 16) {
      this.render();
      return;
    }
    const line: DiagramFreeLine = {
      id: this.nextFreeLineId(),
      x1: draft.start.x,
      y1: draft.start.y,
      x2: end.x,
      y2: end.y,
      label: "",
      style: draft.style,
    };
    this.diagram.freeLines.push(line);
    this.selection = { kind: "freeLine", id: line.id };
    this.render();
  }

  private endFreeLineDraw(): void {
    this.removeFreeLineListeners?.();
    this.removeFreeLineListeners = undefined;
    this.freeLineDraft = undefined;
  }

  private nextFreeLineId(): string {
    const used = new Set(this.diagram.freeLines.map((line) => line.id));
    for (let index = 1; index < 10000; index += 1) {
      const id = `freeLine${index}`;
      if (!used.has(id)) return id;
    }
    return `freeLine${this.diagram.freeLines.length + 1}`;
  }

  private beginShapePlacement(shape: NodeShape, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.cancelShapePlacement();
    this.setSelectedShapeTool(shape);
    this.placement = { shape };
    this.canvas?.addClass("is-placing");

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateShapePlacement(moveEvent);
    const up = (upEvent: PointerEvent) => this.finishShapePlacement(upEvent);
    const cancel = () => this.cancelShapePlacement();

    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", cancel, { once: true });
    this.removePlacementListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", cancel);
    };
  }

  private updateShapePlacement(event: PointerEvent): void {
    if (!this.placement || !this.canvas || !this.isPointerInsideCanvas(event)) return;

    let node = this.placement.nodeId ? this.diagram.nodes.find((item) => item.id === this.placement?.nodeId) : undefined;
    const created = !node;
    if (!node) {
      node = createNode(this.diagram, this.placement.shape);
      this.placement.nodeId = node.id;
      this.selection = { kind: "node", id: node.id };
    }

    const point = this.toBoundedCanvasPoint(event);
    const snapped = this.snapPoint(point);
    node.x = snapped.x;
    node.y = snapped.y;

    if (created) this.render();
    else {
      this.renderCanvas();
      this.updateCodePreview();
    }
  }

  private finishShapePlacement(event: PointerEvent): void {
    this.updateShapePlacement(event);
    const placed = Boolean(this.placement?.nodeId);
    this.cancelShapePlacement();
    if (placed) this.setSelectedShapeTool(undefined);
    this.suppressNextPaletteClick = placed;
    this.suppressNextCanvasClick = placed;
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.setTimeout(() => {
      this.suppressNextCanvasClick = false;
      this.suppressNextPaletteClick = false;
    }, 0);
  }

  private cancelShapePlacement(): void {
    this.removePlacementListeners?.();
    this.removePlacementListeners = undefined;
    this.placement = undefined;
    if (!this.selectedShape) this.canvas?.removeClass("is-placing");
  }

  private placeShapeAtCenter(shape: NodeShape): void {
    const node = createNode(this.diagram, shape);
    node.x = 490;
    node.y = 340;
    this.selection = { kind: "node", id: node.id };
    this.setSelectedShapeTool(undefined);
    this.render();
  }

  private isPointerInsideCanvas(event: PointerEvent): boolean {
    if (!this.canvas) return false;
    const rect = this.canvas.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private toBoundedCanvasPoint(event: MouseEvent | PointerEvent): CanvasPoint {
    const point = this.toCanvasPoint(event);
    const bounds = this.getCanvasBounds();
    return {
      x: this.clamp(point.x, bounds.minX + NODE_EDGE_PADDING, bounds.maxX - NODE_EDGE_PADDING),
      y: this.clamp(point.y, bounds.minY + NODE_EDGE_PADDING, bounds.maxY - NODE_EDGE_PADDING),
    };
  }

  private snapPoint(point: CanvasPoint): CanvasPoint {
    return {
      x: Math.round(point.x / SNAP_SIZE) * SNAP_SIZE,
      y: Math.round(point.y / SNAP_SIZE) * SNAP_SIZE,
    };
  }

  private findNodeAtPoint(point: CanvasPoint, excludeNodeId?: string): DiagramNode | undefined {
    return [...this.diagram.nodes].reverse().find((node) => {
      if (node.id === excludeNodeId) return false;
      return point.x >= node.x - node.width / 2 && point.x <= node.x + node.width / 2 && point.y >= node.y - node.height / 2 && point.y <= node.y + node.height / 2;
    });
  }

  private findConnectionTargetAtPoint(point: CanvasPoint, excludeNodeId?: string): { node: DiagramNode; handle: ConnectionHandle } | undefined {
    let nearest: { node: DiagramNode; handle: ConnectionHandle; distance: number } | undefined;
    for (const node of this.diagram.nodes) {
      if (node.id === excludeNodeId) continue;
      const distance = this.distanceToNodeRect(point, node);
      if (distance > CONNECT_TARGET_REVEAL_DISTANCE) continue;
      if (!nearest || distance < nearest.distance) {
        nearest = { node, handle: this.getClosestConnectionHandle(node, point), distance };
      }
    }
    return nearest ? { node: nearest.node, handle: nearest.handle } : undefined;
  }

  private distanceToNodeRect(point: CanvasPoint, node: DiagramNode): number {
    const dx = Math.max(Math.abs(point.x - node.x) - node.width / 2, 0);
    const dy = Math.max(Math.abs(point.y - node.y) - node.height / 2, 0);
    return Math.hypot(dx, dy);
  }

  private getClosestConnectionHandle(node: DiagramNode, point: CanvasPoint): ConnectionHandle {
    let closest: ConnectionHandle = "right";
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const handle of ["top", "right", "bottom", "left"] as ConnectionHandle[]) {
      const anchor = this.getConnectionAnchorPoint(node, handle);
      const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance < closestDistance) {
        closest = handle;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private getEdgeEndpoints(from: DiagramNode, to: DiagramNode): { from: CanvasPoint; to: CanvasPoint } {
    return {
      from: this.getBoundaryPointToward(from, to),
      to: this.getBoundaryPointToward(to, from),
    };
  }

  private getBoundaryPointToward(node: DiagramNode, target: CanvasPoint): CanvasPoint {
    const dx = target.x - node.x;
    const dy = target.y - node.y;
    if (Math.abs(dx) / Math.max(1, node.width) > Math.abs(dy) / Math.max(1, node.height)) {
      return { x: node.x + Math.sign(dx || 1) * node.width / 2, y: node.y };
    }
    return { x: node.x, y: node.y + Math.sign(dy || 1) * node.height / 2 };
  }

  private createConnectorPath(from: CanvasPoint, to: CanvasPoint): string {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const sign = Math.sign(dx || 1);
      const curve = Math.max(42, Math.min(180, Math.abs(dx) * 0.52));
      return `M ${from.x} ${from.y} C ${from.x + sign * curve} ${from.y}, ${to.x - sign * curve} ${to.y}, ${to.x} ${to.y}`;
    }

    const sign = Math.sign(dy || 1);
    const curve = Math.max(42, Math.min(180, Math.abs(dy) * 0.52));
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + sign * curve}, ${to.x} ${to.y - sign * curve}, ${to.x} ${to.y}`;
  }

  private toCanvasPoint(event: MouseEvent | PointerEvent): CanvasPoint {
    if (!this.canvas) return { x: 0, y: 0 };
    const point = this.canvas.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = this.canvas.getScreenCTM();
    if (!matrix) return { x: point.x, y: point.y };
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  protected cloneWorkingDiagram(): FlowDiagram {
    return cloneDiagram(this.diagram);
  }
}

class MermaidTextEditModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly fieldLabel: string,
    private readonly initialValue: string,
    private readonly allowEmpty: boolean,
    private readonly onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("owen-mermaid-text-edit-modal");
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-text-edit-shell" });
    shell.createEl("h3", { text: this.heading });

    const field = shell.createDiv({ cls: "owen-mermaid-field" });
    field.createEl("label", { text: this.fieldLabel });
    const input = field.createEl("input", { value: this.initialValue, attr: { type: "text" } });

    const actions = shell.createDiv({ cls: "owen-mermaid-text-edit-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const apply = actions.createEl("button", { text: "Apply", attr: { type: "button" } });

    const submit = () => {
      const value = input.value.trim();
      if (!this.allowEmpty && !value) {
        new Notice("Text cannot be empty.");
        return;
      }
      this.onSubmit(value);
      this.close();
    };

    cancel.addEventListener("click", () => this.close());
    apply.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.close();
    });

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}
