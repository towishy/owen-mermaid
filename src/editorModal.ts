import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import { createConnectorPath as createEditorConnectorPath, getConnectorLabelPoint } from "./editorGeometry";
import { HistoryStack } from "./editorHistory";
import { assessSourceDraft as assessMermaidSourceDraft, createChangeSummary as createMermaidChangeSummary, createSourceDiagnostics as createMermaidSourceDiagnostics, createSourceDiffLines as createMermaidSourceDiffLines, generateEditorSource } from "./editorSource";
import { cloneDiagram, createEdge, createNode, generateFlowchart, parseFlowchart } from "./flowchart";
import { createTranslator, type Locale, type Translator } from "./i18n";
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
const SMART_GUIDE_THRESHOLD = 7;
const COPY_OFFSET = 34;

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "freeLine"; id: string } | null;
type ShapePlacement = { shape: NodeShape; point?: CanvasPoint };
type ConnectorTool = { style: EdgeStyle } | undefined;
type CanvasPoint = { x: number; y: number };
type ConnectionHandle = "top" | "right" | "bottom" | "left";
type ResizeHandle = "nw" | "ne" | "se" | "sw";
type AlignmentMode = "left" | "centerX" | "right" | "top" | "middleY" | "bottom";
type DistributionMode = "horizontal" | "vertical";
type ColorTarget = "nodeFill" | "nodeStroke" | "nodeText" | "edgeStroke" | "edgeText";
type InspectorTab = "inspect" | "source" | "changes";

interface SmartGuide {
  orientation: "vertical" | "horizontal";
  position: number;
}

interface EditorClipboard {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  freeLines: DiagramFreeLine[];
}

interface EditorAction {
  label: string;
  keywords: string;
  run: () => void;
}

interface EditorSnapshot {
  diagram: FlowDiagram;
  selection: Selection;
  selectedNodeIds: string[];
}

const COLOR_TARGET_KEYS: Array<{ value: ColorTarget; label: "editor.shapeFill" | "editor.shapeLine" | "editor.shapeText" | "editor.lineArrow" | "editor.lineLabel"; icon: string }> = [
  { value: "nodeFill", label: "editor.shapeFill", icon: "paint-bucket" },
  { value: "nodeStroke", label: "editor.shapeLine", icon: "square" },
  { value: "nodeText", label: "editor.shapeText", icon: "type" },
  { value: "edgeStroke", label: "editor.lineArrow", icon: "minus" },
  { value: "edgeText", label: "editor.lineLabel", icon: "type" },
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

function cloneEditorSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    diagram: cloneDiagram(snapshot.diagram),
    selection: snapshot.selection ? { ...snapshot.selection } : null,
    selectedNodeIds: [...snapshot.selectedNodeIds],
  };
}

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

interface WaypointDragState {
  kind: "edge" | "freeLine";
  id: string;
  index: number;
}

interface ModalResizeState {
  startPointerX: number;
  startPointerY: number;
  startWidth: number;
  startHeight: number;
}

interface StagePanState {
  startPointerX: number;
  startPointerY: number;
  startScrollLeft: number;
  startScrollTop: number;
  moved: boolean;
}

export class MermaidEditorModal extends Modal {
  private readonly t: Translator;
  private diagram: FlowDiagram;
  private savedSource: string;
  private activeSelection: Selection = null;
  private stage?: HTMLElement;
  private canvas?: SVGSVGElement;
  private ribbon?: HTMLElement;
  private ribbonContextKey = "";
  private zoomLabel?: HTMLElement;
  private statusBar?: HTMLElement;
  private inspector?: HTMLElement;
  private codePreview?: HTMLTextAreaElement;
  private diffPreview?: HTMLElement;
  private applyButton?: HTMLButtonElement;
  private applyButtonLabel?: HTMLSpanElement;
  private inspectorToggleButton?: HTMLButtonElement;
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
  private removeWaypointDragListeners?: () => void;
  private removeModalResizeListeners?: () => void;
  private removeStagePanListeners?: () => void;
  private resizeState?: ResizeState;
  private reconnectState?: ReconnectState;
  private labelDragState?: LabelDragState;
  private waypointDragState?: WaypointDragState;
  private modalResizeState?: ModalResizeState;
  private stagePanState?: StagePanState;
  private suppressNextCanvasClick = false;
  private suppressNextPaletteClick = false;
  private suppressClosePrompt = false;
  private discardPromptOpen = false;
  private isSaving = false;
  private keyboardMoveHistoryRecorded = false;
  private sourceEditing = false;
  private sourceDraft?: string;
  private pendingCanvasFrame = 0;
  private pendingCodePreviewUpdate = false;
  private snapEnabled = true;
  private snapSize = DEFAULT_SNAP_SIZE;
  private editorZoom = 1;
  private inspectorTab: InspectorTab = "inspect";
  private inspectorVisible = true;
  private copiedSelection?: EditorClipboard;
  private smartGuides: SmartGuide[] = [];
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
  private readonly history = new HistoryStack<EditorSnapshot>(cloneEditorSnapshot);
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

    if (modifier && key === "c" && this.copySelection()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (modifier && key === "v" && this.pasteSelection()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (modifier && key === "a" && this.selectAllNodes()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (modifier && key === "k") {
      event.preventDefault();
      event.stopPropagation();
      this.openActionPalette();
      return;
    }

    if (modifier && key === "0") {
      event.preventDefault();
      event.stopPropagation();
      this.fitDiagramToStage();
      return;
    }

    if (modifier && key === "1") {
      event.preventDefault();
      event.stopPropagation();
      this.setEditorZoom(1);
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
    private readonly locale: Locale = "en",
  ) {
    super(app);
    this.t = createTranslator(locale);
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
    this.createButton(actions, "undo-2", this.t("editor.undo"), () => this.undoHistory());
    this.createButton(actions, "redo-2", this.t("editor.redo"), () => this.redoHistory());
    this.createButton(actions, "rotate-ccw", this.t("editor.autoLayout"), () => this.autoLayout()).addClass("owen-mermaid-header-auto-layout");
    this.createButton(actions, "command", this.t("editor.actions"), () => this.openActionPalette());
    this.inspectorToggleButton = this.createButton(actions, "panel-right-close", this.t("editor.hideInspector"), () => this.setInspectorVisible(!this.inspectorVisible));
    this.inspectorToggleButton.addClass("owen-mermaid-inspector-toggle");
    this.setInspectorVisible(this.inspectorVisible);
    this.applyButton = this.createButton(actions, "save", this.t("common.apply"), () => void this.save());
    this.applyButton.addClass("owen-mermaid-primary-action");
    this.applyButtonLabel = this.applyButton.createSpan({ cls: "owen-mermaid-primary-action-label", text: this.t("common.apply") });
    this.createButton(actions, "x", this.t("common.close"), () => this.close());

    this.ribbon = shell.createDiv({ cls: "owen-mermaid-editor-ribbon" });
    this.renderRibbon(true);

    const body = shell.createDiv({ cls: "owen-mermaid-editor-body" });
    this.stage = body.createDiv({ cls: "owen-mermaid-editor-stage" });
    this.stage.addEventListener("wheel", (event) => this.handleStageWheel(event), { passive: false });
    this.stage.addEventListener("pointerdown", (event) => this.beginStagePan(event));
    this.canvas = this.stage.createSvg("svg", { cls: "owen-mermaid-canvas" });
    this.bindCanvas(this.canvas);

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
    this.endWaypointDrag();
    this.endModalResize();
    this.endStagePan();
    this.cancelScheduledCanvasRefresh();
    this.ribbon = undefined;
    this.ribbonContextKey = "";
    this.applyButton = undefined;
    this.applyButtonLabel = undefined;
    this.inspectorToggleButton = undefined;
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
      this.renderStylePresetGroup(parent);
      if (this.selectedNodeIds.size > 1) this.renderArrangeGroup(parent);
      this.renderViewRibbonGroup(parent);
      return;
    }

    this.renderConnectorStyleGroup(parent);
    this.renderColorGroup(parent);
    this.renderStylePresetGroup(parent);
    this.renderViewRibbonGroup(parent);
  }

  private renderShapeToolGroup(parent: HTMLElement): void {
    const shapesGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    shapesGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.shapes") });
    const shapeButtons = shapesGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.shapeTools()) {
      const button = shapeButtons.createEl("button", {
        cls: "owen-mermaid-palette-item",
        attr: { type: "button", "data-shape": item.shape, "data-shape-action": "create", "aria-pressed": "false", title: this.t("editor.shapeClickHint", { label: item.label }) },
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
    shapeGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.shape") });
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
    connectorGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.connect") });
    const connectorButtons = connectorGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    for (const item of this.connectorTools(false)) {
      const button = connectorButtons.createEl("button", {
        cls: "owen-mermaid-palette-item owen-mermaid-connector-tool",
        attr: { type: "button", "data-connector-style": item.style, "aria-pressed": "false", title: this.t("editor.connectorClickHint", { label: item.label }) },
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
    group.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.line") });
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
    colorGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.color") });
    this.renderColorRibbon(colorGroup);
  }

  private renderStylePresetGroup(parent: HTMLElement): void {
    if (!this.editorSelection) return;
    const group = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    group.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.preset") });
    const items = group.createDiv({ cls: "owen-mermaid-ribbon-items" });
    const presets = this.editorSelection.kind === "node"
      ? [
        { label: this.t("editor.calm"), icon: "sparkles", fill: "#f8fafc", stroke: "#94a3b8", text: "#172033" },
        { label: this.t("editor.focus"), icon: "badge-check", fill: "#dbeafe", stroke: "#0ea5e9", text: "#172033" },
        { label: this.t("editor.warn"), icon: "triangle-alert", fill: "#fef3c7", stroke: "#f59e0b", text: "#172033" },
      ]
      : [
        { label: this.t("editor.graphite"), icon: "minus", stroke: "#64748b", text: "#172033" },
        { label: this.t("editor.sky"), icon: "waves", stroke: "#0ea5e9", text: "#0369a1" },
        { label: this.t("editor.rose"), icon: "activity", stroke: "#f43f5e", text: "#9f1239" },
      ];
    for (const preset of presets) this.createRibbonButton(items, preset.icon, preset.label, () => this.applyStylePreset(preset));
  }

  private renderDiagramGroup(parent: HTMLElement): void {
    const diagramGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    diagramGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.diagram") });
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
    arrangeGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.arrange") });
    const arrangeButtons = arrangeGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    this.createRibbonButton(arrangeButtons, "align-start-horizontal", this.t("editor.left"), () => this.alignSelectedNodes("left"));
    this.createRibbonButton(arrangeButtons, "align-center-horizontal", this.t("editor.center"), () => this.alignSelectedNodes("centerX"));
    this.createRibbonButton(arrangeButtons, "align-end-horizontal", this.t("editor.right"), () => this.alignSelectedNodes("right"));
    this.createRibbonButton(arrangeButtons, "align-start-vertical", this.t("editor.top"), () => this.alignSelectedNodes("top"));
    this.createRibbonButton(arrangeButtons, "align-center-vertical", this.t("editor.middle"), () => this.alignSelectedNodes("middleY"));
    this.createRibbonButton(arrangeButtons, "align-end-vertical", this.t("editor.bottom"), () => this.alignSelectedNodes("bottom"));
    this.createRibbonButton(arrangeButtons, "rows-3", this.t("editor.horizontalSpace"), () => this.distributeSelectedNodes("horizontal"));
    this.createRibbonButton(arrangeButtons, "columns-3", this.t("editor.verticalSpace"), () => this.distributeSelectedNodes("vertical"));
  }

  private renderViewRibbonGroup(parent: HTMLElement): void {
    const viewGroup = parent.createDiv({ cls: "owen-mermaid-ribbon-group" });
    viewGroup.createEl("div", { cls: "owen-mermaid-ribbon-label", text: this.t("editor.view") });
    const viewButtons = viewGroup.createDiv({ cls: "owen-mermaid-ribbon-items" });
    this.createRibbonButton(viewButtons, "zoom-out", this.t("zoom.out"), () => this.setEditorZoom(this.editorZoom - EDITOR_ZOOM_STEP));
    this.zoomLabel = viewButtons.createSpan({ cls: "owen-mermaid-ribbon-zoom-label", text: `${Math.round(this.editorZoom * 100)}%` });
    this.createRibbonButton(viewButtons, "zoom-in", this.t("zoom.in"), () => this.setEditorZoom(this.editorZoom + EDITOR_ZOOM_STEP));
    this.createRibbonButton(viewButtons, "rotate-ccw", this.t("editor.resetZoom"), () => this.setEditorZoom(1));
    this.createRibbonButton(viewButtons, "scan", this.t("editor.fit"), () => this.fitDiagramToStage());
    this.createRibbonButton(viewButtons, "locate-fixed", this.t("editor.center"), () => this.centerSelectionInStage());
    const snapToggle = viewButtons.createEl("button", { cls: "owen-mermaid-palette-item", attr: { type: "button", title: this.t("editor.toggleSnap"), "aria-label": this.t("editor.toggleSnap"), "aria-pressed": this.snapEnabled ? "true" : "false" } });
    setIcon(snapToggle, "magnet");
    snapToggle.createSpan({ cls: "owen-mermaid-ribbon-item-label", text: this.t("editor.snap") });
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
      { shape: "rectangle", label: this.t("editor.rectangle"), icon: "square" },
      { shape: "rounded", label: this.t("editor.rounded"), icon: "box" },
      { shape: "stadium", label: this.t("editor.stadium"), icon: "pill" },
      { shape: "diamond", label: this.t("editor.decision"), icon: "diamond" },
      { shape: "circle", label: this.t("editor.circle"), icon: "circle" },
    ];
  }

  private connectorTools(includeFreeLineStyles: boolean): Array<{ style: EdgeStyle; label: string; icon: string }> {
    const styles: Array<{ style: EdgeStyle; label: string; icon: string }> = [
      { style: "arrow", label: this.t("editor.arrow"), icon: "arrow-right" },
      { style: "line", label: this.t("editor.line"), icon: "minus" },
      { style: "dotted", label: this.t("editor.dotted"), icon: "ellipsis" },
    ];
    if (includeFreeLineStyles || this.diagram.syntax !== "sequenceDiagram") styles.push({ style: "thick", label: this.t("editor.thick"), icon: "grip-horizontal" });
    return styles.filter((item) => includeFreeLineStyles || this.diagram.syntax !== "sequenceDiagram" || item.style === "arrow" || item.style === "dotted");
  }

  private renderColorRibbon(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "owen-mermaid-color-row" });
    this.colorTargetSelect = row.createEl("select", { cls: "owen-mermaid-select owen-mermaid-color-target" });
    for (const target of COLOR_TARGET_KEYS) this.colorTargetSelect.createEl("option", { text: this.t(target.label), value: target.value });
    this.colorTargetSelect.value = this.colorTarget;
    this.colorTargetSelect.addEventListener("change", () => {
      this.colorTarget = this.colorTargetSelect?.value as ColorTarget;
      this.updateColorControls();
    });

    this.colorInput = row.createEl("input", { cls: "owen-mermaid-color-input", attr: { type: "color", title: this.t("editor.applySelectedColor") } });
    this.colorInput.addEventListener("input", () => this.applySelectedColor(this.colorTarget, this.colorInput?.value));

    this.colorResetButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: this.t("editor.clearSelectedColor"), "aria-label": this.t("editor.clearSelectedColor") } });
    setIcon(this.colorResetButton, "rotate-ccw");
    this.colorResetButton.addEventListener("click", () => this.applySelectedColor(this.colorTarget, undefined));

    this.colorClearButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: this.t("editor.clearSelectedStyling"), "aria-label": this.t("editor.clearSelectedStyling") } });
    setIcon(this.colorClearButton, "eraser");
    this.colorClearButton.addEventListener("click", () => this.clearSelectedStyling());

    this.colorApplySimilarButton = row.createEl("button", { cls: "owen-mermaid-palette-item owen-mermaid-color-reset", attr: { type: "button", title: this.t("editor.applySameType"), "aria-label": this.t("editor.applySameType") } });
    setIcon(this.colorApplySimilarButton, "copy-check");
    this.colorApplySimilarButton.addEventListener("click", () => this.applyStyleToSimilarItems());

    this.colorTargetButtons.clear();
    const targetIcons = parent.createDiv({ cls: "owen-mermaid-color-target-icons" });
    for (const target of COLOR_TARGET_KEYS) {
      const label = this.t(target.label);
      const button = targetIcons.createEl("button", { cls: "owen-mermaid-color-target-button", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": "false" } });
      setIcon(button, target.icon);
      button.addEventListener("click", () => {
        this.colorTarget = target.value;
        this.updateColorControls();
      });
      this.colorTargetButtons.set(target.value, button);
    }

    const swatches = parent.createDiv({ cls: "owen-mermaid-color-swatches" });
    for (const color of COLOR_SWATCHES) {
      const swatch = swatches.createEl("button", { cls: "owen-mermaid-color-swatch", attr: { type: "button", title: color, "aria-label": this.t("editor.applyColor", { color }) } });
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
    for (const target of COLOR_TARGET_KEYS) {
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
      const label = this.t(target.label);
      button.setAttribute("title", targetColor ? this.t("editor.colorValue", { target: label, color: targetColor }) : this.t("editor.colorDefault", { target: label }));
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

  private applyStylePreset(preset: { fill?: string; stroke: string; text: string }): void {
    const selection = this.editorSelection;
    if (!selection) return;
    this.recordHistory();

    if (selection.kind === "node") {
      const nodes = this.selectedNodeIds.size > 1 ? this.selectedNodes() : this.diagram.nodes.filter((node) => node.id === selection.id);
      for (const node of nodes) {
        node.fillColor = preset.fill;
        node.strokeColor = preset.stroke;
        node.textColor = preset.text;
      }
      this.render();
      return;
    }

    const item = selection.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === selection.id) : this.diagram.freeLines.find((line) => line.id === selection.id);
    if (!item) return;
    item.strokeColor = preset.stroke;
    item.textColor = preset.text;
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

  private beginStagePan(event: PointerEvent): void {
    const stage = this.stage;
    if (!stage || event.button !== 0 || (event.target !== stage && event.target !== this.canvas)) return;
    if (this.selectedShape || this.selectedConnector || this.connectingFromNodeId || this.placement || this.freeLineDraft) return;

    this.endStagePan();
    this.stagePanState = {
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startScrollLeft: stage.scrollLeft,
      startScrollTop: stage.scrollTop,
      moved: false,
    };
    stage.addClass("is-panning");

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateStagePan(moveEvent);
    const up = () => this.endStagePan();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeStagePanListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private updateStagePan(event: PointerEvent): void {
    const stage = this.stage;
    const state = this.stagePanState;
    if (!stage || !state) return;
    const deltaX = event.clientX - state.startPointerX;
    const deltaY = event.clientY - state.startPointerY;
    if (!state.moved && Math.hypot(deltaX, deltaY) >= 3) {
      state.moved = true;
      this.suppressNextCanvasClick = true;
    }
    if (!state.moved) return;
    event.preventDefault();
    stage.scrollLeft = state.startScrollLeft - deltaX;
    stage.scrollTop = state.startScrollTop - deltaY;
  }

  private endStagePan(): void {
    const moved = this.stagePanState?.moved ?? false;
    this.removeStagePanListeners?.();
    this.removeStagePanListeners = undefined;
    this.stagePanState = undefined;
    this.stage?.removeClass("is-panning");
    if (moved) {
      const win = this.containerEl.ownerDocument.defaultView ?? window;
      win.requestAnimationFrame(() => {
        this.suppressNextCanvasClick = false;
      });
    }
  }

  private render(): void {
    this.renderRibbon();
    this.renderCanvas();
    this.renderInspector();
    this.renderStatusBar();
    this.updateApplyButtonState();
    this.updateCodePreview();
    this.updateColorControls();
  }

  private renderCanvas(): void {
    if (!this.canvas) return;
    this.applyCanvasViewport();
    this.canvas.empty();
    if (this.diagram.syntax === "sequenceDiagram") {
      this.renderSequenceCanvas();
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
    this.renderSmartGuides();

    const nodes = this.canvas.createSvg("g", { cls: "owen-mermaid-nodes" });
    for (const node of this.diagram.nodes) this.renderNode(nodes, node);
    this.renderShapePreview(nodes);
    this.renderSubgraphHints();
    this.renderStatusBar();
  }

  private scheduleCanvasRefresh(updateCodePreview = false): void {
    if (updateCodePreview) this.pendingCodePreviewUpdate = true;
    if (this.pendingCanvasFrame) return;

    const win = this.containerEl.ownerDocument.defaultView ?? window;
    this.pendingCanvasFrame = win.requestAnimationFrame(() => {
      this.pendingCanvasFrame = 0;
      this.renderCanvas();
      if (this.pendingCodePreviewUpdate) {
        this.pendingCodePreviewUpdate = false;
        this.updateCodePreview();
      }
    });
  }

  private cancelScheduledCanvasRefresh(): void {
    if (!this.pendingCanvasFrame) return;
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.cancelAnimationFrame(this.pendingCanvasFrame);
    this.pendingCanvasFrame = 0;
    this.pendingCodePreviewUpdate = false;
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
    group.setAttribute("aria-label", this.t("editor.participantAria", { id: node.id, label: node.label }));
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
      attr: { tabindex: "0", role: "button", "aria-label": this.t("editor.nodeAria", { id: node.id, label: node.label }) },
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
    const path = edge.renderedPath ?? this.createConnectorPath(endpoints.from, endpoints.to, edge.route, edge.waypoints);
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
      const label = this.getLabelPoint(endpoints.from, endpoints.to, edge.waypoints, edge.labelOffsetX, edge.labelOffsetY);
      const text = group.createSvg("text", { cls: "owen-mermaid-edge-label", attr: { x: String(label.x), y: String(label.y), "text-anchor": "middle", ...this.textStyleAttrs(edge.textColor, edge.textSize) } });
      text.setText(edge.label);
      text.addEventListener("pointerdown", (event) => this.beginLabelDrag("edge", edge.id, event));
    }
    if (selected) {
      this.renderEdgeEndpointHandles(group, edge, endpoints);
      this.renderWaypointHandles(group, "edge", edge.id, endpoints.from, endpoints.to, edge.waypoints);
    }
  }

  private renderFreeLines(parent: SVGGElement): void {
    for (const line of this.diagram.freeLines) this.renderFreeLine(parent, line);
  }

  private renderFreeLine(parent: SVGGElement, line: DiagramFreeLine): void {
    const selected = this.editorSelection?.kind === "freeLine" && this.editorSelection.id === line.id;
    const start = { x: line.x1, y: line.y1 };
    const end = { x: line.x2, y: line.y2 };
    const path = this.createConnectorPath(start, end, line.route, line.waypoints);
    const group = parent.createSvg("g", { cls: "owen-mermaid-free-line" });
    group.addClass(`is-${line.style}`);
    if (selected) group.addClass("is-selected");
    group.createSvg("path", { cls: "owen-mermaid-edge-hit", attr: { d: path, fill: "none" } });
    const markerId = line.strokeColor ? this.createArrowMarker(line.strokeColor) : "owen-mermaid-arrow";
    group.createSvg("path", { cls: "owen-mermaid-edge-line", attr: { d: path, fill: "none", ...this.strokeStyleAttrs(line.strokeColor, line.strokeWidth), ...(line.style === "line" ? {} : { "marker-end": `url(#${markerId})` }) } });
    if (line.label) {
      const label = this.getLabelPoint(start, end, line.waypoints, line.labelOffsetX, line.labelOffsetY);
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
    if (selected) this.renderWaypointHandles(group, "freeLine", line.id, start, end, line.waypoints);
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

  private renderWaypointHandles(group: SVGGElement, kind: "edge" | "freeLine", id: string, from: CanvasPoint, to: CanvasPoint, waypoints: CanvasPoint[] = []): void {
    const handles = group.createSvg("g", { cls: "owen-mermaid-waypoint-handles" });
    waypoints.forEach((point, index) => {
      const handle = handles.createSvg("circle", { cls: "owen-mermaid-waypoint-handle", attr: { cx: String(point.x), cy: String(point.y), r: "6" } });
      handle.addEventListener("pointerdown", (event) => this.beginWaypointDrag(kind, id, index, event));
      handle.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeWaypoint(kind, id, index);
      });
    });
    const addPoint = getConnectorLabelPoint(from, to, waypoints, 0, 8);
    const add = handles.createSvg("circle", { cls: "owen-mermaid-waypoint-add", attr: { cx: String(addPoint.x), cy: String(addPoint.y), r: "5" } });
    add.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.addWaypoint(kind, id, { x: addPoint.x, y: addPoint.y });
    });
  }

  private renderInspector(): void {
    if (!this.inspector) return;
    this.inspector.parentElement?.setAttribute("data-inspector-tab", this.inspectorTab);
    this.inspector.empty();
    this.inspector.createEl("div", { cls: "owen-mermaid-section-title", text: this.t("editor.inspector") });
    this.renderInspectorTabs(this.inspector);
    const panel = this.inspector.createDiv({
      cls: "owen-mermaid-inspector-panel",
      attr: {
        id: "owen-mermaid-inspector-panel",
        role: "tabpanel",
        "aria-labelledby": `owen-mermaid-inspector-tab-${this.inspectorTab}`,
        tabindex: "0",
      },
    });
    this.renderRenderSummary(panel);

    if (this.inspectorTab === "source") {
      this.renderUnsupportedSummary(panel);
      this.renderCodePreview(panel);
      return;
    }

    if (this.inspectorTab === "changes") {
      this.renderChangeSummary(panel);
      this.renderSourceDiff(panel);
      return;
    }

    if (!this.editorSelection) {
      this.renderConnectControls(panel);
      panel.createEl("p", { cls: "owen-mermaid-empty-state", text: this.t("editor.selectItem") });
      return;
    }

    if (this.editorSelection.kind === "node") {
      const node = this.diagram.nodes.find((item) => item.id === this.editorSelection?.id);
      if (this.selectedNodeIds.size > 1) this.renderMultiNodeInspector(panel);
      else if (node) this.renderNodeInspector(panel, node);
    } else if (this.editorSelection.kind === "freeLine") {
      const line = this.diagram.freeLines.find((item) => item.id === this.editorSelection?.id);
      if (line) this.renderFreeLineInspector(panel, line);
    } else {
      const edge = this.diagram.edges.find((item) => item.id === this.editorSelection?.id);
      if (edge) this.renderEdgeInspector(panel, edge);
    }

  }

  private renderInspectorTabs(parent: HTMLElement): void {
    const tabs = parent.createDiv({ cls: "owen-mermaid-inspector-tabs", attr: { role: "tablist" } });
    const definitions = [
      { value: "inspect", label: this.t("editor.inspect") },
      { value: "source", label: this.t("editor.source") },
      { value: "changes", label: this.t("editor.changes") },
    ] as Array<{ value: InspectorTab; label: string }>;
    const activateTab = (tab: InspectorTab, focus: boolean): void => {
      this.inspectorTab = tab;
      this.renderInspector();
      if (!focus) return;
      const win = this.containerEl.ownerDocument.defaultView ?? window;
      win.requestAnimationFrame(() => this.inspector?.querySelector<HTMLButtonElement>(`[data-inspector-tab-value="${tab}"]`)?.focus());
    };

    definitions.forEach((tab, index) => {
      const selected = this.inspectorTab === tab.value;
      const button = tabs.createEl("button", {
        cls: "owen-mermaid-inspector-tab",
        text: tab.label,
        attr: {
          id: `owen-mermaid-inspector-tab-${tab.value}`,
          type: "button",
          role: "tab",
          "aria-controls": "owen-mermaid-inspector-panel",
          "aria-selected": selected ? "true" : "false",
          "data-inspector-tab-value": tab.value,
          tabindex: selected ? "0" : "-1",
        },
      });
      button.toggleClass("is-active", this.inspectorTab === tab.value);
      button.addEventListener("click", () => activateTab(tab.value, true));
      button.addEventListener("keydown", (event) => {
        let nextIndex = index;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % definitions.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + definitions.length) % definitions.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = definitions.length - 1;
        else return;
        event.preventDefault();
        activateTab(definitions[nextIndex].value, true);
      });
    });
  }

  private renderRenderSummary(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "owen-mermaid-render-summary" });
    box.createSpan({ cls: "owen-mermaid-syntax-badge", text: this.diagram.syntax });
    const text = this.renderSupportText();
    box.createSpan({ text });
  }

  private renderSupportText(): string {
    if (this.diagram.syntax === "flowchart") return this.t("editor.support.flowchart");
    if (this.diagram.syntax === "stateDiagram") return this.t("editor.support.state");
    return this.t("editor.support.sequence");
  }

  private renderChangeSummary(parent: HTMLElement): void {
    const items = this.createChangeSummary();
    if (items.length === 0) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: this.t("editor.summary") });
    const list = parent.createEl("ul", { cls: "owen-mermaid-change-summary" });
    for (const item of items) list.createEl("li", { text: item });
  }

  private renderUnsupportedSummary(parent: HTMLElement): void {
    if (this.diagram.unsupportedLines.length === 0) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: this.t("editor.preserved") });
    const subgraphs = this.getSubgraphTitles();
    if (subgraphs.length > 0) {
      const list = parent.createEl("ul", { cls: "owen-mermaid-preserved-groups" });
      for (const title of subgraphs) list.createEl("li", { text: this.t("editor.lockedSubgraph", { title }) });
    }
    const box = parent.createEl("textarea", { cls: "owen-mermaid-preserved-preview" });
    box.readOnly = true;
    box.value = this.diagram.unsupportedLines.join("\n");
  }

  private renderSubgraphHints(): void {
    if (!this.canvas) return;
    const titles = this.getSubgraphTitles();
    if (titles.length === 0) return;
    const bounds = this.getCanvasBounds();
    const group = this.canvas.createSvg("g", { cls: "owen-mermaid-subgraph-hints" });
    titles.forEach((title, index) => {
      const y = bounds.minY + 48 + index * 38;
      const item = group.createSvg("g", { cls: "owen-mermaid-subgraph-hint" });
      item.createSvg("rect", { attr: { x: String(bounds.minX + 24), y: String(y - 20), width: "220", height: "28", rx: "7" } });
      item.createSvg("text", { attr: { x: String(bounds.minX + 38), y: String(y), "text-anchor": "start" } }).setText(this.t("editor.locked", { title }));
    });
  }

  private getSubgraphTitles(): string[] {
    return this.diagram.unsupportedLines
      .map((line) => line.match(/^\s*subgraph\s+(.+)\s*$/i)?.[1]?.trim())
      .filter((title): title is string => Boolean(title));
  }

  private renderSmartGuides(): void {
    if (!this.canvas || this.smartGuides.length === 0) return;
    const bounds = this.getCanvasBounds();
    const group = this.canvas.createSvg("g", { cls: "owen-mermaid-smart-guides" });
    for (const guide of this.smartGuides) {
      if (guide.orientation === "vertical") {
        group.createSvg("line", { cls: "owen-mermaid-smart-guide", attr: { x1: String(guide.position), x2: String(guide.position), y1: String(bounds.minY), y2: String(bounds.maxY) } });
      } else {
        group.createSvg("line", { cls: "owen-mermaid-smart-guide", attr: { x1: String(bounds.minX), x2: String(bounds.maxX), y1: String(guide.position), y2: String(guide.position) } });
      }
    }
  }

  private renderSourceDiff(parent: HTMLElement): void {
    const diff = this.createSourceDiffLines();
    if (diff.length === 0) return;
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: this.t("editor.changes") });
    this.diffPreview = parent.createEl("pre", { cls: "owen-mermaid-diff-preview" });
    for (const line of diff) {
      this.diffPreview.createEl("span", { cls: `owen-mermaid-diff-line is-${line.kind}`, text: line.text });
    }
  }

  private renderNodeInspector(parent: HTMLElement, node: DiagramNode): void {
    this.createTextField(parent, this.t("editor.id"), node.id, (value) => this.renameNode(node, value));
    this.createTextField(parent, this.t("editor.text"), node.label, (value) => {
      node.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const shape = parent.createEl("select", { cls: "owen-mermaid-select owen-mermaid-shape-select" });
    for (const item of this.shapeTools()) shape.createEl("option", { text: item.label, value: item.shape });
    shape.value = node.shape;
    shape.addEventListener("change", () => {
      this.recordHistory();
      node.shape = shape.value as NodeShape;
      this.render();
    });

    this.createNumberField(parent, this.t("editor.borderWidth"), node.strokeWidth, DEFAULT_NODE_STROKE_WIDTH, 0.5, 10, 0.5, (value) => {
      node.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, this.t("editor.textSize"), node.textSize, DEFAULT_NODE_TEXT_SIZE, 8, 32, 1, (value) => {
      node.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createDangerButton(parent, this.t("editor.deleteNode"), () => this.deleteNode(node.id));
  }

  private renderMultiNodeInspector(parent: HTMLElement): void {
    parent.createEl("p", { cls: "owen-mermaid-empty-state", text: this.t("editor.nodesSelected", { count: this.selectedNodeIds.size }) });
    const grid = parent.createDiv({ cls: "owen-mermaid-inspector-grid" });
    this.createActionButton(grid, this.t("editor.alignLeft"), () => this.alignSelectedNodes("left"));
    this.createActionButton(grid, this.t("editor.alignCenter"), () => this.alignSelectedNodes("centerX"));
    this.createActionButton(grid, this.t("editor.alignRight"), () => this.alignSelectedNodes("right"));
    this.createActionButton(grid, this.t("editor.alignTop"), () => this.alignSelectedNodes("top"));
    this.createActionButton(grid, this.t("editor.alignMiddle"), () => this.alignSelectedNodes("middleY"));
    this.createActionButton(grid, this.t("editor.alignBottom"), () => this.alignSelectedNodes("bottom"));
    this.createActionButton(grid, this.t("editor.distributeX"), () => this.distributeSelectedNodes("horizontal"));
    this.createActionButton(grid, this.t("editor.distributeY"), () => this.distributeSelectedNodes("vertical"));
    this.createDangerButton(parent, this.t("editor.deleteSelectedNodes"), () => this.deleteSelectedNodes());
  }

  private renderEdgeInspector(parent: HTMLElement, edge: DiagramEdge): void {
    this.createTextField(parent, this.t("editor.label"), edge.label, (value) => {
      edge.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const style = parent.createEl("select", { cls: "owen-mermaid-select" });
    const styles = this.diagram.syntax === "sequenceDiagram" ? (["arrow", "dotted"] as const) : (["line", "arrow", "dotted", "thick"] as const);
    for (const value of styles) style.createEl("option", { text: this.connectorTools(true).find((item) => item.style === value)?.label ?? value, value });
    style.value = edge.style;
    style.addEventListener("change", () => {
      this.recordHistory();
      edge.style = style.value as DiagramEdge["style"];
      this.render();
    });

    const route = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["curve", "straight", "elbow"] as EdgeRoute[]) route.createEl("option", { text: this.routeLabel(value), value });
    route.value = edge.route ?? "curve";
    route.addEventListener("change", () => {
      this.recordHistory();
      edge.route = route.value as EdgeRoute;
      edge.renderedPath = undefined;
      this.render();
    });

    this.createNumberField(parent, this.t("editor.lineWidth"), edge.strokeWidth, edge.style === "thick" ? 4 : DEFAULT_EDGE_STROKE_WIDTH, 0.5, 12, 0.5, (value) => {
      edge.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, this.t("editor.labelSize"), edge.textSize, DEFAULT_EDGE_TEXT_SIZE, 8, 32, 1, (value) => {
      edge.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createActionButton(parent, this.t("editor.resetLabelPosition"), () => {
      this.recordHistory();
      edge.labelOffsetX = 0;
      edge.labelOffsetY = 0;
      this.render();
    });

    this.createDangerButton(parent, this.t("editor.deleteConnector"), () => this.deleteEdge(edge.id));
  }

  private renderFreeLineInspector(parent: HTMLElement, line: DiagramFreeLine): void {
    this.createTextField(parent, this.t("editor.label"), line.label, (value) => {
      line.label = value;
      this.renderCanvas();
      this.updateCodePreview();
    }, true);

    const style = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["line", "arrow", "dotted", "thick"] as const) style.createEl("option", { text: this.connectorTools(true).find((item) => item.style === value)?.label ?? value, value });
    style.value = line.style;
    style.addEventListener("change", () => {
      this.recordHistory();
      line.style = style.value as EdgeStyle;
      this.render();
    });

    const route = parent.createEl("select", { cls: "owen-mermaid-select" });
    for (const value of ["curve", "straight", "elbow"] as EdgeRoute[]) route.createEl("option", { text: this.routeLabel(value), value });
    route.value = line.route ?? "curve";
    route.addEventListener("change", () => {
      this.recordHistory();
      line.route = route.value as EdgeRoute;
      this.render();
    });

    this.createNumberField(parent, this.t("editor.lineWidth"), line.strokeWidth, line.style === "thick" ? 4 : DEFAULT_EDGE_STROKE_WIDTH, 0.5, 12, 0.5, (value) => {
      line.strokeWidth = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });
    this.createNumberField(parent, this.t("editor.labelSize"), line.textSize, DEFAULT_EDGE_TEXT_SIZE, 8, 32, 1, (value) => {
      line.textSize = value;
      this.renderCanvas();
      this.updateCodePreview();
      this.updateColorControls();
    });

    this.createActionButton(parent, this.t("editor.resetLabelPosition"), () => {
      this.recordHistory();
      line.labelOffsetX = 0;
      line.labelOffsetY = 0;
      this.render();
    });

    this.createDangerButton(parent, this.t("editor.deleteLine"), () => this.deleteFreeLine(line.id));
  }

  private renderConnectControls(parent: HTMLElement): void {
    parent.createEl("div", { cls: "owen-mermaid-section-title", text: this.t("editor.connector") });
    const row = parent.createDiv({ cls: "owen-mermaid-connect-row" });
    const from = row.createEl("select", { cls: "owen-mermaid-select" });
    const to = row.createEl("select", { cls: "owen-mermaid-select" });
    for (const node of this.diagram.nodes) {
      from.createEl("option", { value: node.id, text: node.id });
      to.createEl("option", { value: node.id, text: node.id });
    }
    if (this.diagram.nodes[1]) to.value = this.diagram.nodes[1].id;

    const button = parent.createEl("button", { cls: "owen-mermaid-action-button", text: this.t("editor.connect"), attr: { type: "button" } });
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
    const editButton = actions.createEl("button", { cls: "owen-mermaid-action-button", text: this.sourceEditing ? this.t("editor.cancelSourceEdit") : this.t("editor.editSource"), attr: { type: "button" } });
    const applyButton = actions.createEl("button", { cls: "owen-mermaid-action-button", text: this.t("editor.applySource"), attr: { type: "button" } });
    applyButton.disabled = !this.sourceEditing;

    this.renderSourceDiagnostics(parent);

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

  private renderSourceDiagnostics(parent: HTMLElement): void {
    const source = this.sourceEditing ? this.sourceDraft ?? this.currentSource() : this.currentSource();
    const diagnostics = createMermaidSourceDiagnostics(source, this.diagram, this.locale);
    if (diagnostics.length === 0) return;
    const box = parent.createDiv({ cls: "owen-mermaid-source-diagnostics" });
    for (const diagnostic of diagnostics) box.createDiv({ cls: `owen-mermaid-source-diagnostic is-${diagnostic.severity}`, text: diagnostic.message });
  }

  private createTextField(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void, live = false): void {
    const wrapper = parent.createDiv({ cls: "owen-mermaid-field" });
    wrapper.createEl("label", { text: label });
    const input = wrapper.createEl("input", { value, attr: { type: "text" } });
    let recorded = false;
    let currentValue = value;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      this.recordHistory();
    };
    const applyValue = () => {
      const nextValue = input.value.trim();
      if (nextValue === currentValue) return;
      recordOnce();
      currentValue = nextValue;
      onChange(nextValue);
    };
    if (live) input.addEventListener("input", () => {
      applyValue();
    });
    input.addEventListener("change", () => {
      applyValue();
    });
  }

  private createNumberField(parent: HTMLElement, label: string, value: number | undefined, placeholder: number, min: number, max: number, step: number, onChange: (value: number | undefined) => void): void {
    const wrapper = parent.createDiv({ cls: "owen-mermaid-field" });
    wrapper.createEl("label", { text: label });
    const input = wrapper.createEl("input", { attr: { type: "number", min: String(min), max: String(max), step: String(step), placeholder: String(placeholder) } });
    input.value = value === undefined ? "" : String(value);
    let recorded = false;
    let currentValue = value;
    const recordOnce = () => {
      if (recorded) return;
      recorded = true;
      this.recordHistory();
    };
    input.addEventListener("input", () => {
      const nextValue = input.value.trim() === "" ? undefined : this.clamp(Number(input.value), min, max);
      const normalized = Number.isFinite(nextValue) ? nextValue : undefined;
      if (normalized === currentValue) return;
      recordOnce();
      currentValue = normalized;
      onChange(normalized);
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

  private routeLabel(route: EdgeRoute): string {
    if (route === "straight") return this.t("editor.straight");
    if (route === "elbow") return this.t("editor.elbow");
    return this.t("editor.curve");
  }

  private openActionPalette(): void {
    new MermaidActionPaletteModal(this.app, this.getEditorActions(), this.t).open();
  }

  private getEditorActions(): EditorAction[] {
    return [
      { label: this.t("editor.addRectangle"), keywords: "shape node rectangle", run: () => this.placeShapeAtCenter("rectangle") },
      { label: this.t("editor.addDecision"), keywords: "shape node diamond decision", run: () => this.placeShapeAtCenter("diamond") },
      { label: this.t("editor.fitView"), keywords: "zoom fit view", run: () => this.fitDiagramToStage() },
      { label: this.t("editor.resetZoom"), keywords: "zoom reset 100", run: () => this.setEditorZoom(1) },
      { label: this.t("editor.autoLayout"), keywords: "layout arrange", run: () => this.autoLayout() },
      { label: this.t("editor.copySelection"), keywords: "copy duplicate", run: () => this.copySelection() },
      { label: this.t("editor.pasteSelection"), keywords: "paste duplicate", run: () => this.pasteSelection() },
      { label: this.t("editor.selectAllNodes"), keywords: "select all", run: () => this.selectAllNodes() },
      { label: this.t("editor.editSource"), keywords: "source mermaid code", run: () => { this.setInspectorVisible(true); this.inspectorTab = "source"; this.sourceEditing = true; this.sourceDraft = this.currentSource(); this.renderInspector(); } },
      { label: this.t("editor.showChanges"), keywords: "diff changes summary", run: () => { this.setInspectorVisible(true); this.inspectorTab = "changes"; this.renderInspector(); } },
    ];
  }

  private setInspectorVisible(visible: boolean): void {
    this.inspectorVisible = visible;
    this.modalEl.toggleClass("is-inspector-collapsed", !visible);
    if (!this.inspectorToggleButton) return;
    const label = this.t(visible ? "editor.hideInspector" : "editor.showInspector");
    setIcon(this.inspectorToggleButton, visible ? "panel-right-close" : "panel-right-open");
    this.inspectorToggleButton.setAttribute("aria-label", label);
    this.inspectorToggleButton.setAttribute("title", label);
    this.inspectorToggleButton.setAttribute("aria-expanded", visible ? "true" : "false");
  }

  private createButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "owen-mermaid-icon-button", attr: { "aria-label": label, title: label, type: "button" } });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
    });
    return button;
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
    this.openTextEditor(this.t("editor.editNodeText"), this.t("editor.text"), node.label, false, (value) => {
      this.recordHistory();
      node.label = value;
      this.editorSelection = { kind: "node", id: node.id };
      this.render();
    });
  }

  private promptEdgeLabel(edge: DiagramEdge): void {
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();
    this.openTextEditor(this.t("editor.editConnectorLabel"), this.t("editor.label"), edge.label, true, (value) => {
      this.recordHistory();
      edge.label = value;
      this.editorSelection = { kind: "edge", id: edge.id };
      this.render();
    });
  }

  private promptFreeLineLabel(line: DiagramFreeLine): void {
    this.editorSelection = { kind: "freeLine", id: line.id };
    this.render();
    this.openTextEditor(this.t("editor.editLineLabel"), this.t("editor.label"), line.label, true, (value) => {
      this.recordHistory();
      line.label = value;
      this.editorSelection = { kind: "freeLine", id: line.id };
      this.render();
    });
  }

  private openTextEditor(title: string, label: string, value: string, allowEmpty: boolean, onSubmit: (value: string) => void): void {
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.setTimeout(() => {
      new MermaidTextEditModal(this.app, title, label, value, allowEmpty, onSubmit, this.t).open();
    }, 0);
  }

  private showNodeMenu(event: MouseEvent, node: DiagramNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.editorSelection = { kind: "node", id: node.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.t("editor.editText")).setIcon("type").onClick(() => this.promptNodeLabel(node)));
    menu.addItem((item) => item.setTitle(this.t("editor.startConnector")).setIcon("move-up-right").onClick(() => this.startConnectionFrom(node.id)));
    menu.addItem((item) => item.setTitle(this.t("editor.selfConnector")).setIcon("refresh-cw").onClick(() => this.createSelfConnector(node.id)));
    menu.addItem((item) => item.setTitle(this.t("editor.duplicateShape")).setIcon("copy").onClick(() => this.duplicateNode(node)));
    if (this.connectingFromNodeId) {
      menu.addItem((item) => item.setTitle(this.t("editor.cancelConnector")).setIcon("x").onClick(() => {
        this.clearConnectionMode();
        this.render();
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("editor.deleteShape")).setIcon("trash").onClick(() => this.deleteNode(node.id)));
    menu.showAtMouseEvent(event);
  }

  private showEdgeMenu(event: MouseEvent, edge: DiagramEdge): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.editorSelection = { kind: "edge", id: edge.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.t("editor.editLabel")).setIcon("type").onClick(() => this.promptEdgeLabel(edge)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("editor.reverseDirection")).setIcon("arrow-left-right").onClick(() => this.reverseEdge(edge)));
    menu.addSeparator();
    if (this.diagram.syntax !== "sequenceDiagram") {
      menu.addItem((item) => item.setTitle(this.t("editor.lineConnector")).setIcon("minus").onClick(() => this.setEdgeStyle(edge, "line")));
    }
    menu.addItem((item) => item.setTitle(this.t("editor.arrowConnector")).setIcon("arrow-right").onClick(() => this.setEdgeStyle(edge, "arrow")));
    menu.addItem((item) => item.setTitle(this.t("editor.dottedConnector")).setIcon("ellipsis").onClick(() => this.setEdgeStyle(edge, "dotted")));
    if (this.diagram.syntax !== "sequenceDiagram") {
      menu.addItem((item) => item.setTitle(this.t("editor.thickConnector")).setIcon("grip-horizontal").onClick(() => this.setEdgeStyle(edge, "thick")));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("editor.deleteConnector")).setIcon("trash").onClick(() => this.deleteEdge(edge.id)));
    menu.showAtMouseEvent(event);
  }

  private showFreeLineMenu(event: MouseEvent, line: DiagramFreeLine): void {
    event.preventDefault();
    event.stopPropagation();
    this.setSelectedShapeTool(undefined);
    this.editorSelection = { kind: "freeLine", id: line.id };
    this.render();

    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.t("editor.editLabel")).setIcon("type").onClick(() => this.promptFreeLineLabel(line)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("editor.line")).setIcon("minus").onClick(() => this.setFreeLineStyle(line, "line")));
    menu.addItem((item) => item.setTitle(this.t("editor.arrowLine")).setIcon("arrow-right").onClick(() => this.setFreeLineStyle(line, "arrow")));
    menu.addItem((item) => item.setTitle(this.t("editor.dottedLine")).setIcon("ellipsis").onClick(() => this.setFreeLineStyle(line, "dotted")));
    menu.addItem((item) => item.setTitle(this.t("editor.thickLine")).setIcon("grip-horizontal").onClick(() => this.setFreeLineStyle(line, "thick")));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("editor.deleteLine")).setIcon("trash").onClick(() => this.deleteFreeLine(line.id)));
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
      new Notice(this.t("editor.uniqueNodeId"));
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
  }

  private getNodeBounds(nodes: DiagramNode[]): { minX: number; minY: number; maxX: number; maxY: number; centerX: number; centerY: number; width: number; height: number } {
    const minX = Math.min(...nodes.map((node) => node.x - node.width / 2));
    const minY = Math.min(...nodes.map((node) => node.y - node.height / 2));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width / 2));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height / 2));
    return { minX, minY, maxX, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
  }

  private async save(): Promise<void> {
    if (this.isSaving) return;
    if (this.sourceEditing && !this.applySourceDraft(false, () => void this.save())) return;

    const nextSource = this.currentSource();
    this.isSaving = true;
    this.updateApplyButtonState();
    this.renderStatusBar();

    try {
      await this.onSave(nextSource);
      this.savedSource = nextSource;
      this.suppressClosePrompt = false;
      new Notice(this.t("editor.updated"));
      this.render();
    } catch (error) {
      new Notice(this.t("editor.saveFailed", { error: error instanceof Error ? error.message : String(error) }));
      this.renderStatusBar();
      this.updateApplyButtonState();
    } finally {
      this.isSaving = false;
      this.renderStatusBar();
      this.updateApplyButtonState();
    }
  }

  private updateCodePreview(): void {
    if (this.codePreview && !this.sourceEditing) this.codePreview.value = this.currentSource();
  }

  private applySourceDraft(renderAfter = true, afterApply?: () => void): boolean {
    const source = this.sourceDraft ?? this.codePreview?.value ?? this.currentSource();
    const assessment = assessMermaidSourceDraft(source, this.diagram, this.locale);
    if (assessment.warnings.length > 0) {
      new MermaidSourceApplyModal(this.app, assessment.warnings, () => {
        this.commitSourceDraft(assessment.diagram, renderAfter);
        afterApply?.();
      }, this.t).open();
      return false;
    }

    this.commitSourceDraft(assessment.diagram, renderAfter);
    afterApply?.();
    return true;
  }

  private commitSourceDraft(nextDiagram: FlowDiagram, renderAfter: boolean): void {
    if (this.currentSource() !== generateEditorSource(nextDiagram)) this.recordHistory();
    this.diagram = nextDiagram;
    this.editorSelection = null;
    this.sourceEditing = false;
    this.sourceDraft = undefined;
    if (renderAfter) this.render();
  }

  private currentSource(): string {
    return generateEditorSource(this.diagram);
  }

  private createSourceDiffLines() {
    return createMermaidSourceDiffLines(this.savedSource, this.currentSource());
  }

  private createChangeSummary(): string[] {
    return createMermaidChangeSummary(this.savedSource, this.diagram, this.locale);
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
      this.t,
    ).open();
  }

  private recordHistory(): void {
    this.history.push(this.createHistorySnapshot());
  }

  private undoHistory(): void {
    const previous = this.history.undo(this.createHistorySnapshot());
    if (!previous) return;
    this.restoreHistory(previous);
  }

  private redoHistory(): void {
    const next = this.history.redo(this.createHistorySnapshot());
    if (!next) return;
    this.restoreHistory(next);
  }

  private createHistorySnapshot(): EditorSnapshot {
    return {
      diagram: this.diagram,
      selection: this.editorSelection,
      selectedNodeIds: Array.from(this.selectedNodeIds),
    };
  }

  private restoreHistory(snapshot: EditorSnapshot): void {
    this.diagram = snapshot.diagram;
    this.restoreSelection(snapshot.selection, snapshot.selectedNodeIds);
    this.keyboardMoveHistoryRecorded = false;
    this.sourceEditing = false;
    this.sourceDraft = undefined;
    this.cancelShapePlacement();
    this.endDrag();
    this.endResize();
    this.endConnectionDrag();
    this.endFreeLineDraw();
    this.endLabelDrag();
    this.endWaypointDrag();
    this.selectedShape = undefined;
    this.selectedConnector = undefined;
    this.previewPoint = undefined;
    this.smartGuides = [];
    this.clearConnectionMode();
    this.canvas?.removeClass("is-placing");
    this.updatePaletteState();
    this.render();
  }

  private restoreSelection(selection: Selection, selectedNodeIds: string[]): void {
    const validNodeIds = new Set(this.diagram.nodes.map((node) => node.id));
    this.selectedNodeIds.clear();
    for (const nodeId of selectedNodeIds) {
      if (validNodeIds.has(nodeId)) this.selectedNodeIds.add(nodeId);
    }

    if (selection?.kind === "node" && validNodeIds.has(selection.id)) {
      this.preserveNodeSelection = true;
      this.editorSelection = selection;
      this.preserveNodeSelection = false;
      if (this.selectedNodeIds.size === 0) this.selectedNodeIds.add(selection.id);
      return;
    }

    if (selection?.kind === "edge" && this.diagram.edges.some((edge) => edge.id === selection.id)) {
      this.editorSelection = selection;
      return;
    }

    if (selection?.kind === "freeLine" && this.diagram.freeLines.some((line) => line.id === selection.id)) {
      this.editorSelection = selection;
      return;
    }

    this.editorSelection = null;
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

  private selectAllNodes(): boolean {
    if (this.diagram.nodes.length === 0) return false;
    this.selectedNodeIds.clear();
    for (const node of this.diagram.nodes) this.selectedNodeIds.add(node.id);
    this.preserveNodeSelection = true;
    this.editorSelection = { kind: "node", id: this.diagram.nodes[0]?.id ?? "" };
    this.preserveNodeSelection = false;
    this.render();
    return true;
  }

  private copySelection(): boolean {
    const selection = this.editorSelection;
    if (!selection) return false;
    if (selection.kind === "node") {
      const nodes = this.selectedNodes();
      if (nodes.length === 0) return false;
      const ids = new Set(nodes.map((node) => node.id));
      this.copiedSelection = {
        nodes: nodes.map((node) => ({ ...node })),
        edges: this.diagram.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => ({ ...edge, waypoints: edge.waypoints?.map((point) => ({ ...point })) })),
        freeLines: [],
      };
      return true;
    }
    if (selection.kind === "edge") {
      const edge = this.diagram.edges.find((item) => item.id === selection.id);
      if (!edge) return false;
      this.copiedSelection = { nodes: [], edges: [{ ...edge, waypoints: edge.waypoints?.map((point) => ({ ...point })) }], freeLines: [] };
      return true;
    }
    const line = this.diagram.freeLines.find((item) => item.id === selection.id);
    if (!line) return false;
    this.copiedSelection = { nodes: [], edges: [], freeLines: [{ ...line, waypoints: line.waypoints?.map((point) => ({ ...point })) }] };
    return true;
  }

  private pasteSelection(): boolean {
    const copied = this.copiedSelection;
    if (!copied || (copied.nodes.length === 0 && copied.edges.length === 0 && copied.freeLines.length === 0)) return false;
    this.recordHistory();
    const idMap = new Map<string, string>();
    this.selectedNodeIds.clear();

    for (const source of copied.nodes) {
      const node = createNode(this.diagram, source.shape);
      idMap.set(source.id, node.id);
      Object.assign(node, {
        label: source.label,
        shape: source.shape,
        x: source.x + COPY_OFFSET,
        y: source.y + COPY_OFFSET,
        width: source.width,
        height: source.height,
        fillColor: source.fillColor,
        strokeColor: source.strokeColor,
        textColor: source.textColor,
        strokeWidth: source.strokeWidth,
        textSize: source.textSize,
      });
      this.selectedNodeIds.add(node.id);
    }

    let lastSelection: Selection = null;
    for (const source of copied.edges) {
      const from = idMap.get(source.from) ?? source.from;
      const to = idMap.get(source.to) ?? source.to;
      if (!this.diagram.nodes.some((node) => node.id === from) || !this.diagram.nodes.some((node) => node.id === to)) continue;
      const edge = createEdge(this.diagram, from, to);
      Object.assign(edge, {
        label: source.label,
        style: source.style,
        route: source.route,
        waypoints: source.waypoints?.map((point) => ({ x: point.x + COPY_OFFSET, y: point.y + COPY_OFFSET })),
        labelOffsetX: source.labelOffsetX,
        labelOffsetY: source.labelOffsetY,
        strokeColor: source.strokeColor,
        textColor: source.textColor,
        strokeWidth: source.strokeWidth,
        textSize: source.textSize,
      });
      lastSelection = { kind: "edge", id: edge.id };
    }

    for (const source of copied.freeLines) {
      const line: DiagramFreeLine = {
        ...source,
        id: this.nextFreeLineId(),
        x1: source.x1 + COPY_OFFSET,
        y1: source.y1 + COPY_OFFSET,
        x2: source.x2 + COPY_OFFSET,
        y2: source.y2 + COPY_OFFSET,
        waypoints: source.waypoints?.map((point) => ({ x: point.x + COPY_OFFSET, y: point.y + COPY_OFFSET })),
      };
      this.diagram.freeLines.push(line);
      lastSelection = { kind: "freeLine", id: line.id };
    }

    if (this.selectedNodeIds.size > 0) {
      const firstId = Array.from(this.selectedNodeIds)[0];
      this.preserveNodeSelection = true;
      this.editorSelection = firstId ? { kind: "node", id: firstId } : null;
      this.preserveNodeSelection = false;
    } else {
      this.editorSelection = lastSelection;
    }
    this.render();
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
    this.scheduleCanvasRefresh();
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
    this.scheduleCanvasRefresh();
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

  private createModalResizeHandle(shell: HTMLElement): void {
    const handle = shell.createEl("button", { cls: "owen-mermaid-window-resize-handle", attr: { type: "button", title: this.t("editor.resize"), "aria-label": this.t("editor.resize") } });
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
    this.renderStatusBar();
  }

  private handleStageWheel(event: WheelEvent): void {
    if (!this.stage) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      this.setEditorZoom(this.editorZoom + direction * EDITOR_ZOOM_STEP);
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      this.stage.scrollLeft += event.deltaY;
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

  private renderStatusBar(): void {
    if (!this.statusBar) return;
    const selected = this.selectedNodeIds.size > 1 ? this.t("editor.selectionNodes", { count: this.selectedNodeIds.size }) : this.editorSelection ? `${this.editorSelection.kind}` : this.t("editor.selectionNone");
    const sourceState = this.isSaving ? this.t("editor.saving") : this.hasUnsavedChanges() ? this.t("editor.changed") : this.t("editor.saved");
    const unsupported = this.diagram.unsupportedLines.length > 0 ? `, ${this.t("editor.preservedCount", { count: this.diagram.unsupportedLines.length })}` : "";
    const tool = this.selectedShape ? ` | ${this.t("editor.toolStatus", { tool: this.selectedShape })}` : this.selectedConnector ? ` | ${this.t("editor.toolStatus", { tool: this.selectedConnector.style })}` : this.connectingFromNodeId ? ` | ${this.t("editor.connecting")}` : "";
    this.statusBar.setText(`${this.t("editor.zoomStatus", { zoom: Math.round(this.editorZoom * 100) })} | ${this.t("editor.snapStatus", { snap: this.snapEnabled ? this.snapSize : "off" })} | ${this.t("editor.selectionStatus", { selection: selected })} | ${sourceState}${unsupported}${tool}`);
    this.updateToolStateClasses();
    this.updateApplyButtonState();
  }

  private updateToolStateClasses(): void {
    const connecting = Boolean(this.selectedConnector || this.connectingFromNodeId || this.freeLineDraft);
    this.canvas?.toggleClass("is-connecting", connecting);
    this.stage?.toggleClass("is-connecting", connecting);
  }

  private updateApplyButtonState(): void {
    if (!this.applyButton) return;
    const hasChanges = this.hasUnsavedChanges();
    this.applyButtonLabel?.setText(this.isSaving ? this.t("editor.applying") : this.t("common.apply"));
    this.applyButton.disabled = this.isSaving || !hasChanges;
    this.applyButton.toggleClass("is-busy", this.isSaving);
    this.applyButton.setAttribute("aria-label", this.isSaving ? this.t("editor.applying") : this.t("common.apply"));
    this.applyButton.setAttribute("title", this.isSaving ? this.t("editor.applying") : hasChanges ? this.t("common.apply") : this.t("editor.noChanges"));
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
    const movingNodes = Array.from(this.draggedNodeStarts.keys());
    const snapped = this.smartSnapNodePoint({ x: point.x - this.dragOffset.x, y: point.y - this.dragOffset.y }, node, movingNodes);
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
    this.scheduleCanvasRefresh(true);
  }

  private endDrag(): void {
    this.removeNodeDragListeners?.();
    this.removeNodeDragListeners = undefined;
    this.draggingNodeId = undefined;
    this.draggedNodeStarts.clear();
    if (this.smartGuides.length > 0) {
      this.smartGuides = [];
      this.renderCanvas();
      this.updateCodePreview();
    }
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
    this.scheduleCanvasRefresh(true);
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
    this.scheduleCanvasRefresh();
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
    this.scheduleCanvasRefresh();
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

  private smartSnapNodePoint(point: CanvasPoint, node: DiagramNode, movingNodeIds: string[]): CanvasPoint {
    const gridPoint = this.snapPoint(point);
    const moving = new Set(movingNodeIds);
    const candidatesX = [
      { value: gridPoint.x, offset: 0 },
      { value: gridPoint.x - node.width / 2, offset: node.width / 2 },
      { value: gridPoint.x + node.width / 2, offset: -node.width / 2 },
    ];
    const candidatesY = [
      { value: gridPoint.y, offset: 0 },
      { value: gridPoint.y - node.height / 2, offset: node.height / 2 },
      { value: gridPoint.y + node.height / 2, offset: -node.height / 2 },
    ];
    let nextX = gridPoint.x;
    let nextY = gridPoint.y;
    let bestX = SMART_GUIDE_THRESHOLD + 1;
    let bestY = SMART_GUIDE_THRESHOLD + 1;
    const guides: SmartGuide[] = [];

    for (const other of this.diagram.nodes) {
      if (moving.has(other.id)) continue;
      for (const target of [other.x, other.x - other.width / 2, other.x + other.width / 2]) {
        for (const candidate of candidatesX) {
          const distance = Math.abs(candidate.value - target);
          if (distance < bestX && distance <= SMART_GUIDE_THRESHOLD) {
            bestX = distance;
            nextX = target + candidate.offset;
            guides[0] = { orientation: "vertical", position: target };
          }
        }
      }
      for (const target of [other.y, other.y - other.height / 2, other.y + other.height / 2]) {
        for (const candidate of candidatesY) {
          const distance = Math.abs(candidate.value - target);
          if (distance < bestY && distance <= SMART_GUIDE_THRESHOLD) {
            bestY = distance;
            nextY = target + candidate.offset;
            guides[1] = { orientation: "horizontal", position: target };
          }
        }
      }
    }

    this.smartGuides = guides.filter(Boolean);
    return { x: nextX, y: nextY };
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

  private createConnectorPath(from: CanvasPoint, to: CanvasPoint, route: EdgeRoute = "curve", waypoints: CanvasPoint[] = []): string {
    return createEditorConnectorPath(from, to, route, waypoints);
  }

  private getLabelPoint(from: CanvasPoint, to: CanvasPoint, waypoints: CanvasPoint[] = [], offsetX = 0, offsetY = 0): CanvasPoint {
    return getConnectorLabelPoint(from, to, waypoints, offsetX, offsetY);
  }

  private addWaypoint(kind: "edge" | "freeLine", id: string, point: CanvasPoint): void {
    const item = kind === "edge" ? this.diagram.edges.find((edge) => edge.id === id) : this.diagram.freeLines.find((line) => line.id === id);
    if (!item) return;
    this.recordHistory();
    item.waypoints = [...(item.waypoints ?? []), this.snapPoint(point)];
    if (kind === "edge") (item as DiagramEdge).renderedPath = undefined;
    this.editorSelection = kind === "edge" ? { kind: "edge", id } : { kind: "freeLine", id };
    this.render();
  }

  private removeWaypoint(kind: "edge" | "freeLine", id: string, index: number): void {
    const item = kind === "edge" ? this.diagram.edges.find((edge) => edge.id === id) : this.diagram.freeLines.find((line) => line.id === id);
    if (!item?.waypoints?.[index]) return;
    this.recordHistory();
    item.waypoints.splice(index, 1);
    if (item.waypoints.length === 0) item.waypoints = undefined;
    if (kind === "edge") (item as DiagramEdge).renderedPath = undefined;
    this.render();
  }

  private beginWaypointDrag(kind: "edge" | "freeLine", id: string, index: number, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.endWaypointDrag();
    this.recordHistory();
    this.waypointDragState = { kind, id, index };
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    const move = (moveEvent: PointerEvent) => this.updateWaypointDrag(moveEvent);
    const up = () => this.endWaypointDrag();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up, { once: true });
    win.addEventListener("pointercancel", up, { once: true });
    this.removeWaypointDragListeners = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
    };
  }

  private updateWaypointDrag(event: PointerEvent): void {
    const state = this.waypointDragState;
    if (!state) return;
    const item = state.kind === "edge" ? this.diagram.edges.find((edge) => edge.id === state.id) : this.diagram.freeLines.find((line) => line.id === state.id);
    const waypoint = item?.waypoints?.[state.index];
    if (!item || !waypoint) return;
    event.preventDefault();
    const point = this.snapPoint(this.toCanvasPoint(event));
    waypoint.x = point.x;
    waypoint.y = point.y;
    if (state.kind === "edge") (item as DiagramEdge).renderedPath = undefined;
    this.scheduleCanvasRefresh(true);
  }

  private endWaypointDrag(): void {
    this.removeWaypointDragListeners?.();
    this.removeWaypointDragListeners = undefined;
    this.waypointDragState = undefined;
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
    this.scheduleCanvasRefresh(true);
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
    private readonly t: Translator,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("owen-mermaid-confirm-modal");
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-confirm-shell" });
    shell.createEl("h3", { text: this.t("editor.discardTitle") });
    shell.createEl("p", { text: this.t("editor.discardDescription") });

    const actions = shell.createDiv({ cls: "owen-mermaid-confirm-actions" });
    const keep = actions.createEl("button", { text: this.t("editor.keepEditing"), attr: { type: "button" } });
    const discard = actions.createEl("button", { cls: "is-danger", text: this.t("editor.discard"), attr: { type: "button" } });

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

class MermaidSourceApplyModal extends Modal {
  private handled = false;

  constructor(
    app: App,
    private readonly warnings: string[],
    private readonly onApply: () => void,
    private readonly t: Translator,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("owen-mermaid-confirm-modal");
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-confirm-shell" });
    shell.createEl("h3", { text: this.t("editor.applySourceTitle") });
    shell.createEl("p", { text: this.t("editor.applySourceDescription") });
    const list = shell.createEl("ul", { cls: "owen-mermaid-confirm-list" });
    for (const warning of this.warnings) list.createEl("li", { text: warning });

    const actions = shell.createDiv({ cls: "owen-mermaid-confirm-actions" });
    const cancel = actions.createEl("button", { text: this.t("editor.keepEditing"), attr: { type: "button" } });
    const apply = actions.createEl("button", { text: this.t("editor.applySource"), attr: { type: "button" } });

    cancel.addEventListener("click", () => this.close());
    apply.addEventListener("click", () => this.finish());
  }

  private finish(): void {
    if (this.handled) return;
    this.handled = true;
    this.close();
    this.onApply();
  }
}

class MermaidActionPaletteModal extends Modal {
  private query = "";

  constructor(
    app: App,
    private readonly actions: EditorAction[],
    private readonly t: Translator,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("owen-mermaid-action-palette-modal");
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-action-palette-shell" });
    const input = shell.createEl("input", { cls: "owen-mermaid-action-palette-input", attr: { type: "text", placeholder: this.t("editor.searchActions") } });
    const list = shell.createDiv({ cls: "owen-mermaid-action-palette-list" });

    const render = () => {
      list.empty();
      const query = this.query.toLowerCase();
      const matches = this.actions.filter((action) => !query || `${action.label} ${action.keywords}`.toLowerCase().includes(query)).slice(0, 8);
      for (const action of matches) {
        const button = list.createEl("button", { cls: "owen-mermaid-action-palette-item", text: action.label, attr: { type: "button" } });
        button.addEventListener("click", () => {
          this.close();
          action.run();
        });
      }
    };

    input.addEventListener("input", () => {
      this.query = input.value;
      render();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
      if (event.key === "Enter") {
        const first = list.querySelector<HTMLButtonElement>("button");
        first?.click();
      }
    });
    render();
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    win.requestAnimationFrame(() => input.focus());
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
    private readonly t: Translator,
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
    const cancel = actions.createEl("button", { text: this.t("common.cancel"), attr: { type: "button" } });
    const apply = actions.createEl("button", { text: this.t("common.apply"), attr: { type: "button" } });

    const submit = () => {
      const value = input.value.trim();
      if (!this.allowEmpty && !value) {
        new Notice(this.t("editor.textEmpty"));
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
