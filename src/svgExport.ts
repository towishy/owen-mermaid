import type { ExportFormat } from "./types";

const MAX_CANVAS_DIMENSION = 16384;
const SVG_NS = "http://www.w3.org/2000/svg";

export async function svgToImageBlob(svg: SVGSVGElement, format: ExportFormat, scale: number, background = "#FFFFFF", quality = 0.92): Promise<Blob> {
  const preparedSvg = prepareSvg(svg);
  const svgString = new XMLSerializer().serializeToString(preparedSvg);
  const win = svg.ownerDocument.defaultView ?? window;
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const imageUrl = win.URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      win.URL.revokeObjectURL(imageUrl);
      const dimensions = getSvgDimensions(preparedSvg, image);
      let canvasWidth = Math.max(1, Math.round(dimensions.width * scale));
      let canvasHeight = Math.max(1, Math.round(dimensions.height * scale));

      if (canvasWidth > MAX_CANVAS_DIMENSION || canvasHeight > MAX_CANVAS_DIMENSION) {
        const downscale = Math.min(MAX_CANVAS_DIMENSION / canvasWidth, MAX_CANVAS_DIMENSION / canvasHeight);
        canvasWidth = Math.floor(canvasWidth * downscale);
        canvasHeight = Math.floor(canvasHeight * downscale);
      }

      const canvas = svg.ownerDocument.createElement("canvas");
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas context is not available"));
        return;
      }

      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export returned no data"))),
        format === "jpg" ? "image/jpeg" : "image/png",
        quality,
      );
    };
    image.onerror = () => {
      win.URL.revokeObjectURL(imageUrl);
      reject(new Error("SVG could not be loaded as an image"));
    };
    image.src = imageUrl;
  });
}

function prepareSvg(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.querySelectorAll("script").forEach((script) => script.remove());
  clone.querySelectorAll("foreignObject").forEach((foreignObject) => replaceForeignObjectWithText(foreignObject, svg));
  ensureDimensions(clone, svg);
  inlineComputedSvgStyles(clone, svg);
  return clone;
}

function replaceForeignObjectWithText(foreignObject: Element, originalSvg: SVGSVGElement): void {
  const bounds = readBounds(foreignObject);
  const lines = (foreignObject.textContent ?? "").split(/\s*\n\s*/).map((line) => line.trim()).filter(Boolean);
  const text = originalSvg.ownerDocument.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(bounds.x + bounds.width / 2));
  text.setAttribute("y", String(bounds.y + bounds.height / 2));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  text.setAttribute("fill", "currentColor");
  text.setAttribute("font-size", "14");

  if (lines.length <= 1) {
    text.textContent = lines[0] ?? foreignObject.textContent ?? "";
  } else {
    const offset = -((lines.length - 1) * 16) / 2;
    for (const [index, line] of lines.entries()) {
      const tspan = originalSvg.ownerDocument.createElementNS(SVG_NS, "tspan");
      tspan.setAttribute("x", String(bounds.x + bounds.width / 2));
      tspan.setAttribute("dy", index === 0 ? String(offset) : "16");
      tspan.textContent = line;
      text.appendChild(tspan);
    }
  }

  foreignObject.replaceWith(text);
}

function ensureDimensions(clone: SVGSVGElement, original: SVGSVGElement): void {
  const dimensions = getElementDimensions(original);
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(dimensions.width));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(dimensions.height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`);
}

function getSvgDimensions(svg: SVGSVGElement, image: HTMLImageElement): { width: number; height: number } {
  const width = parseFloat(svg.getAttribute("width") ?? "") || image.naturalWidth || 800;
  const height = parseFloat(svg.getAttribute("height") ?? "") || image.naturalHeight || 600;
  return { width, height };
}

function getElementDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    width: parseFloat(svg.getAttribute("width") ?? "") || rect.width || viewBox.width || 800,
    height: parseFloat(svg.getAttribute("height") ?? "") || rect.height || viewBox.height || 600,
  };
}

function readBounds(element: Element): { x: number; y: number; width: number; height: number } {
  return {
    x: parseFloat(element.getAttribute("x") ?? "0") || 0,
    y: parseFloat(element.getAttribute("y") ?? "0") || 0,
    width: parseFloat(element.getAttribute("width") ?? "0") || 0,
    height: parseFloat(element.getAttribute("height") ?? "0") || 0,
  };
}

function inlineComputedSvgStyles(clone: SVGSVGElement, original: SVGSVGElement): void {
  const selector = "text, path, rect, circle, ellipse, polygon, polyline, line";
  const originalElements = Array.from(original.querySelectorAll<SVGElement>(selector));
  Array.from(clone.querySelectorAll<SVGElement>(selector)).forEach((element, index) => {
    const source = originalElements[index];
    if (!source) return;
    const style = getComputedStyle(source);

    setPresentationAttribute(element, "fill", style.fill || style.color);
    setPresentationAttribute(element, "stroke", style.stroke);
    setPresentationAttribute(element, "stroke-width", style.strokeWidth);
    setPresentationAttribute(element, "stroke-dasharray", style.strokeDasharray);
    setPresentationAttribute(element, "stroke-linecap", style.strokeLinecap);
    setPresentationAttribute(element, "stroke-linejoin", style.strokeLinejoin);
    setPresentationAttribute(element, "opacity", style.opacity);

    if (element.tagName.toLowerCase() === "text") {
      setPresentationAttribute(element, "font-family", style.fontFamily || "Arial, sans-serif");
      setPresentationAttribute(element, "font-size", style.fontSize || "14px");
      setPresentationAttribute(element, "font-weight", style.fontWeight);
    }
  });
}

function setPresentationAttribute(element: SVGElement, name: string, value: string): void {
  const normalized = value.trim();
  if (!normalized || normalized === "normal" || normalized === "auto") return;
  element.setAttribute(name, normalized);
}
