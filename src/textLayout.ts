export interface NodeLabelLayout {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  firstBaseline: number;
  truncated: boolean;
}

const MIN_FONT_SIZE = 8;
const HORIZONTAL_PADDING = 24;
const VERTICAL_PADDING = 16;
const LINE_HEIGHT_RATIO = 1.25;

export function layoutNodeLabel(label: string, width: number, height: number, preferredFontSize = 13): NodeLabelLayout {
  const maxWidth = Math.max(16, width - HORIZONTAL_PADDING);
  const maxHeight = Math.max(MIN_FONT_SIZE * LINE_HEIGHT_RATIO, height - VERTICAL_PADDING);
  const normalized = label.replace(/<br\s*\/?>/gi, "\n").replace(/\r\n?/g, "\n");
  const preferred = Math.max(MIN_FONT_SIZE, preferredFontSize);

  for (let fontSize = preferred; fontSize >= MIN_FONT_SIZE; fontSize -= 1) {
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const lines = wrapLabel(normalized, maxWidth, fontSize);
    if (lines.length * lineHeight <= maxHeight) return createLayout(lines, fontSize, lineHeight, false);
  }

  const fontSize = MIN_FONT_SIZE;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const lines = wrapLabel(normalized, maxWidth, fontSize);
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) visible[maxLines - 1] = fitWithEllipsis(visible[maxLines - 1] ?? "", maxWidth, fontSize);
  return createLayout(visible, fontSize, lineHeight, lines.length > maxLines);
}

function createLayout(lines: string[], fontSize: number, lineHeight: number, truncated: boolean): NodeLabelLayout {
  const visibleLines = lines.length > 0 ? lines : [""];
  return {
    lines: visibleLines,
    fontSize,
    lineHeight,
    firstBaseline: -((visibleLines.length - 1) * lineHeight) / 2 + fontSize * 0.35,
    truncated,
  };
}

function wrapLabel(label: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const explicitLine of label.split("\n")) {
    let remaining = explicitLine.trim();
    if (!remaining) {
      lines.push("");
      continue;
    }

    while (estimateTextWidth(remaining, fontSize) > maxWidth) {
      const cut = findWrapIndex(remaining, maxWidth, fontSize);
      lines.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    lines.push(remaining);
  }
  return lines;
}

function findWrapIndex(value: string, maxWidth: number, fontSize: number): number {
  let lastBreak = 0;
  for (let index = 1; index <= value.length; index += 1) {
    const character = value[index - 1] ?? "";
    if (/\s|[,/;:]/.test(character)) lastBreak = index;
    if (estimateTextWidth(value.slice(0, index), fontSize) > maxWidth) {
      if (lastBreak > 0) return lastBreak;
      return Math.max(1, index - 1);
    }
  }
  return value.length;
}

function fitWithEllipsis(value: string, maxWidth: number, fontSize: number): string {
  let text = value.trimEnd();
  while (text && estimateTextWidth(`${text}...`, fontSize) > maxWidth) text = text.slice(0, -1).trimEnd();
  return `${text}...`;
}

function estimateTextWidth(value: string, fontSize: number): number {
  let units = 0;
  for (const character of value) {
    if (/\s/.test(character)) units += 0.34;
    else if (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/.test(character)) units += 1;
    else if (/[A-Z0-9]/.test(character)) units += 0.66;
    else if (/[,.;:'`!|]/.test(character)) units += 0.32;
    else units += 0.56;
  }
  return units * fontSize;
}