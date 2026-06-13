import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import { HistoryStack } from "./editorHistory";
import { cloneDiagram, createEdge, createNode, generateFlowchart, parseFlowchart } from "./flowchart";
import { ensureLiquidGlassFilter } from "./liquidGlass";
import type { DiagramEdge, DiagramFreeLine, DiagramNode, EdgeRoute, EdgeStyle, FlowDiagram, FlowDirection, MermaidRenderedLayout, NodeShape } from "./types";

const BASE_CANVAS_WIDTH = 980;
const BASE_CANVAS_HEIGHT = 680;
const CANVAS_PADDING = 220;
const NODE_EDGE_PADDING = 60;
const MIN_EDITOR_ZOOM = 0.4;
const MAX_EDITOR_ZOOM = 2.5;
const EDITOR_ZOOM_STEP = 0.15;
const DEFAULT_SNAP_SIZE = 20;
const MIN_SNAP_SIZE = 10;
const MIN_NODE_WIDTH = 80;
const MIN_NODE_HEIGHT = 44;
const CONNECT_TARGET_REVEAL_DISTANCE = 46;
const SEQUENCE_TOP_Y = 82;
const SEQUENCE_MESSAGE_START_Y = 176;
const SEQUENCE_MESSAGE_GAP = 62;
const SEQUENCE_BOTTOM_PADDING = 96;
const MINIMAP_WIDTH = 168;
const MINIMAP_HEIGHT = 112;

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "freeLine"; id: string } | null;
type ShapePlacement = { shape: NodeShape; point?: CanvasPoint };
type ConnectorTool = { style: EdgeStyle } | undefined;
type CanvasPoint = { x: number; y: number };
type ConnectionHandle = "top" | "right" | "bottom" | "left";
type ResizeHandle = "nw" | "ne" | "se" | "sw";
type AlignmentMode = "left" | "centerX" | "right" | "top" | "middleY" | "bottom";
type DistributionMode = "horizontal" | "vertical";
type ColorTarget = "nodeFill" | "nodeStroke" | "nodeText" | "edgeStroke" | "edgeText";

const COLOR_TARGETS: Array<{ value: ColorTarget; label: string; icon: string }> = [
  { value: "nodeFill", label: "Shape fill", icon: "paint-bucket" },
  { value: "nodeStroke", label: "Shape line", icon: "square" },
  { value: "nodeText", label: "Shape text", icon: "type" },
  { value: "edgeStroke", label: "Line / arrow", icon: "minus" },
  { value: "edgeText", label: "Line label", icon: "type" },
];
const COLOR_SWATCHES = ["#ffffff", "#f8fafc", "#dbeafe", "#dcfce7", "#fef3c7", "#ffe4e6", "#e9d5ff", "#172033", "#64748b", "#0ea5e9", "#22c55e", "#f59e0b", "#f43f5e", "#8b5cf6"];
const DEFAULT_NODE_FILL_COLOR = "#ffffff";
const DEFAULT_NODE_STROKE_COLOR = "#94a3b8";
const DEFAULT_TEXT_COLOR = "#172033";
const DEFAULT_EDGE_STROKE_COLOR = "#64748b";
const DEFAULT_NODE_STROKE_WIDTH = 1.4;
const DEFAULT_EDGE_STROKE_WIDTH = 2;
const DEFAULT_NODE_TEXT_SIZE = 13;
const DEFAULT_EDGE_TEXT_SIZE = 13;

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

interface LabelDragState {
  kind: "edge" | "freeLine";
  id: string;
  startPointer: CanvasPoint;
  startOffsetX: number;
  startOffsetY: number;
}

interface ModalResizeState {
  startPointerX: number;
  startPointerY: number;
  startWidth: number;
  startHeight: number;
}

export class MermaidEditorModal extends Modal {
  private diagram: FlowDiagram;
  private savedSource: string;
  private activeSelection: Selection = null;
  private stage?: HTMLElement;
  private canvas?: SVGSVGElement;
  private ribbon?: HTMLElement;
  private ribbonContextKey = "";
  private zoomLabel?: HTMLElement;
  private minimap?: SVGSVGElement;
  private statusBar?: HTMLElement;
  private inspector?: HTMLElement;
  private codePreview?: HTMLTextAreaElement;
  private diffPreview?: HTMLTextAreaElement;
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
  private removeLabelDragListeners?: () => void;
  private removeModalResizeListeners?: () => void;
  private resizeState?: ResizeState;
  private reconnectState?: ReconnectState;
  private labelDragState?: LabelDragState;
  private modalResizeState?: ModalResizeState;
  private suppressNextCanvasClick = false;
  private suppressNextPaletteClick = false;
  private suppressClosePrompt = false;
  private discardPromptOpen = false;
  private keyboardMoveHistoryRecorded = false;
  private sourceEditing = false;
  private sourceDraft?: string;
  private snapEnabled = true;
  private snapSize = DEFAULT_SNAP_SIZE;
  private editorZoom = 1;
  private colorTarget: ColorTarget = "nodeFill";
  private colorTargetSelect?: HTMLSelectElement;
  private colorInput?: HTMLInputElement;
  private colorResetButton?: HTMLButtonElement;
  private colorClearButton?: HTMLButtonElement;
  private colorApplySimilarButton?: HTMLButtonElement;
  private readonly colorTargetButtons = new Map<ColorTarget, HTMLButtonElement>();
  private readonly selectedNodeIds = new Set<string>();
  private preserveNodeSelection = false;
  private draggedNodeStarts = new Map<string, CanvasPoint>();
  private get editorSelection(): Selection {
    return this.activeSelection ?? null;
  }
  private set editorSelection(value: Selection) {
    this.activeSelection = value ?? null;
    if (this.preserveNodeSelection) return;
    if (!this.selectedNodeIds) return;
    this.selectedNodeIds.clear();
    if (value?.kind === "node") this.selectedNodeIds.add(value.id);
  }
  private readonly history = new HistoryStack<FlowDiagram>(cloneDiagram);
  private readonly handleEditorKeydown = (event: KeyboardEvent): void => {
    if (this.isEditableKeyTarget(event.target)) return;

    const key = event.key.toLowerCase();
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) this.redoHistory();
      else this.undoHistory();
      return;
    }

    if (modifier && key === "y") {
      event.preventDefault();
      event.stopPropagation();
      this.redoHistory();
      return;
    }

    if (event.key === "Escape" && this.cancelActiveTool()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && this.deleteSelection()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === "Enter" && this.editSelectionText()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const delta = event.shiftKey ? this.snapSize : 5;
    const directions: Record<string, CanvasPoint> = {
      ArrowUp: { x: 0, y: -delta },
      ArrowRight: { x: delta, y: 0 },
      ArrowDown: { x: 0, y: delta },
      ArrowLeft: { x: -delta, y: 0 },
    };
    const move = directions[event.key];
    if (move && this.moveSelection(move.x, move.y, !this.keyboardMoveHistoryRecorded)) {
      this.keyboardMoveHistoryRecorded = true;
      event.preventDefault();
      event.stopPropagation();
    }
  };
  private readonly handleEditorKeyup = (event: KeyboardEvent): void => {
    if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(event.key)) this.keyboardMoveHistoryRecorded = false;
  };

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
    this.savedSource = this.currentSource();
  }

  onOpen(): void {
    ensureLiquidGlassFilter(this.containerEl.ownerDocument);
    this.modalEl.addClass("owen-mermaid-editor-modal");
    this.modalEl.addEventListener("keydown", this.handleEditorKeydown);
    this.modalEl.addEventListener("keyup", this.handleEditorKeyup);
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-editor-shell" });
    this.createModalResizeHandle(shell);
    const header = shell.createDiv({ cls: "owen-mermaid-editor-header" });
    header.createEl("div", { cls: "owen-mermaid-editor-title", text: "Owen Mermaid" });

    const actions = header.createDiv({ cls: "owen-mermaid-editor-actions" });
    this.createButton(actions, "undo-2", "Undo", () => this.undoHistory());
    this.createButton(actions, "redo-2", "Redo", () => this.redoHistory());
    this.createButton(actions, "rotate-ccw", "Auto layout", () => this.autoLayout());
    this.createButton(actions, "save", "Apply", () => void this.save());
    this.createButton(actions, "x", "Close", () => this.close());

    this.ribbon = shell.createDiv({ cls: "owen-mermaid-editor-ribbon" });
    this.renderRibbon(true);

    const body = shell.createDiv({ cls: "owen-mermaid-editor-body" });
    this.stage = body.createDiv({ cls: "owen-mermaid-editor-stage" });
    this.stage.addEventListener("scroll", () => this.renderMinimap());
    const navPanel = body.createDiv({ cls: "owen-mermaid-editor-nav-panel owen-mermaid-glass-toolbar" });
    this.renderStageZoomControls(navPanel);
    this.canvas = this.stage.createSvg("svg", { cls: "owen-mermaid-canvas" });
    this.bindCanvas(this.canvas);
    this.minimap = navPanel.createSvg("svg", { cls: "owen-mermaid-minimap", attr: { width: String(MINIMAP_WIDTH), height: String(MINIMAP_HEIGHT), viewBox: `0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}` } });
    this.minimap.addEventListener("pointerdown", (event) => this.handleMinimapPointer(event));

    this.inspector = body.createDiv({ cls: "owen-mermaid-inspector" });
    this.statusBar = shell.createDiv({ cls: "owen-mermaid-editor-status" });
    this.render();
  }

  close(): void {
    if (this.suppressClosePrompt || !this.hasUnsavedChanges()) {
      super.close();
      return;
    }

    this.showDiscardChangesPrompt();
  }

  onClose(): void {
    this.cancelShapePlacement();
    this.endDrag();
    this.endResize();
    this.endConnectionDrag();
    this.endFreeLineDraw();
    this.endLabelDrag();
    this.endModalResize();
    this.ribbon = undefined;
    this.ribbonContextKey = "";
    this.modalEl.removeEventListener("keydown", this.handleEditorKeydown);
    this.modalEl.removeEventListener("keyup", this.handleEditorKeyup);
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

  private isNodeSelected(nodeId: string): boolean {
    return this.selectedNodeIds.has(nodeId) || (this.editorSelection?.kind === "node" && this.editorSelection.id === nodeId);
  }

  private setPrimaryNodeSelection(nodeId: string, preserve = false): void {
    if (!preserve) this.selectedNodeIds.clear();
    this.selectedNodeIds.add(nodeId);
    this.preserveNodeSelection = true;
    this.editorSelection = { kind: "node", id: nodeId };
    this.preserveNodeSelection = false;
  }

  private toggleNodeSelection(nodeId: string): void {
    if (this.selectedNodeIds.has(nodeId) && this.selectedNodeIds.size > 1) this.selectedNodeIds.delete(nodeId);
    else this.selectedNodeIds.add(nodeId);
    const nextId = this.selectedNodeIds.has(nodeId) ? nodeId : Array.from(this.selectedNodeIds)[0];
    this.preserveNodeSelection = true;
    this.editorSelection = nextId ? { kind: "node", id: nextId } : null;
    this.preserveNodeSelection = false;
  }

  private selectedNodes(): DiagramNode[] {
    return this.diagram.nodes.filter((node) => this.selectedNodeIds.has(node.id));
  }

  private renderRibbon(force = false): void {
    if (!this.ribbon) return;
    const key = this.createRibbonContextKey();
    if (!force && this.ribbonContextKey === key) {
      this.updatePaletteState();
      return;
    }
    this.ribbonContextKey = key;
    this.renderPalette(this.ribbon);
    this.updatePaletteState();
  }

  private createRibbonContextKey(): string {
    const selection = this.editorSelection;
    const selectedCount = selection?.kind === "node" ? this.selectedNodeIds.size : 0;
    return `${selection?.kind ?? "none"}:${selectedCount}:${this.diagram.syntax}`;
  }

  private renderPalette(parent: HTMLElement): void {
    parent.empty();
    parent.setAttribute("data-ribbon-context", this.editorSelection?.kind ?? "draw");
    this.colorTargetSelect = undefined;
    this.colorInput = undefined;
    this.colorResetButton = undefined;
    this.colorClearButton = undefined;
    this.colorApplySimilarButton = undefined;
    this.colorTargetButtons.clear();

    if (!this.editorSelection) {
      this.renderShapeToolGroup(parent);
      this.renderConnectorToolGroup(parent);
      this.renderDiagramGroup(parent);
      this.renderViewRibbonGroup(parent);
      return;
    }

    if (this.editorSelection.kind === "node") {
      this.renderNodeShapeGroup(parent);
      this.renderConnectorToolGroup(parent);
      this.renderColorGroup(parent);
      if (this.selectedNodeIds.size > 1) this.renderArrangeGroup(parent);
      this.renderViewRibbonGroup(parent);
      return;
    }

    this.renderConnectorStyleGroup(parent);
    this.renderColorGroup(parent);
    this.renderViewRibbonGroup(parent);
  }

  private renderShapeToolGroup(parent: HTMLElement): void {
    const shapesGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    shapesGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Shapes" });
    const shapeButtons = shapesGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.shapeTools()) {
      const button = shapeButtons.createEl("button", {
        cls: "owen-mermaid-palette-item",
        attr: { type: "button", "data-shape": item.shape, "data-shape-action": "create", "aria-pressed": "false", title: `${item.label}: click, then click the canvas. You can also drag it onto the canvas.` },
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
  }

  private renderNodeShapeGroup(parent: HTMLElement): void {
    const shapeGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    shapeGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Shape" });
    const shapeButtons = shapeGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.shapeTools()) {
      const button = shapeButtons.createEl("button", {
        cls: "owen-mermaid-palette-item",
        attr: { type: "button", "data-shape": item.shape, "data-shape-action": "apply", "aria-pressed": "false", title: item.label },
      });
      setIcon(button, item.icon);
      button.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: item.label });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        this.applyShapeToSelectedNodes(item.shape);
      });
    }
  }

  private renderConnectorToolGroup(parent: HTMLElement): void {
    if (this.diagram.nodes.length === 0) return;

    const connectorGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    connectorGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Connect" });
    const connectorButtons = connectorGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.connectorTools(false)) {
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
  }

  private renderConnectorStyleGroup(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    group.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Line" });
    const items = group.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.connectorTools(this.editorSelection?.kind === "freeLine")) {
      const button = items.createEl("button", {
        cls: "owen-mermaid-palette-item",
        attr: { type: "button", "data-edge-style": item.style, "aria-pressed": "false", title: item.label, "aria-label": item.label },
      });
      setIcon(button, item.icon);
      button.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: item.label });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        this.applyStyleToSelectedConnector(item.style);
      });
    }
  }

  private renderColorGroup(parent: HTMLElement): void {
    if (this.availableColorTargets().length === 0) return;

    const colorGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group owen-mermaid-color-group" });
    colorGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Color" });
    this.renderColorRibbon(colorGroup);
  }

  private renderDiagramGroup(parent: HTMLElement): void {
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

  private renderArrangeGroup(parent: HTMLElement): void {
    const arrangeGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    arrangeGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "Arrange" });
    const arrangeButtons = arrangeGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    this.createRibbonButton(arrangeButtons, "align-start-horizontal", "Left", () => this.alignSelectedNodes("left"));
    this.createRibbonButton(arrangeButtons, "align-center-horizontal", "Center", () => this.alignSelectedNodes("centerX"));
    this.createRibbonButton(arrangeButtons, "align-end-horizontal", "Right", () => this.alignSelectedNodes("right"));
    this.createRibbonButton(arrangeButtons, "align-start-vertical", "Top", () => this.alignSelectedNodes("top"));
    this.createRibbonButton(arrangeButtons, "align-center-vertical", "Middle", () => this.alignSelectedNodes("middleY"));
    this.createRibbonButton(arrangeButtons, "align-end-vertical", "Bottom", () => this.alignSelectedNodes("bottom"));
    this.createRibbonButton(arrangeButtons, "rows-3", "H Space", () => this.distributeSelectedNodes("horizontal"));
    this.createRibbonButton(arrangeButtons, "columns-3", "V Space", () => this.distributeSelectedNodes("vertical"));
  }

  private renderViewRibbonGroup(parent: HTMLElement): void {
    const viewGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    viewGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: "View" });
    const viewButtons = viewGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    this.createRibbonButton(viewButtons, "scan", "Fit", () => this.fitDiagramToStage());
    this.createRibbonButton(viewButtons, "locate-fixed", "Center", () => this.centerSelectionInStage());
    const snapToggle = viewButtons.createEl("button", { cls: "owen-mermaid-palette-item", attr: { type: "button", title: "Toggle snap", "aria-label": "Toggle snap", "aria-pressed": this.snapEnabled ? "true" : "false" } });
    setIcon(snapToggle, "magnet");
    snapToggle.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: "Snap" });
    snapToggle.toggleClass("is-active", this.snapEnabled);
    snapToggle.addEventListener("click", () => {
      this.snapEnabled = !this.snapEnabled;
      snapToggle.toggleClass("is-active", this.snapEnabled);
      snapToggle.setAttribute("aria-pressed", this.snapEnabled ? "true" : "false");
      this.renderStatusBar();
    });
    const snapSize = viewButtons.createEl("select", { cls: "owen-mermaid-select owen-mermaid-snap-select" });
    for (const value of [10, 20, 40]) snapSize.createEl("option", { text: String(value), value: String(value) });
    snapSize.value = String(this.snapSize);
    snapSize.addEventListener("change", () => {
      this.snapSize = Number(snapSize.value) || DEFAULT_SNAP_SIZE;
      this.renderStatusBar();
    });
  }

  private shapeTools(): Array<{ shape: NodeShape; label: string; icon: string }> {
    return [
      { shape: "rectangle", label: "Rectangle", icon: "square" },
      { shape: "rounded", label: "Rounded", icon: "box" },
      { shape: "stadium", label: "Stadium", icon: "pill" },
      { shape: "diamond", label: "Decision", icon: "diamond" },
      { shape: "circle", label: "Circle", icon: "circle" },
    ];
  }

  private connectorTools(includeFreeLineStyles: boolean): Array<{ style: EdgeStyle; label: string; icon: string }> {
    const styles: Array<{ style: EdgeStyle; label: string; icon: string }> = [
      { style: "arrow", label: "Arrow", icon: "arrow-right" },
      { style: "line", label: "Line", icon: "minus" },
      { style: "dotted", label: "Dotted", icon: "ellipsis" },
    ];
    if (includeFreeLineStyles || this.diagram.syntax !== "sequenceDiagram") styles.push({ style: "thick", label: "Thick", icon: "grip-horizontal" });
    return styles.filter((item) => includeFreeLineStyles || this.diagram.syntax !== "sequenceDiagram" || item.style === "arrow" || item.style === "dotted");
  }

  private renderColorRibbon(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "owen-mermaid-color-row" });
    this.colorTargetSelect = row.createEl("select", { cls: "owen-mermaid-select owen-mermaid-color-target" });
    for (const target of COLOR_TARGETS) this.colorTargetSelect.createEl("option", { text: target.label, value: target.value });
    this.colorTargetSelect.value = this.colorTarget;
    this.colorTargetSelect.addEventListener("change", () => {
      this.colorTarget = this.colorTargetSelect?.value as ColorTarget;
      this.updateColorControls();
    });

    this.colorInput = row.createEl("input", { cls: "owen-mermaid-color-input", attr: { type: "color", title: "Apply selected color" } });
    this.colorInput.addEventListener("input", () => this.applySelectedColor(this.colorTarget, this.colorInput?.value));

    this.colorResetButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: "Clear selected color", "aria-label": "Clear selected color" } });
    setIcon(this.colorResetButton, "rotate-ccw");
    this.colorResetButton.addEventListener("click", () => this.applySelectedColor(this.colorTarget, undefined));

    this.colorClearButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: "Clear selected styling", "aria-label": "Clear selected styling" } });
    setIcon(this.colorClearButton, "eraser");
    this.colorClearButton.addEventListener("click", () => this.clearSelectedStyling());

    this.colorApplySimilarButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: "Apply styling to same type", "aria-label": "Apply styling to same type" } });
    setIcon(this.colorApplySimilarButton, "copy-check");
    this.colorApplySimilarButton.addEventListener("click", () => this.applyStyleToSimilarItems());

    this.colorTargetButtons.clear();
    const targetIcons = parent.createDiv({ cls: "owen-mermaid-color-target-icons" });
    for (const target of COLOR_TARGETS) {
      const button = targetIcons.createEl("button", { cls: "owen-mermaid-color-target-button", attr: { type: "button", title: target.label, "aria-label": target.label, "aria-pressed": "false" } });
      setIcon(button, target.icon);
      button.addEventListener("click", () => {
        this.colorTarget = target.value;
        this.updateColorControls();
      });
      this.colorTargetButtons.set(target.value, button);
    }

    const swatches = parent.createDiv({ cls: "owen-mermaid-color-swatches" });
    for (const color of COLOR_SWATCHES) {
      const swatch = swatches.createEl("button", { cls: "owen-mermaid-color-swatch", attr: { type: "button", title: color, "aria-label": `Apply ${color}` } });
      swatch.style.setProperty("--owen-mermaid-swatch", color);
      swatch.addEventListener("click", () => this.applySelectedColor(this.colorTarget, color));
    }
    this.updateColorControls();
  }

  private updateColorControls(): void {
    if (!this.colorTargetSelect || !this.colorInput || !this.colorResetButton) return;
    const available = this.availableColorTargets();
    if (!available.includes(this.colorTarget)) this.colorTarget = available[0] ?? "nodeFill";

    for (const option of Array.from(this.colorTargetSelect.options)) {
      option.disabled = !available.includes(option.value as ColorTarget);
    }
    this.colorTargetSelect.value = this.colorTarget;

    const enabled = available.length > 0;
    const color = this.getSelectedColor(this.colorTarget) ?? this.defaultColorForTarget(this.colorTarget);
    this.colorInput.value = color;
    this.colorInput.disabled = !enabled;
    this.colorResetButton.disabled = !enabled || !this.getSelectedColor(this.colorTarget);
    if (this.colorClearButton) this.colorClearButton.disabled = !enabled || !this.selectionHasStyling();
    if (this.colorApplySimilarButton) this.colorApplySimilarButton.disabled = !enabled || !this.selectionHasStyling();
    for (const target of COLOR_TARGETS) {
      const button = this.colorTargetButtons.get(target.value);
      if (!button) continue;
      const targetAvailable = available.includes(target.value);
      const targetColor = this.getSelectedColor(target.value);
      const displayColor = targetColor ?? this.defaultColorForTarget(target.value);
      button.disabled = !targetAvailable;
      button.toggleClass("is-active", target.value === this.colorTarget);
      button.toggleClass("has-color", Boolean(targetColor));
      button.style.setProperty("--owen-mermaid-target-color", displayColor);
      button.setAttribute("aria-pressed", target.value === this.colorTarget ? "true" : "false");
      button.setAttribute("title", targetColor ? `${target.label}: ${targetColor}` : `${target.label}: default`);
    }
    this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-color-swatch").forEach((button) => {
      button.disabled = !enabled;
      button.toggleClass("is-active", button.title.toLowerCase() === (this.getSelectedColor(this.colorTarget) ?? "").toLowerCase());
    });
  }

  private availableColorTargets(): ColorTarget[] {
    if (this.editorSelection?.kind === "node") return ["nodeFill", "nodeStroke", "nodeText"];
    if (this.editorSelection?.kind === "edge" || this.editorSelection?.kind === "freeLine") return ["edgeStroke", "edgeText"];
    return [];
  }

  private getSelectedColor(target: ColorTarget): string | undefined {
    const selection = this.editorSelection;
    if (selection?.kind === "node") {
      const node = this.diagram.nodes.find((item) => item.id === selection.id);
      if (!node) return undefined;
      if (target === "nodeFill") return node.fillColor;
      if (target === "nodeStroke") return node.strokeColor;
      if (target === "nodeText") return node.textColor;
      return undefined;
    }

    const edgeLike = selection?.kind === "edge" ? this.diagram.edges.find((item) => item.id === selection.id) : selection?.kind === "freeLine" ? this.diagram.freeLines.find((item) => item.id === selection.id) : undefined;
    if (!edgeLike) return undefined;
    if (target === "edgeStroke") return edgeLike.strokeColor;
    if (target === "edgeText") return edgeLike.textColor;
    return undefined;
  }

  private defaultColorForTarget(target: ColorTarget): string {
    if (target === "nodeFill") return DEFAULT_NODE_FILL_COLOR;
    if (target === "nodeStroke") return DEFAULT_NODE_STROKE_COLOR;
    if (target === "edgeStroke") return DEFAULT_EDGE_STROKE_COLOR;
    return DEFAULT_TEXT_COLOR;
  }

  private selectionHasStyling(): boolean {
    const selection = this.editorSelection;
    if (!selection) return false;
    if (selection.kind === "node") {
      const nodes = this.selectedNodeIds.size > 1 ? this.selectedNodes() : this.diagram.nodes.filter((node) => node.id === selection.id);
      return nodes.some((node) => Boolean(node.fillColor || node.strokeColor || node.textColor || node.strokeWidth || node.textSize));
    }
    const item = selection.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === selection.id) : this.diagram.freeLines.find((line) => line.id === selection.id);
    return Boolean(item && (item.strokeColor || item.textColor || item.strokeWidth || item.textSize));
  }

  private applySelectedColor(target: ColorTarget, color: string | undefined): void {
    const normalized = color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
    const selection = this.editorSelection;
    if (!selection) return;

    if (selection.kind === "node") {
      const nodes = this.selectedNodeIds.size > 1 ? this.selectedNodes() : this.diagram.nodes.filter((node) => node.id === selection.id);
      if (nodes.length === 0 || !["nodeFill", "nodeStroke", "nodeText"].includes(target)) return;
      this.recordHistory();
      for (const node of nodes) {
        if (target === "nodeFill") node.fillColor = normalized;
        if (target === "nodeStroke") node.strokeColor = normalized;
        if (target === "nodeText") node.textColor = normalized;
      }
      this.render();
      return;
    }

    const item = selection.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === selection.id) : this.diagram.freeLines.find((line) => line.id === selection.id);
    if (!item || !["edgeStroke", "edgeText"].includes(target)) return;
    this.recordHistory();
    if (target === "edgeStroke") item.strokeColor = normalized;
    if (target === "edgeText") item.textColor = normalized;
    this.render();
  }

  private clearSelectedStyling(): void {
    const selection = this.editorSelection;
    if (!selection) return;
    this.recordHistory();
    if (selection.kind === "node") {
      const nodes = this.selectedNodeIds.size > 1 ? this.selectedNodes() : this.diagram.nodes.filter((node) => node.id === selection.id);
      for (const node of nodes) {
        node.fillColor = undefined;
        node.strokeColor = undefined;
        node.textColor = undefined;
        node.strokeWidth = undefined;
        node.textSize = undefined;
      }
    } else {
      const item = selection.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === selection.id) : this.diagram.freeLines.find((line) => line.id === selection.id);
      if (!item) return;
      item.strokeColor = undefined;
      item.textColor = undefined;
      item.strokeWidth = undefined;
      item.textSize = undefined;
    }
    this.render();
  }

  private applyStyleToSimilarItems(): void {
    const selection = this.editorSelection;
    if (!selection) return;
    this.recordHistory();
    if (selection.kind === "node") {
      const source = this.diagram.nodes.find((node) => node.id === selection.id);
      if (!source) return;
      for (const node of this.diagram.nodes) {
        if (node === source || node.shape !== source.shape) continue;
        node.fillColor = source.fillColor;
        node.strokeColor = source.strokeColor;
        node.textColor = source.textColor;
        node.strokeWidth = source.strokeWidth;
        node.textSize = source.textSize;
      }
    } else if (selection.kind === "edge") {
      const source = this.diagram.edges.find((edge) => edge.id === selection.id);
      if (!source) return;
      for (const edge of this.diagram.edges) {
        if (edge === source || edge.style !== source.style) continue;
        edge.strokeColor = source.strokeColor;
        edge.textColor = source.textColor;
        edge.strokeWidth = source.strokeWidth;
        edge.textSize = source.textSize;
      }
    } else {
      const source = this.diagram.freeLines.find((line) => line.id === selection.id);
      if (!source) return;
      for (const line of this.diagram.freeLines) {
        if (line === source || line.style !== source.style) continue;
        line.strokeColor = source.strokeColor;
        line.textColor = source.textColor;
        line.strokeWidth = source.strokeWidth;
        line.textSize = source.textSize;
      }
    }
    this.render();
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
        this.editorSelection = null;
        this.render();
      }
    });
  }

  private render(): void {
    this.renderRibbon();
    this.renderCanvas();
    this.renderInspector();
    this.renderMinimap();
    this.renderStatusBar();
    this.updateCodePreview();
    this.updateColorControls();
  }

  private renderCanvas(): void {
    if (!this.canvas) return;
    this.applyCanvasViewport();
    this.canvas.empty();
    if (this.diagram.syntax === "sequenceDiagram") {
      this.renderSequenceCanvas();
      this.renderMinimap();
      this.renderStatusBar();
      return;
    }

    this.canvas.createSvg("defs");
    this.createArrowMarker(DEFAULT_EDGE_STROKE_COLOR, "owen-mermaid-arrow");

    const edges = this.canvas.createSvg("g", { cls: "owen-mermaid-edges" });
    for (const edge of this.diagram.edges) this.renderEdge(edges, edge);
    this.renderFreeLines(edges);
    this.renderConnectionPreview(edges);
    this.renderFreeLineDraft(edges);

    const nodes = this.canvas.createSvg("g", { cls: "owen-mermaid-nodes" });
    for (const node of this.diagram.nodes) this.renderNode(nodes, node);
    this.renderShapePreview(nodes);
    this.renderMinimap();
    this.renderStatusBar();
  }

  private renderSequenceCanvas(): void {
    if (!this.canvas) return;
    this.canvas.createSvg("defs");
    this.createArrowMarker(DEFAULT_EDGE_STROKE_COLOR, "owen-mermaid-arrow");

    const participants = this.canvas.createSvg("g", { cls: "owen-mermaid-sequence-participants" });
    const messages = this.canvas.createSvg("g", { cls: "owen-mermaid-sequence-messages" });
    const bottomY = this.getSequenceBottomY();

    for (const node of this.diagram.nodes) {
      const selected = this.isNodeSelected(node.id);
      const lifeline = participants.createSvg("line", {
        cls: "owen-mermaid-sequence-lifeline",
        attr: { x1: String(node.x), y1: String(SEQUENCE_TOP_Y + node.height / 2), x2: String(node.x), y2: String(bottomY - node.height / 2), ...this.strokeStyleAttrs(node.strokeColor, node.strokeWidth) },
      });
      if (selected) lifeline.addClass("is-selected");
      lifeline.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setPrimaryNodeSelection(node.id);
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
    const selected = this.isNodeSelected(node.id);
    const group = parent.createSvg("g", { cls: "owen-mermaid-sequence-participant" });
    if (selected) group.addClass("is-selected");
    group.setAttribute("transform", `translate(${node.x}, ${y})`);
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", `Participant ${node.id}: ${node.label}`);
    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.selectedConnector) {
        if (this.connectingFromNodeId) this.handleConnectorToolNodeClick(node.id);
        else this.beginConnectionDrag(node.id, event);
        return;
      }
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        this.toggleNodeSelection(node.id);
        this.render();
        return;
      }
      this.setPrimaryNodeSelection(node.id);
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showNodeMenu(event, node));
    group.addEventListener("dblclick", () => this.promptNodeLabel(node));
    group.createSvg("rect", { attr: { x: String(-node.width / 2), y: String(-node.height / 2), width: String(node.width), height: String(node.height), rx: "7", ...this.nodeStyleAttrs(node) } });
    group.createSvg("text", { attr: { x: "0", y: "5", "text-anchor": "middle", ...this.textStyleAttrs(node.textColor, node.textSize) } }).setText(node.label);
  }

  private renderSequenceMessage(parent: SVGGElement, edge: DiagramEdge): void {
    const from = this.diagram.nodes.find((node) => node.id === edge.from);
    const to = this.diagram.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return;

    const selected = this.editorSelection?.kind === "edge" && this.editorSelection.id === edge.id;
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
    const markerId = edge.strokeColor ? this.createArrowMarker(edge.strokeColor) : "owen-mermaid-arrow";
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: `M ${startX} ${y} L ${endX} ${y}`, fill: "none", ...this.strokeStyleAttrs(edge.strokeColor, edge.strokeWidth), "marker-end": `url(#${markerId})` } });
    group
      .createSvg("text", { cls: "owen-mermaid-sequence-message-label", attr: { x: String(labelX), y: String(y - 16), "text-anchor": "middle", ...this.textStyleAttrs(edge.textColor, edge.textSize) } })
      .setText(edge.label);
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.editorSelection = { kind: "edge", id: edge.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showEdgeMenu(event, edge));
    group.addEventListener("dblclick", () => this.promptEdgeLabel(edge));
  }

  private renderNode(parent: SVGGElement, node: DiagramNode): void {
    const selected = this.isNodeSelected(node.id);
    const connectingSource = this.connectingFromNodeId === node.id;
    const connectTarget = this.connectTargetNodeId === node.id;
    const group = parent.createSvg("g", {
      cls: "owen-mermaid-node",
      attr: { tabindex: "0", role: "button", "aria-label": `Node ${node.id}: ${node.label}` },
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
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        this.toggleNodeSelection(node.id);
        this.render();
        return;
      }
      this.setPrimaryNodeSelection(node.id);
      this.beginNodeDrag(node, event);
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showNodeMenu(event, node));
    group.addEventListener("dblclick", () => this.promptNodeLabel(node));

    this.createShape(group, node);
    group.createSvg("text", { attr: { x: "0", y: "5", "text-anchor": "middle", ...this.textStyleAttrs(node.textColor, node.textSize) } }).setText(node.label);
    if (selected || connectingSource || connectTarget) this.renderNodeHandles(group, node, connectTarget ? this.connectTargetHandle : undefined, !connectTarget);
  }

  private createShape(group: SVGGElement, node: DiagramNode): void {
    const width = node.width;
    const height = node.height;
    const styleAttrs = this.nodeStyleAttrs(node);
    if (node.shape === "diamond") {
      group.createSvg("polygon", { attr: { points: `0,${-height / 2} ${width / 2},0 0,${height / 2} ${-width / 2},0`, ...styleAttrs } });
      return;
    }
    if (node.shape === "circle") {
      group.createSvg("ellipse", { attr: { cx: "0", cy: "0", rx: String(width / 2), ry: String(height / 2), ...styleAttrs } });
      return;
    }

    const radius = node.shape === "rounded" ? Math.min(12, height / 2) : node.shape === "stadium" ? height / 2 : 6;
    group.createSvg("rect", { attr: { x: String(-width / 2), y: String(-height / 2), width: String(width), height: String(height), rx: String(radius), ...styleAttrs } });
  }

  private nodeStyleAttrs(node: DiagramNode): Record<string, string> {
    const styles = [
      node.fillColor ? `fill: ${node.fillColor}` : "",
      node.strokeColor ? `stroke: ${node.strokeColor}` : "",
      node.strokeWidth ? `stroke-width: ${node.strokeWidth}` : "",
    ].filter(Boolean);
    return styles.length > 0 ? { style: styles.join("; ") } : {};
  }

  private strokeStyleAttrs(color: string | undefined, width?: number): Record<string, string> {
    const styles = [color ? `stroke: ${color}` : "", width ? `stroke-width: ${width}` : ""].filter(Boolean);
    return styles.length > 0 ? { style: styles.join("; ") } : {};
  }

  private textStyleAttrs(color: string | undefined, size?: number): Record<string, string> {
    const styles = [color ? `fill: ${color}` : "", size ? `font-size: ${size}px` : ""].filter(Boolean);
    return styles.length > 0 ? { style: styles.join("; ") } : {};
  }

  private createArrowMarker(color: string, id = `owen-mermaid-arrow-${color.replace(/[^0-9a-f]/gi, "").toLowerCase()}`): string {
    if (!this.canvas) return id;
    if (this.canvas.querySelector(`#${id}`)) return id;
    const defs = this.canvas.querySelector("defs") ?? this.canvas.createSvg("defs");
    const marker = defs.createSvg("marker", {
      attr: { id, markerWidth: "10", markerHeight: "10", refX: "9", refY: "3", orient: "auto", markerUnits: "strokeWidth" },
    });
    marker.createSvg("path", { attr: { d: "M0,0 L0,6 L9,3 z", class: "owen-mermaid-arrow-head", style: `fill: ${color}` } });
    return id;
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
        this.setPrimaryNodeSelection(node.id);
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

    const selected = this.editorSelection?.kind === "edge" && this.editorSelection.id === edge.id;
    const group = parent.createSvg("g", { cls: "owen-mermaid-edge" });
    group.addClass(`is-${edge.style}`);
    if (selected) group.addClass("is-selected");
    const endpoints = this.getEdgeEndpoints(from, to);
    const path = edge.renderedPath ?? this.createConnectorPath(endpoints.from, endpoints.to, edge.route);
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: path, fill: "none" } });
    const markerId = edge.strokeColor ? this.createArrowMarker(edge.strokeColor) : "owen-mermaid-arrow";
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: path, fill: "none", ...this.strokeStyleAttrs(edge.strokeColor, edge.strokeWidth), ...(edge.style === "line" ? {} : { "marker-end": `url(#${markerId})` }) } });
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSelectedShapeTool(undefined);
      this.editorSelection = { kind: "edge", id: edge.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showEdgeMenu(event, edge));
    if (edge.label) {
      const label = this.getLabelPoint(endpoints.from, endpoints.to, edge.labelOffsetX, edge.labelOffsetY);
      const text = group.createSvg("text", { cls: "owen-mermaid-edge-label", attr: { x: String(label.x), y: String(label.y), "text-anchor": "middle", ...this.textStyleAttrs(edge.textColor, edge.textSize) } });
      text.setText(edge.label);
      text.addEventListener("pointerdown", (event) => this.beginLabelDrag("edge", edge.id, event));
    }
    if (selected) this.renderEdgeEndpointHandles(group, edge, endpoints);
  }

  private renderFreeLines(parent: SVGGElement): void {
    for (const line of this.diagram.freeLines) this.renderFreeLine(parent, line);
  }

  private renderFreeLine(parent: SVGGElement, line: DiagramFreeLine): void {
    const selected = this.editorSelection?.kind === "freeLine" && this.editorSelection.id === line.id;
    const path = this.createConnectorPath({ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }, line.route);
    const group = parent.createSvg("g", { cls: "owen-mermaid-free-line" });
    group.addClass(`is-${line.style}`);
    if (selected) group.addClass("is-selected");
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: path, fill: "none" } });
    const markerId = line.strokeColor ? this.createArrowMarker(line.strokeColor) : "owen-mermaid-arrow";
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: path, fill: "none", ...this.strokeStyleAttrs(line.strokeColor, line.strokeWidth), ...(line.style === "line" ? {} : { "marker-end": `url(#${markerId})` }) } });
    if (line.label) {
      const label = this.getLabelPoint({ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }, line.labelOffsetX, line.labelOffsetY);
      const text = group.createSvg("text", { cls: "owen-mermaid-edge-label", attr: { x: String(label.x), y: String(label.y), "text-anchor": "middle", ...this.textStyleAttrs(line.textColor, line.textSize) } });
      text.setText(line.label);
      text.addEventListener("pointerdown", (event) => this.beginLabelDrag("freeLine", line.id, event));
    }
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSelectedShapeTool(undefined);
      this.editorSelection = { kind: "freeLine", id: line.id };
      this.render();
    });
    group.addEventListener("contextmenu", (event) => this.showFreeLineMenu(event, line));
    group.addEventListener("dblclick", () => this.promptFreeLineLabel(line));
  }

  private renderFreeLineDraft(parent: SVGGElement): void {
    if (!this.freeLineDraft) return;
    const path = this.createConnectorPath(this.freeLineDraft.start, this.freeLineDraft.current, this.freeLineDraft.style === "line" ? "straight" : "curve");
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
    this.renderRenderSummary(this.inspector);

    if (!this.editorSelection) {
      this.renderConnectControls(this.inspector);
      this.inspector.createEl("p", { cls: "owen-mermaid-empty-state", text: "Select a node or connector." });
      this.renderUnsupportedSummary(this.inspector);
      this.renderCodePreview(this.inspector);
      this.renderChangeSummary(this.inspector);
      this.renderSourceDiff(this.inspector);
      return;
    }

    if (this.editorSelection.kind === "node") {
      const node = this.diagram.nodes.find((item) => item.id === this.editorSelection?.id);
      if (this.selectedNodeIds.size > 1) this.renderMultiNodeInspector(this.inspector);
      else if (node) this.renderNodeInspector(this.inspector, node);
    } else if (this.editorSelection.kind === "freeLine") {
      const line = this.diagram.freeLines.find((item) => item.id === this.editorSelection?.id);
      if (line) this.renderFreeLineInspector(this.inspector, line);
    } else {
      const edge = this.diagram.edges.find((item) => item.id === this.editorSelection?.id);
      if (edge) this.renderEdgeInspector(this.inspector, edge);
    }

    this.renderUnsupportedSummary(this.inspector);
    this.renderCodePreview(this.inspector);
    this.renderChangeSummary(this.inspector);
    this.renderSourceDiff(this.inspector);
  }

  private renderRenderSummary(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "owen-mermaid-render-summary" });
    box.createSpan({ cls: "owen-mermaid-syntax-badge", text: this.diagram.syntax });
    const text = this.renderSupportText();
    box.createSpan({ text });
  }

  private renderSupportText(): string {
    if (this.diagram.syntax === "flowchart") return "Shapes, text, connectors, colors, and basic styles render in Mermaid; manual layout is stored as editor metadata.";
    if (this.diagram.syntax === "stateDiagram") return "State labels and colors render in Mermaid; manual layout is stored as editor metadata.";
    return "Participants and messages render in Mermaid; manual layout and most visual styling are editor metadata.";
  }

  private renderChangeSummary(parent: HTMLElement): void {
    const items = this.createChangeSummary();
    if (items.length === 0) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Summary" });
    const list = parent.createEl("ul", { cls: "owen-mermaid-change-summary" });
    for (const item of items) list.createEl("li", { text: item });
  }

  private renderUnsupportedSummary(parent: HTMLElement): void {
    if (this.diagram.unsupportedLines.length === 0) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Preserved" });
    const box = parent.createEl("textarea", { cls: "owen-mermaid-preserved-preview" });
    box.readOnly = true;
    box.value = this.diagram.unsupportedLines.join("\n");
  }

  private renderSourceDiff(parent: HTMLElement): void {
    const diff = this.createSourceDiff();
    if (!diff) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Changes" });
    this.diffPreview = parent.createEl("textarea", { cls: "owen-mermaid-diff-preview" });
    this.diffPreview.readOnly = true;
    this.diffPreview.value = diff;
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
      this.recordHistory();
      node.shape = shape.value as NodeShape;
      this.render();
    });

    this.createNumberField(parent, "Border width", node.strokeWidth, DEFAULT_NODE_STROKE_WIDTH, 0.5, 10, 0.5, (value) => {
      node.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, "Text size", node.textSize, DEFAULT_NODE_TEXT_SIZE, 8, 32, 1, (value) => {
      node.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createDangerButton(parent, "Delete node", () => this.deleteNode(node.id));
  }

  private renderMultiNodeInspector(parent: HTMLElement): void {
    parent.createEl("p", { cls: "owen-mermaid-empty-state", text: `${this.selectedNodeIds.size} nodes selected.` });
    const grid = parent.createDiv({ cls: "owen-mermaid-inspector-grid" });
    this.createActionButton(grid, "Align left", () => this.alignSelectedNodes("left"));
    this.createActionButton(grid, "Align center", () => this.alignSelectedNodes("centerX"));
    this.createActionButton(grid, "Align right", () => this.alignSelectedNodes("right"));
    this.createActionButton(grid, "Align top", () => this.alignSelectedNodes("top"));
    this.createActionButton(grid, "Align middle", () => this.alignSelectedNodes("middleY"));
    this.createActionButton(grid, "Align bottom", () => this.alignSelectedNodes("bottom"));
    this.createActionButton(grid, "Distribute X", () => this.distributeSelectedNodes("horizontal"));
    this.createActionButton(grid, "Distribute Y", () => this.distributeSelectedNodes("vertical"));
    this.createDangerButton(parent, "Delete selected nodes", () => this.deleteSelectedNodes());
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
      this.recordHistory();
      edge.style = style.value as DiagramEdge["style"];
      this.render();
    });

    const route = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["curve", "straight", "elbow"] as EdgeRoute[]) route.createEl("option", { text: value, value });
    route.value = edge.route ?? "curve";
    route.addEventListener("change", () => {
      this.recordHistory();
      edge.route = route.value as EdgeRoute;
      edge.renderedPath = undefined;
      this.render();
    });

    this.createNumberField(parent, "Line width", edge.strokeWidth, edge.style === "thick" ? 4 : DEFAULT_EDGE_STROKE_WIDTH, 0.5, 12, 0.5, (value) => {
      edge.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, "Label size", edge.textSize, DEFAULT_EDGE_TEXT_SIZE, 8, 32, 1, (value) => {
      edge.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createActionButton(parent, "Reset label position", () => {
      this.recordHistory();
      edge.labelOffsetX = 0;
      edge.labelOffsetY = 0;
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
      this.recordHistory();
      line.style = style.value as EdgeStyle;
      this.render();
    });

    const route = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["curve", "straight", "elbow"] as EdgeRoute[]) route.createEl("option", { text: value, value });
    route.value = line.route ?? "curve";
    route.addEventListener("change", () => {
      this.recordHistory();
      line.route = route.value as EdgeRoute;
      this.render();
    });

    this.createNumberField(parent, "Line width", line.strokeWidth, line.style === "thick" ? 4 : DEFAULT_EDGE_STROKE_WIDTH, 0.5, 12, 0.5, (value) => {
      line.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, "Label size", line.textSize, DEFAULT_EDGE_TEXT_SIZE, 8, 32, 1, (value) => {
      line.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createActionButton(parent, "Reset label position", () => {
      this.recordHistory();
      line.labelOffsetX = 0;
      line.labelOffsetY = 0;
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
      this.recordHistory();
      const edge = createEdge(this.diagram, from.value, to.value);
      this.editorSelection = { kind: "edge", id: edge.id };
      this.render();
    });
  }

  private renderCodePreview(parent: HTMLElement): void {
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: "Mermaid" });
    const actions = parent.createDiv({ cls: "owen-mermaid-source-actions" });
    const editButton = actions.createEl("button", { cls: "owen-mermaid-action-button", text: this.sourceEditing ? "Cancel source edit" : "Edit source", attr: { type: "button" } });
    const applyButton = actions.createEl("button", { cls: "owen-mermaid-action-button", text: "Apply source", attr: { type: "button" } });
    applyButton.disabled = !this.sourceEditing;

    this.codePreview = parent.createEl("textarea", { cls: "owen-mermaid-code-preview" });
    this.codePreview.value = this.sourceEditing ? this.sourceDraft ?? this.currentSource() : this.currentSource();
    this.codePreview.readOnly = !this.sourceEditing;
    this.codePreview.toggleClass("is-readonly", !this.sourceEditing);
    this.codePreview.addEventListener("input", () => {
      if (this.sourceEditing) this.sourceDraft = this.codePreview?.value ?? "";
    });

    editButton.addEventListener("click", () => {
      if (this.sourceEditing) {
        this.sourceEditing = false;
        this.sourceDraft = undefined;
      } else {
        this.sourceEditing = true;
        this.sourceDraft = this.currentSource();
      }
      this.renderInspector();
      if (this.sourceEditing) {
        const win = this.containerEl.ownerDocument.defaultView ?? window;
        win.requestAnimationFrame(() => this.codePreview?.focus());
      }
    });
    applyButton.addEventListener("click", () => {
      if (!this.sourceEditing) return;
      this.applySourceDraft();
    });
  }

  private createTextField(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void, live = false): void {
    const wrapper = parent.createDiv({ cls: "owen-mermaid-field" });
    wrapper.createEl("label", { text: label });
    const input = wrapper.createEl("input", { value, attr: { type: "text" } });
    let recorded = false;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      this.recordHistory();
    };
    if (live) input.addEventListener("input", () => {
      recordOnce();
      onChange(input.value.trim());
    });
    input.addEventListener("change", () => {
      if (!live) recordOnce();
      onChange(input.value.trim());
    });
  }

  private createNumberField(parent: HTMLElement, label: string, value: number | undefined, placeholder: number, min: number, max: number, step: number, onChange: (value: number | undefined) => void): void {
    const wrapper = parent.createDiv({ cls: "owen-mermaid-field" });
    wrapper.createEl("label", { text: label });
    const input = wrapper.createEl("input", { attr: { type: "number", min: String(min), max: String(max), step: String(step), placeholder: String(placeholder) } });
    input.value = value === undefined ? "" : String(value);
    let recorded = false;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      this.recordHistory();
    };
    input.addEventListener("input", () => {
      recordOnce();
      const nextValue = input.value.trim() === "" ? undefined : this.clamp(Number(input.value), min, max);
      onChange(Number.isFinite(nextValue) ? nextValue : undefined);
    });
  }

  private createDangerButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-danger-button", text: label, attr: { type: "button" } });
    button.addEventListener("click", onClick);
  }

  private createActionButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-action-button", text: label, attr: { type: "button" } });
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

  private createRibbonButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-palette-item", attr: { type: "button", title: label, "aria-label": label } });
    setIcon(button, icon);
    button.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: label });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
  }

  private promptNodeLabel(node: DiagramNode): void {
    this.editorSelection = { kind: "node", id: node.id };
    this.render();
    this.openTextEditor("Edit node text", "Text", node.label, false, (value) => {
      this.recordHistory();
      node.label = value;
      this.editorSelection = { kind: "node", id: node.id };
      this.render();
    });
  }

  private promptEdgeLabel(edge: DiagramEdge): void {
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();
    this.openTextEditor("Edit connector label", "Label", edge.label, true, (value) => {
      this.recordHistory();
      edge.label = value;
      this.editorSelection = { kind: "edge", id: edge.id };
      this.render();
    });
  }

  private promptFreeLineLabel(line: DiagramFreeLine): void {
    this.editorSelection = { kind: "freeLine", id: line.id };
    this.render();
    this.openTextEditor("Edit line label", "Label", line.label, true, (value) => {
      this.recordHistory();
      line.label = value;
      this.editorSelection = { kind: "freeLine", id: line.id };
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
    this.editorSelection = { kind: "node", id: node.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Edit text").setIcon("type").onClick(() => this.promptNodeLabel(node)));
    menu.addItem((item) => item.setTitle("Start connector").setIcon("move-up-right").onClick(() => this.startConnectionFrom(node.id)));
    menu.addItem((item) => item.setTitle("Self connector").setIcon("refresh-cw").onClick(() => this.createSelfConnector(node.id)));
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
    this.editorSelection = { kind: "edge", id: edge.id };
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
    this.editorSelection = { kind: "freeLine", id: line.id };
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
    this.recordHistory();
    const copy = createNode(this.diagram, node.shape);
    copy.label = node.label;
    copy.x = node.x + 34;
    copy.y = node.y + 34;
    this.editorSelection = { kind: "node", id: copy.id };
    this.render();
  }

  private createSelfConnector(nodeId: string): void {
    this.recordHistory();
    const edge = createEdge(this.diagram, nodeId, nodeId);
    edge.label = "loop";
    edge.route = "elbow";
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();
  }

  private deleteNode(nodeId: string): void {
    this.recordHistory();
    this.diagram.nodes = this.diagram.nodes.filter((item) => item.id !== nodeId);
    this.diagram.edges = this.diagram.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    if (this.connectingFromNodeId === nodeId) this.clearConnectionMode();
    this.editorSelection = null;
    this.render();
  }

  private deleteSelectedNodes(): void {
    const ids = new Set(this.selectedNodeIds);
    if (ids.size === 0) return;
    this.recordHistory();
    this.diagram.nodes = this.diagram.nodes.filter((item) => !ids.has(item.id));
    this.diagram.edges = this.diagram.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
    if (this.connectingFromNodeId && ids.has(this.connectingFromNodeId)) this.clearConnectionMode();
    this.editorSelection = null;
    this.render();
  }

  private deleteEdge(edgeId: string): void {
    this.recordHistory();
    this.diagram.edges = this.diagram.edges.filter((item) => item.id !== edgeId);
    this.editorSelection = null;
    this.render();
  }

  private deleteFreeLine(lineId: string): void {
    this.recordHistory();
    this.diagram.freeLines = this.diagram.freeLines.filter((item) => item.id !== lineId);
    this.editorSelection = null;
    this.render();
  }

  private setEdgeStyle(edge: DiagramEdge, style: DiagramEdge["style"]): void {
    this.recordHistory();
    edge.style = style;
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();
  }

  private setFreeLineStyle(line: DiagramFreeLine, style: EdgeStyle): void {
    this.recordHistory();
    line.style = style;
    this.editorSelection = { kind: "freeLine", id: line.id };
    this.render();
  }

  private reverseEdge(edge: DiagramEdge): void {
    this.recordHistory();
    const from = edge.from;
    edge.from = edge.to;
    edge.to = from;
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();
  }

  private renameNode(node: DiagramNode, value: string): void {
    const nextId = value.replace(/[^A-Za-z0-9_-]/g, "");
    if (!nextId || this.diagram.nodes.some((item) => item.id === nextId && item !== node)) {
      new Notice("Use a unique Mermaid node ID.");
      return;
    }
    const oldId = node.id;
    this.recordHistory();
    node.id = nextId;
    for (const edge of this.diagram.edges) {
      if (edge.from === oldId) edge.from = nextId;
      if (edge.to === oldId) edge.to = nextId;
    }
    this.editorSelection = { kind: "node", id: nextId };
    this.render();
  }

  private autoLayout(): void {
    this.recordHistory();
    this.diagram = parseFlowchart(generateFlowchart(this.diagram, false), this.diagram.direction);
    this.render();
  }

  private alignSelectedNodes(mode: AlignmentMode): void {
    const nodes = this.selectedNodes();
    if (nodes.length < 2) return;
    const bounds = this.getNodeBounds(nodes);
    this.recordHistory();
    for (const node of nodes) {
      this.clearRenderedPathsForNode(node.id);
      if (mode === "left") node.x = bounds.minX + node.width / 2;
      else if (mode === "centerX") node.x = bounds.centerX;
      else if (mode === "right") node.x = bounds.maxX - node.width / 2;
      else if (mode === "top") node.y = bounds.minY + node.height / 2;
      else if (mode === "middleY") node.y = bounds.centerY;
      else if (mode === "bottom") node.y = bounds.maxY - node.height / 2;
    }
    this.render();
  }

  private distributeSelectedNodes(mode: DistributionMode): void {
    const nodes = [...this.selectedNodes()].sort((a, b) => mode === "horizontal" ? a.x - b.x : a.y - b.y);
    if (nodes.length < 3) return;
    this.recordHistory();
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    const step = mode === "horizontal" ? (last.x - first.x) / (nodes.length - 1) : (last.y - first.y) / (nodes.length - 1);
    nodes.forEach((node, index) => {
      this.clearRenderedPathsForNode(node.id);
      if (mode === "horizontal") node.x = first.x + step * index;
      else node.y = first.y + step * index;
    });
    this.render();
  }

  private fitDiagramToStage(): void {
    if (!this.stage) return;
    const bounds = this.getCanvasBounds();
    const nextZoom = this.clamp(Math.min((this.stage.clientWidth - 32) / bounds.width, (this.stage.clientHeight - 32) / bounds.height), MIN_EDITOR_ZOOM, MAX_EDITOR_ZOOM);
    this.editorZoom = nextZoom;
    this.applyCanvasViewport();
    this.stage.scrollLeft = 0;
    this.stage.scrollTop = 0;
    this.renderStatusBar();
    this.renderMinimap();
  }

  private centerSelectionInStage(): void {
    const nodes = this.selectedNodes();
    if (nodes.length > 0) {
      const bounds = this.getNodeBounds(nodes);
      this.centerStageOnCanvasPoint({ x: bounds.centerX, y: bounds.centerY });
      return;
    }
    const bounds = this.getCanvasBounds();
    this.centerStageOnCanvasPoint({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 });
  }

  private centerStageOnCanvasPoint(point: CanvasPoint): void {
    if (!this.stage) return;
    const bounds = this.getCanvasBounds();
    this.stage.scrollLeft = Math.max(0, (point.x - bounds.minX) * this.editorZoom - this.stage.clientWidth / 2);
    this.stage.scrollTop = Math.max(0, (point.y - bounds.minY) * this.editorZoom - this.stage.clientHeight / 2);
    this.renderMinimap();
  }

  private getNodeBounds(nodes: DiagramNode[]): { minX: number; minY: number; maxX: number; maxY: number; centerX: number; centerY: number; width: number; height: number } {
    const minX = Math.min(...nodes.map((node) => node.x - node.width / 2));
    const minY = Math.min(...nodes.map((node) => node.y - node.height / 2));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width / 2));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height / 2));
    return { minX, minY, maxX, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
  }

  private async save(): Promise<void> {
    if (this.sourceEditing) this.applySourceDraft(false);
    const nextSource = this.currentSource();
    await this.onSave(nextSource);
    this.savedSource = nextSource;
    this.suppressClosePrompt = false;
    new Notice("Mermaid diagram updated.");
    this.render();
  }

  private updateCodePreview(): void {
    if (this.codePreview && !this.sourceEditing) this.codePreview.value = this.currentSource();
  }

  private applySourceDraft(renderAfter = true): void {
    const source = this.sourceDraft ?? this.codePreview?.value ?? this.currentSource();
    this.recordHistory();
    this.diagram = parseFlowchart(source, this.diagram.direction);
    this.editorSelection = null;
    this.sourceEditing = false;
    this.sourceDraft = undefined;
    if (renderAfter) this.render();
  }

  private currentSource(): string {
    return generateFlowchart(this.diagram);
  }

  private createSourceDiff(): string {
    const previous = this.savedSource.trimEnd().split(/\r?\n/);
    const next = this.currentSource().trimEnd().split(/\r?\n/);
    if (previous.join("\n") === next.join("\n")) return "";
    const lines: string[] = [];
    const max = Math.max(previous.length, next.length);
    for (let index = 0; index < max; index += 1) {
      const before = previous[index];
      const after = next[index];
      if (before === after) continue;
      if (before !== undefined) lines.push(`- ${before}`);
      if (after !== undefined) lines.push(`+ ${after}`);
      if (lines.length > 80) {
        lines.push("...");
        break;
      }
    }
    return lines.join("\n");
  }

  private createChangeSummary(): string[] {
    const previous = parseFlowchart(this.savedSource, this.diagram.direction);
    const items: string[] = [];
    let nodeTextChanges = 0;
    let nodeStyleChanges = 0;
    let layoutChanges = 0;
    let connectorChanges = 0;
    const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
    for (const node of this.diagram.nodes) {
      const before = previousNodes.get(node.id);
      if (!before) {
        nodeTextChanges += 1;
        continue;
      }
      if (before.label !== node.label || before.shape !== node.shape) nodeTextChanges += 1;
      if (before.fillColor !== node.fillColor || before.strokeColor !== node.strokeColor || before.textColor !== node.textColor || before.strokeWidth !== node.strokeWidth || before.textSize !== node.textSize) nodeStyleChanges += 1;
      if (Math.round(before.x) !== Math.round(node.x) || Math.round(before.y) !== Math.round(node.y) || Math.round(before.width) !== Math.round(node.width) || Math.round(before.height) !== Math.round(node.height)) layoutChanges += 1;
    }
    const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
    for (const edge of this.diagram.edges) {
      const before = previousEdges.get(edge.id);
      if (!before || before.from !== edge.from || before.to !== edge.to || before.label !== edge.label || before.style !== edge.style || before.route !== edge.route || before.strokeColor !== edge.strokeColor || before.textColor !== edge.textColor || before.strokeWidth !== edge.strokeWidth || before.textSize !== edge.textSize) connectorChanges += 1;
    }
    if (nodeTextChanges > 0) items.push(`${nodeTextChanges} node text or shape change(s)`);
    if (nodeStyleChanges > 0) items.push(`${nodeStyleChanges} node style change(s)`);
    if (connectorChanges > 0) items.push(`${connectorChanges} connector change(s)`);
    if (layoutChanges > 0) items.push(`${layoutChanges} editor layout change(s)`);
    if (previous.freeLines.length !== this.diagram.freeLines.length) items.push("Free line count changed");
    return items;
  }

  private hasUnsavedChanges(): boolean {
    if (this.sourceEditing && this.sourceDraft !== undefined && this.sourceDraft !== this.currentSource()) return true;
    return this.currentSource() !== this.savedSource;
  }

  private showDiscardChangesPrompt(): void {
    if (this.discardPromptOpen) return;
    this.discardPromptOpen = true;
    new MermaidDiscardChangesModal(
      this.app,
      () => {
        this.discardPromptOpen = false;
        this.suppressClosePrompt = true;
        this.close();
      },
      () => {
        this.discardPromptOpen = false;
      },
    ).open();
  }

  private recordHistory(): void {
    this.history.push(this.diagram);
  }

  private undoHistory(): void {
    const previous = this.history.undo(this.diagram);
    if (!previous) return;
    this.restoreHistory(previous);
  }

  private redoHistory(): void {
    const next = this.history.redo(this.diagram);
    if (!next) return;
    this.restoreHistory(next);
  }

  private restoreHistory(diagram: FlowDiagram): void {
    this.diagram = diagram;
    this.editorSelection = null;
    this.keyboardMoveHistoryRecorded = false;
    this.sourceEditing = false;
    this.sourceDraft = undefined;
    this.cancelShapePlacement();
    this.endDrag();
    this.endResize();
    this.endConnectionDrag();
    this.endFreeLineDraw();
    this.endLabelDrag();
    this.selectedShape = undefined;
    this.selectedConnector = undefined;
    this.previewPoint = undefined;
    this.clearConnectionMode();
    this.canvas?.removeClass("is-placing");
    this.updatePaletteState();
    this.render();
  }

  private isEditableKeyTarget(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement) return true;
    return target instanceof HTMLElement && target.isContentEditable;
  }

  private cancelActiveTool(): boolean {
    if (!this.selectedShape && !this.selectedConnector && !this.connectingFromNodeId && !this.freeLineDraft && !this.placement) return false;
    this.cancelShapePlacement();
    this.endConnectionDrag();
    this.endFreeLineDraw();
    this.selectedShape = undefined;
    this.selectedConnector = undefined;
    this.previewPoint = undefined;
    this.clearConnectionMode();
    this.canvas?.removeClass("is-placing");
    this.updatePaletteState();
    this.render();
    return true;
  }

  private deleteSelection(): boolean {
    const selection = this.editorSelection;
    if (!selection) return false;
    if (selection.kind === "node") {
      if (this.selectedNodeIds.size > 1) this.deleteSelectedNodes();
      else this.deleteNode(selection.id);
    }
    else if (selection.kind === "edge") this.deleteEdge(selection.id);
    else this.deleteFreeLine(selection.id);
    return true;
  }

  private editSelectionText(): boolean {
    const selection = this.editorSelection;
    if (!selection) return false;
    if (selection.kind === "node") {
      const node = this.diagram.nodes.find((item) => item.id === selection.id);
      if (!node) return false;
      this.promptNodeLabel(node);
      return true;
    }
    if (selection.kind === "edge") {
      const edge = this.diagram.edges.find((item) => item.id === selection.id);
      if (!edge) return false;
      this.promptEdgeLabel(edge);
      return true;
    }

    const line = this.diagram.freeLines.find((item) => item.id === selection.id);
    if (!line) return false;
    this.promptFreeLineLabel(line);
    return true;
  }

  private moveSelection(deltaX: number, deltaY: number, recordHistory = false): boolean {
    const selection = this.editorSelection;
    if (!selection) return false;

    if (selection.kind === "node") {
      const nodes = this.selectedNodes();
      if (nodes.length === 0) return false;
      if (recordHistory) this.recordHistory();
      for (const node of nodes) {
        this.clearRenderedPathsForNode(node.id);
        node.x += deltaX;
        node.y += deltaY;
      }
      this.renderCanvas();
      this.updateCodePreview();
      return true;
    }

    if (selection.kind === "freeLine") {
      const line = this.diagram.freeLines.find((item) => item.id === selection.id);
      if (!line) return false;
      if (recordHistory) this.recordHistory();
      line.x1 += deltaX;
      line.x2 += deltaX;
      line.y1 += deltaY;
      line.y2 += deltaY;
      this.renderCanvas();
      this.updateCodePreview();
      return true;
    }

    return false;
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
    this.editorSelection = { kind: "node", id: nodeId };
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
      this.recordHistory();
      if (this.selectedConnector) existing.style = this.selectedConnector.style;
      this.editorSelection = { kind: "edge", id: existing.id };
      this.clearConnectionMode();
      this.render();
      return;
    }

    this.recordHistory();
    const edge = createEdge(this.diagram, this.connectingFromNodeId, targetNodeId);
    if (this.selectedConnector) edge.style = this.selectedConnector.style;
    this.editorSelection = { kind: "edge", id: edge.id };
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
        this.editorSelection = { kind: "node", id: this.connectingFromNodeId };
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
      this.recordHistory();
      if (state.endpoint === "from") edge.from = target.id;
      else edge.to = target.id;
      this.editorSelection = { kind: "edge", id: edge.id };
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

  private applyShapeToSelectedNodes(shape: NodeShape): void {
    const nodes = this.selectedNodes();
    if (nodes.length === 0) return;
    if (nodes.every((node) => node.shape === shape)) return;
    this.recordHistory();
    for (const node of nodes) node.shape = shape;
    this.render();
  }

  private applyStyleToSelectedConnector(style: EdgeStyle): void {
    const selection = this.editorSelection;
    if (selection?.kind === "edge") {
      const edge = this.diagram.edges.find((item) => item.id === selection.id);
      if (!edge || edge.style === style) return;
      this.setEdgeStyle(edge, style);
      return;
    }
    if (selection?.kind === "freeLine") {
      const line = this.diagram.freeLines.find((item) => item.id === selection.id);
      if (!line || line.style === style) return;
      this.setFreeLineStyle(line, style);
    }
  }

  private selectedNodeShape(): NodeShape | undefined {
    const nodes = this.selectedNodes();
    if (nodes.length === 0) return undefined;
    const [first] = nodes;
    return first && nodes.every((node) => node.shape === first.shape) ? first.shape : undefined;
  }

  private selectedConnectorStyle(): EdgeStyle | undefined {
    const selection = this.editorSelection;
    if (selection?.kind === "edge") return this.diagram.edges.find((item) => item.id === selection.id)?.style;
    if (selection?.kind === "freeLine") return this.diagram.freeLines.find((item) => item.id === selection.id)?.style;
    return undefined;
  }

  private handleConnectorToolNodeClick(nodeId: string): void {
    if (!this.selectedConnector) return;
    if (!this.connectingFromNodeId) {
      this.connectingFromNodeId = nodeId;
      this.editorSelection = { kind: "node", id: nodeId };
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
    this.recordHistory();
    const edge = existing ?? createEdge(this.diagram, this.connectingFromNodeId, nodeId);
    edge.style = this.selectedConnector.style;
    this.editorSelection = { kind: "edge", id: edge.id };
    this.clearConnectionMode();
    this.updatePaletteState();
    this.render();
  }

  private updatePaletteState(): void {
    const buttons = this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-palette-item[data-shape]");
    for (const button of Array.from(buttons)) {
      const activeShape = button.dataset.shapeAction === "apply" ? this.selectedNodeShape() : this.selectedShape;
      const active = button.dataset.shape === activeShape;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const connectorButtons = this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-connector-tool[data-connector-style]");
    for (const button of Array.from(connectorButtons)) {
      const active = button.dataset.connectorStyle === this.selectedConnector?.style;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const styleButtons = this.modalEl.querySelectorAll<HTMLButtonElement>(".owen-mermaid-palette-item[data-edge-style]");
    for (const button of Array.from(styleButtons)) {
      const active = button.dataset.edgeStyle === this.selectedConnectorStyle();
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
    this.recordHistory();
    const node = createNode(this.diagram, this.selectedShape);
    const point = this.toBoundedCanvasPoint(event);
    const snapped = this.snapPoint(point);
    node.x = snapped.x;
    node.y = snapped.y;
    this.editorSelection = { kind: "node", id: node.id };
    this.setSelectedShapeTool(undefined);
    this.render();
  }

  private renderStageZoomControls(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "owen-mermaid-editor-zoom-toolbar" });
    this.createButton(toolbar, "zoom-out", "Zoom out", () => this.setEditorZoom(this.editorZoom - EDITOR_ZOOM_STEP));
    this.zoomLabel = toolbar.createSpan({ cls: "owen-mermaid-editor-zoom-label", text: "100%" });
    this.createButton(toolbar, "zoom-in", "Zoom in", () => this.setEditorZoom(this.editorZoom + EDITOR_ZOOM_STEP));
    this.createButton(toolbar, "rotate-ccw", "Reset zoom", () => this.setEditorZoom(1));
  }

  private createModalResizeHandle(shell: HTMLElement): void {
    const handle = shell.createEl("button", { cls: "owen-mermaid-window-resize-handle", attr: { type: "button", title: "Resize editor", "aria-label": "Resize editor" } });
    setIcon(handle, "grip");
    handle.addEventListener("pointerdown", (event) => this.beginModalResize(event));
  }

  private beginModalResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endModalResize();

    const rect = this.modalEl.getBoundingClientRect();
    this.modalResizeState = {
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
    };
    this.modalEl.addClass("is-window-resizing");

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateModalResize(moveEvent);
    const up = () => this.endModalResize();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeModalResizeListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private updateModalResize(event: PointerEvent): void {
    const state = this.modalResizeState;
    if (!state) return;

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const maxWidth = Math.max(320, win.innerWidth - 36);
    const maxHeight = Math.max(320, win.innerHeight - 36);
    const minWidth = Math.min(760, maxWidth);
    const minHeight = Math.min(520, maxHeight);
    const width = this.clamp(state.startWidth + event.clientX - state.startPointerX, minWidth, maxWidth);
    const height = this.clamp(state.startHeight + event.clientY - state.startPointerY, minHeight, maxHeight);

    this.modalEl.style.width = `${Math.round(width)}px`;
    this.modalEl.style.height = `${Math.round(height)}px`;
    this.modalEl.style.maxWidth = `${maxWidth}px`;
    this.modalEl.style.maxHeight = `${maxHeight}px`;
    this.renderMinimap();
  }

  private endModalResize(): void {
    this.removeModalResizeListeners?.();
    this.removeModalResizeListeners = undefined;
    this.modalResizeState = undefined;
    this.modalEl.removeClass("is-window-resizing");
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
    this.renderMinimap();
    this.renderStatusBar();
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

  private renderMinimap(): void {
    if (!this.minimap || !this.stage) return;
    const bounds = this.getCanvasBounds();
    const scale = Math.min((MINIMAP_WIDTH - 16) / bounds.width, (MINIMAP_HEIGHT - 16) / bounds.height);
    const offsetX = (MINIMAP_WIDTH - bounds.width * scale) / 2;
    const offsetY = (MINIMAP_HEIGHT - bounds.height * scale) / 2;
    const mapX = (x: number) => offsetX + (x - bounds.minX) * scale;
    const mapY = (y: number) => offsetY + (y - bounds.minY) * scale;
    this.minimap.empty();
    this.minimap.createSvg("rect", { cls: "owen-mermaid-minimap-bg", attr: { x: "0", y: "0", width: String(MINIMAP_WIDTH), height: String(MINIMAP_HEIGHT), rx: "8" } });
    for (const line of this.diagram.freeLines) {
      this.minimap.createSvg("line", { cls: "owen-mermaid-minimap-line", attr: { x1: String(mapX(line.x1)), y1: String(mapY(line.y1)), x2: String(mapX(line.x2)), y2: String(mapY(line.y2)), ...this.strokeStyleAttrs(line.strokeColor, line.strokeWidth) } });
    }
    for (const node of this.diagram.nodes) {
      const rect = this.minimap.createSvg("rect", {
        cls: "owen-mermaid-minimap-node",
        attr: { x: String(mapX(node.x - node.width / 2)), y: String(mapY(node.y - node.height / 2)), width: String(Math.max(3, node.width * scale)), height: String(Math.max(3, node.height * scale)), rx: "2", ...this.nodeStyleAttrs(node) },
      });
      if (this.isNodeSelected(node.id)) rect.addClass("is-selected");
    }
    const viewX = bounds.minX + this.stage.scrollLeft / this.editorZoom;
    const viewY = bounds.minY + this.stage.scrollTop / this.editorZoom;
    this.minimap.createSvg("rect", {
      cls: "owen-mermaid-minimap-view",
      attr: { x: String(mapX(viewX)), y: String(mapY(viewY)), width: String((this.stage.clientWidth / this.editorZoom) * scale), height: String((this.stage.clientHeight / this.editorZoom) * scale), rx: "3" },
    });
  }

  private handleMinimapPointer(event: PointerEvent): void {
    if (!this.minimap) return;
    event.preventDefault();
    const bounds = this.getCanvasBounds();
    const scale = Math.min((MINIMAP_WIDTH - 16) / bounds.width, (MINIMAP_HEIGHT - 16) / bounds.height);
    const offsetX = (MINIMAP_WIDTH - bounds.width * scale) / 2;
    const offsetY = (MINIMAP_HEIGHT - bounds.height * scale) / 2;
    const rect = this.minimap.getBoundingClientRect();
    const x = bounds.minX + (event.clientX - rect.left - offsetX) / scale;
    const y = bounds.minY + (event.clientY - rect.top - offsetY) / scale;
    this.centerStageOnCanvasPoint({ x, y });
  }

  private renderStatusBar(): void {
    if (!this.statusBar) return;
    const selected = this.selectedNodeIds.size > 1 ? `${this.selectedNodeIds.size} nodes` : this.editorSelection ? `${this.editorSelection.kind}` : "none";
    const sourceState = this.hasUnsavedChanges() ? "changed" : "saved";
    const unsupported = this.diagram.unsupportedLines.length > 0 ? `, ${this.diagram.unsupportedLines.length} preserved` : "";
    this.statusBar.setText(`Zoom ${Math.round(this.editorZoom * 100)}% | Snap ${this.snapEnabled ? this.snapSize : "off"} | Selection ${selected} | ${sourceState}${unsupported}`);
  }

  private beginNodeDrag(node: DiagramNode, event: PointerEvent): void {
    this.endDrag();
    this.recordHistory();
    this.draggingNodeId = node.id;
    const nodes = this.selectedNodeIds.has(node.id) ? this.selectedNodes() : [node];
    this.draggedNodeStarts = new Map(nodes.map((item) => [item.id, { x: item.x, y: item.y }]));
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
    const point = this.toCanvasPoint(event);
    const snapped = this.snapPoint({ x: point.x - this.dragOffset.x, y: point.y - this.dragOffset.y });
    const primaryStart = this.draggedNodeStarts.get(node.id) ?? { x: node.x, y: node.y };
    const deltaX = snapped.x - primaryStart.x;
    const deltaY = snapped.y - primaryStart.y;
    for (const [nodeId, start] of this.draggedNodeStarts) {
      const dragged = this.diagram.nodes.find((item) => item.id === nodeId);
      if (!dragged) continue;
      this.clearRenderedPathsForNode(dragged.id);
      dragged.x = start.x + deltaX;
      dragged.y = start.y + deltaY;
    }
    this.renderCanvas();
    this.updateCodePreview();
  }

  private endDrag(): void {
    this.removeNodeDragListeners?.();
    this.removeNodeDragListeners = undefined;
    this.draggingNodeId = undefined;
    this.draggedNodeStarts.clear();
  }

  private beginResize(node: DiagramNode, handle: ResizeHandle, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endResize();
    this.recordHistory();
    this.setSelectedShapeTool(undefined);
    this.editorSelection = { kind: "node", id: node.id };
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
    this.editorSelection = null;

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
    this.recordHistory();
    this.diagram.freeLines.push(line);
    this.editorSelection = { kind: "freeLine", id: line.id };
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
    const point = this.toBoundedCanvasPoint(event);
    this.placement.point = this.snapPoint(point);
    this.previewPoint = this.placement.point;
    this.renderCanvas();
  }

  private finishShapePlacement(event: PointerEvent): void {
    this.updateShapePlacement(event);
    const placement = this.placement;
    const placed = Boolean(placement?.point);
    if (placement?.point) {
      this.recordHistory();
      const node = createNode(this.diagram, placement.shape);
      node.x = placement.point.x;
      node.y = placement.point.y;
      this.editorSelection = { kind: "node", id: node.id };
    }
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
    this.previewPoint = undefined;
    if (!this.selectedShape) this.canvas?.removeClass("is-placing");
  }

  private placeShapeAtCenter(shape: NodeShape): void {
    this.recordHistory();
    const node = createNode(this.diagram, shape);
    node.x = 490;
    node.y = 340;
    this.editorSelection = { kind: "node", id: node.id };
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
    if (!this.snapEnabled) return point;
    const size = Math.max(MIN_SNAP_SIZE, this.snapSize);
    return {
      x: Math.round(point.x / size) * size,
      y: Math.round(point.y / size) * size,
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
    if (from.id === to.id) {
      return {
        from: { x: from.x + from.width / 2, y: from.y - from.height / 4 },
        to: { x: from.x, y: from.y - from.height / 2 },
      };
    }
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

  private createConnectorPath(from: CanvasPoint, to: CanvasPoint, route: EdgeRoute = "curve"): string {
    if (route === "straight") return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    if (route === "elbow") {
      const midX = (from.x + to.x) / 2;
      return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
    }
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

  private getLabelPoint(from: CanvasPoint, to: CanvasPoint, offsetX = 0, offsetY = 0): CanvasPoint {
    return { x: (from.x + to.x) / 2 + offsetX, y: (from.y + to.y) / 2 - 8 + offsetY };
  }

  private beginLabelDrag(kind: "edge" | "freeLine", id: string, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endLabelDrag();
    this.recordHistory();
    const item = kind === "edge" ? this.diagram.edges.find((edge) => edge.id === id) : this.diagram.freeLines.find((line) => line.id === id);
    if (!item) return;
    this.editorSelection = kind === "edge" ? { kind: "edge", id } : { kind: "freeLine", id };
    this.labelDragState = { kind, id, startPointer: this.toCanvasPoint(event), startOffsetX: item.labelOffsetX ?? 0, startOffsetY: item.labelOffsetY ?? 0 };
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateLabelDrag(moveEvent);
    const up = () => this.endLabelDrag();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeLabelDragListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private updateLabelDrag(event: PointerEvent): void {
    const state = this.labelDragState;
    if (!state) return;
    event.preventDefault();
    const point = this.toCanvasPoint(event);
    const item = state.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === state.id) : this.diagram.freeLines.find((line) => line.id === state.id);
    if (!item) return;
    item.labelOffsetX = state.startOffsetX + point.x - state.startPointer.x;
    item.labelOffsetY = state.startOffsetY + point.y - state.startPointer.y;
    this.renderCanvas();
    this.updateCodePreview();
  }

  private endLabelDrag(): void {
    this.removeLabelDragListeners?.();
    this.removeLabelDragListeners = undefined;
    this.labelDragState = undefined;
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

class MermaidDiscardChangesModal extends Modal {
  private handled = false;

  constructor(
    app: App,
    private readonly onDiscard: () => void,
    private readonly onKeepEditing: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("owen-mermaid-confirm-modal");
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-confirm-shell" });
    shell.createEl("h3", { text: "Discard Mermaid changes?" });
    shell.createEl("p", { text: "Your visual editor changes have not been applied to the note." });

    const actions = shell.createDiv({ cls: "owen-mermaid-confirm-actions" });
    const keep = actions.createEl("button", { text: "Keep editing", attr: { type: "button" } });
    const discard = actions.createEl("button", { cls: "is-danger", text: "Discard", attr: { type: "button" } });

    keep.addEventListener("click", () => this.finish(false));
    discard.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    if (!this.handled) this.onKeepEditing();
  }

  private finish(discard: boolean): void {
    if (this.handled) return;
    this.handled = true;
    this.close();
    if (discard) this.onDiscard();
    else this.onKeepEditing();
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
