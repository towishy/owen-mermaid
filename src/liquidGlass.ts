const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_ID = "owen-mermaid-liquid-glass-filter";
const FILTER_SVG_ID = "owen-mermaid-liquid-glass-filter-svg";

export function ensureLiquidGlassFilter(doc: Document): void {
  if (doc.getElementById(FILTER_SVG_ID)) return;

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.id = FILTER_SVG_ID;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "owen-mermaid-liquid-glass-filter-svg");

  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.id = FILTER_ID;
  filter.setAttribute("x", "0%");
  filter.setAttribute("y", "0%");
  filter.setAttribute("width", "100%");
  filter.setAttribute("height", "100%");
  filter.setAttribute("filterUnits", "objectBoundingBox");

  const componentTransfer = doc.createElementNS(SVG_NS, "feComponentTransfer");
  componentTransfer.setAttribute("in", "SourceAlpha");
  componentTransfer.setAttribute("result", "alpha");
  const alpha = doc.createElementNS(SVG_NS, "feFuncA");
  alpha.setAttribute("type", "identity");
  componentTransfer.appendChild(alpha);

  const blur = doc.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("in", "alpha");
  blur.setAttribute("stdDeviation", "16");
  blur.setAttribute("result", "blur");

  const displacement = doc.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in", "SourceGraphic");
  displacement.setAttribute("in2", "blur");
  displacement.setAttribute("scale", "16");
  displacement.setAttribute("xChannelSelector", "A");
  displacement.setAttribute("yChannelSelector", "A");

  filter.appendChild(componentTransfer);
  filter.appendChild(blur);
  filter.appendChild(displacement);
  svg.appendChild(filter);
  doc.body.appendChild(svg);
}
