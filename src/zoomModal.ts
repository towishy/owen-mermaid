import { App, Modal, setIcon } from "obsidian";
import { ensureLiquidGlassFilter } from "./liquidGlass";

interface ZoomState {
  scale: number;
  minScale: number;
  maxScale: number;
  translateX: number;
  translateY: number;
  isDragging: boolean;
  startX: number;
  startY: number;
}

export class MermaidZoomModal extends Modal {
  private state: ZoomState = {
    scale: 1,
    minScale: 0.1,
    maxScale: 6,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
  };

  private contentWrapper?: HTMLElement;
  private scaleEl?: HTMLElement;
  private readonly cleanup: Array<() => void> = [];

  constructor(
    app: App,
    private readonly sourceSvg: SVGSVGElement,
    private readonly zoomStep: number,
  ) {
    super(app);
  }

  onOpen(): void {
    ensureLiquidGlassFilter(this.containerEl.ownerDocument);
    this.modalEl.addClass("owen-mermaid-zoom-modal");
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "owen-mermaid-zoom-shell" });
    const toolbar = shell.createDiv({ cls: "owen-mermaid-glass-toolbar owen-mermaid-zoom-toolbar" });

    toolbar.createEl("div", { cls: "owen-mermaid-toolbar-title", text: "Mermaid" });
    this.createToolbarButton(toolbar, "zoom-in", "Zoom in", () => this.zoom(1 + this.zoomStep));
    this.createToolbarButton(toolbar, "zoom-out", "Zoom out", () => this.zoom(1 - this.zoomStep));
    this.createToolbarButton(toolbar, "rotate-ccw", "Reset", () => this.fitToStage());
    this.scaleEl = toolbar.createEl("span", { cls: "owen-mermaid-scale", text: "100%" });
    this.createToolbarButton(toolbar, "x", "Close", () => this.close());

    const stage = shell.createDiv({ cls: "owen-mermaid-zoom-stage" });
    this.contentWrapper = stage.createDiv({ cls: "owen-mermaid-zoom-content" });
    const clone = this.sourceSvg.cloneNode(true) as SVGSVGElement;
    clone.removeAttribute("style");
    this.contentWrapper.appendChild(clone);

    this.bindStage(stage);
    requestAnimationFrame(() => this.fitToStage());
  }

  onClose(): void {
    for (const dispose of this.cleanup.splice(0)) dispose();
    this.contentEl.empty();
  }

  private createToolbarButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const button = parent.createEl("button", { cls: "owen-mermaid-icon-button", attr: { "aria-label": label, type: "button" } });
    setIcon(button, icon);
    button.setAttribute("title", label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private bindStage(stage: HTMLElement): void {
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1 - this.zoomStep : 1 + this.zoomStep;
      this.zoom(factor, event.clientX, event.clientY, stage);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      this.state.isDragging = true;
      this.state.startX = event.clientX - this.state.translateX;
      this.state.startY = event.clientY - this.state.translateY;
      stage.addClass("is-dragging");
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!this.state.isDragging) return;
      this.state.translateX = event.clientX - this.state.startX;
      this.state.translateY = event.clientY - this.state.startY;
      this.updateTransform();
    };
    const onMouseUp = () => {
      this.state.isDragging = false;
      stage.removeClass("is-dragging");
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("mousedown", onMouseDown);
    stage.ownerDocument.addEventListener("mousemove", onMouseMove);
    stage.ownerDocument.addEventListener("mouseup", onMouseUp);
    this.cleanup.push(() => stage.removeEventListener("wheel", onWheel));
    this.cleanup.push(() => stage.removeEventListener("mousedown", onMouseDown));
    this.cleanup.push(() => stage.ownerDocument.removeEventListener("mousemove", onMouseMove));
    this.cleanup.push(() => stage.ownerDocument.removeEventListener("mouseup", onMouseUp));
  }

  private zoom(factor: number, clientX?: number, clientY?: number, stage?: HTMLElement): void {
    const nextScale = Math.max(this.state.minScale, Math.min(this.state.maxScale, this.state.scale * factor));
    if (nextScale === this.state.scale) return;

    if (stage && clientX !== undefined && clientY !== undefined) {
      const rect = stage.getBoundingClientRect();
      const anchorX = clientX - rect.left;
      const anchorY = clientY - rect.top;
      const ratio = nextScale / this.state.scale;
      this.state.translateX = anchorX - (anchorX - this.state.translateX) * ratio;
      this.state.translateY = anchorY - (anchorY - this.state.translateY) * ratio;
    }

    this.state.scale = nextScale;
    this.updateTransform();
  }

  private fitToStage(): void {
    const wrapper = this.contentWrapper;
    const stage = wrapper?.parentElement;
    const svg = wrapper?.querySelector("svg");
    if (!wrapper || !stage || !svg) return;

    const stageRect = stage.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const sourceWidth = svgRect.width / this.state.scale || 800;
    const sourceHeight = svgRect.height / this.state.scale || 600;
    const scale = Math.min((stageRect.width - 56) / sourceWidth, (stageRect.height - 56) / sourceHeight, 2);

    this.state.scale = Math.max(0.1, scale);
    this.state.translateX = (stageRect.width - sourceWidth * this.state.scale) / 2;
    this.state.translateY = (stageRect.height - sourceHeight * this.state.scale) / 2;
    this.updateTransform();
  }

  private updateTransform(): void {
    if (!this.contentWrapper) return;
    this.contentWrapper.style.transform = `translate(${this.state.translateX}px, ${this.state.translateY}px) scale(${this.state.scale})`;
    if (this.scaleEl) this.scaleEl.setText(`${Math.round(this.state.scale * 100)}%`);
  }
}
