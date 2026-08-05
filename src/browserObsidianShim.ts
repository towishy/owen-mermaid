type CreateOptions = {
  attr?: Record<string, string>;
  cls?: string | string[];
  text?: string;
  value?: string;
};

declare global {
  interface Element {
    addClass(...classes: string[]): void;
    createDiv(options?: CreateOptions): HTMLDivElement;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: CreateOptions): HTMLElementTagNameMap[K];
    createSpan(options?: CreateOptions): HTMLSpanElement;
    createSvg<K extends keyof SVGElementTagNameMap>(tag: K, options?: CreateOptions): SVGElementTagNameMap[K];
    empty(): void;
    removeClass(...classes: string[]): void;
    setText(value: string): void;
    toggleClass(className: string, force?: boolean): void;
  }
}

installDomHelpers();

export class App {}

export class Modal {
  readonly app: App;
  readonly containerEl: HTMLDialogElement;
  readonly modalEl: HTMLDialogElement;
  readonly contentEl: HTMLDivElement;
  private cleaned = false;

  constructor(app: App) {
    this.app = app;
    this.modalEl = document.createElement("dialog");
    this.modalEl.className = "modal owen-mermaid-browser-modal";
    this.modalEl.setAttribute("aria-modal", "true");
    this.containerEl = this.modalEl;
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.contentEl);
    this.modalEl.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.modalEl.addEventListener("click", (event) => {
      if (event.target === this.modalEl) this.close();
    });
    this.modalEl.addEventListener("close", () => this.finishClose());
  }

  open(): void {
    if (this.modalEl.isConnected) return;
    document.body.append(this.modalEl);
    this.modalEl.showModal();
    this.onOpen();
  }

  close(): void {
    if (this.modalEl.open) this.modalEl.close();
    else this.finishClose();
  }

  onOpen(): void {}
  onClose(): void {}

  private finishClose(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.onClose();
    this.modalEl.remove();
  }
}

class BrowserMenuItem {
  readonly element: HTMLButtonElement;
  private readonly iconElement: HTMLSpanElement;
  private readonly titleElement: HTMLSpanElement;
  private action: () => void = () => {};

  constructor(onSelect: () => void) {
    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.setAttribute("role", "menuitem");
    this.iconElement = document.createElement("span");
    this.iconElement.className = "owen-mermaid-browser-menu-icon";
    this.titleElement = document.createElement("span");
    this.element.append(this.iconElement, this.titleElement);
    this.element.addEventListener("click", () => {
      onSelect();
      this.action();
    });
  }

  setTitle(title: string): this {
    this.titleElement.textContent = title;
    return this;
  }

  setIcon(icon: string): this {
    setIcon(this.iconElement, icon);
    return this;
  }

  onClick(action: () => void): this {
    this.action = action;
    return this;
  }
}

export class Menu {
  private readonly element = document.createElement("div");
  private readonly outsideHandler = (event: PointerEvent) => {
    if (!this.element.contains(event.target as Node)) this.hide();
  };

  constructor() {
    this.element.className = "owen-mermaid-browser-menu";
    this.element.setAttribute("role", "menu");
  }

  addItem(builder: (item: BrowserMenuItem) => void): this {
    const item = new BrowserMenuItem(() => this.hide());
    builder(item);
    this.element.append(item.element);
    return this;
  }

  addSeparator(): this {
    const separator = document.createElement("div");
    separator.className = "owen-mermaid-browser-menu-separator";
    separator.setAttribute("role", "separator");
    this.element.append(separator);
    return this;
  }

  showAtMouseEvent(event: MouseEvent): void {
    document.body.append(this.element);
    const bounds = this.element.getBoundingClientRect();
    this.element.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - bounds.width - 8))}px`;
    this.element.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - bounds.height - 8))}px`;
    window.setTimeout(() => document.addEventListener("pointerdown", this.outsideHandler, true), 0);
  }

  hide(): void {
    document.removeEventListener("pointerdown", this.outsideHandler, true);
    this.element.remove();
  }
}

export class Notice {
  constructor(message: string) {
    const element = document.createElement("div");
    element.className = "owen-mermaid-browser-notice";
    element.setAttribute("role", "status");
    element.textContent = message;
    document.body.append(element);
    window.setTimeout(() => element.remove(), 2400);
  }
}

export function setIcon(element: HTMLElement, icon: string): void {
  element.replaceChildren();
  const placeholder = document.createElement("i");
  placeholder.setAttribute("data-lucide", icon);
  placeholder.setAttribute("aria-hidden", "true");
  element.append(placeholder);
  queueMicrotask(() => {
    const lucide = (window as Window & { lucide?: { createIcons(options?: unknown): void; icons?: unknown } }).lucide;
    lucide?.createIcons({ attrs: { "aria-hidden": "true", "stroke-width": "1.75" }, icons: lucide.icons });
  });
}

function installDomHelpers(): void {
  const prototype = Element.prototype as Element & Record<string, unknown>;
  if (typeof prototype.createEl !== "function") {
    prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(this: Element, tag: K, options: CreateOptions = {}): HTMLElementTagNameMap[K] {
      const element = this.ownerDocument.createElement(tag);
      applyOptions(element, options);
      this.append(element);
      return element;
    };
  }
  if (typeof prototype.createDiv !== "function") prototype.createDiv = function createDiv(this: Element, options: CreateOptions = {}) { return this.createEl("div", options); };
  if (typeof prototype.createSpan !== "function") prototype.createSpan = function createSpan(this: Element, options: CreateOptions = {}) { return this.createEl("span", options); };
  if (typeof prototype.createSvg !== "function") {
    prototype.createSvg = function createSvg<K extends keyof SVGElementTagNameMap>(this: Element, tag: K, options: CreateOptions = {}): SVGElementTagNameMap[K] {
      const element = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
      applyOptions(element, options);
      this.append(element);
      return element;
    };
  }
  if (typeof prototype.empty !== "function") prototype.empty = function empty(this: Element) { this.replaceChildren(); };
  if (typeof prototype.addClass !== "function") prototype.addClass = function addClass(this: Element, ...classes: string[]) { this.classList.add(...classes.flatMap((value) => value.split(/\s+/)).filter(Boolean)); };
  if (typeof prototype.removeClass !== "function") prototype.removeClass = function removeClass(this: Element, ...classes: string[]) { this.classList.remove(...classes.flatMap((value) => value.split(/\s+/)).filter(Boolean)); };
  if (typeof prototype.toggleClass !== "function") prototype.toggleClass = function toggleClass(this: Element, className: string, force?: boolean) { this.classList.toggle(className, force); };
  if (typeof prototype.setText !== "function") prototype.setText = function setText(this: Element, value: string) { this.textContent = value; };
}

function applyOptions(element: Element, options: CreateOptions): void {
  const classes = Array.isArray(options.cls) ? options.cls : options.cls?.split(/\s+/);
  if (classes?.length) element.classList.add(...classes.filter(Boolean));
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
  if (options.value !== undefined && "value" in element) (element as HTMLInputElement).value = options.value;
}