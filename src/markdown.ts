import type { MermaidBlockContext } from "./types";

export interface MermaidFenceInfo {
  source: string;
  lineStart: number;
  lineEnd: number;
}

export function extractMermaidSource(sectionText: string): string {
  const lines = sectionText.split(/\r?\n/);
  const opening = findFenceLine(lines, 0, lines.length - 1, true);
  const closing = opening === -1 ? -1 : findFenceLine(lines, opening + 1, lines.length - 1, false);
  if (opening >= 0 && closing > opening) return lines.slice(opening + 1, closing).join("\n");
  return sectionText;
}

export function findMermaidFences(content: string): MermaidFenceInfo[] {
  return findMermaidFencesFromLines(content.split(/\r?\n/));
}

export function replaceMermaidSourceInContent(content: string, context: MermaidBlockContext, nextSource: string): string {
  const lines = content.split(/\r?\n/);
  const fence = findReplacementFence(lines, context);
  const replacementSource = extractMermaidSource(nextSource).trimEnd();
  const nextLines = replacementSource.split(/\r?\n/);

  if (fence) {
    lines.splice(fence.lineStart + 1, fence.lineEnd - fence.lineStart - 1, ...nextLines);
    return lines.join("\n");
  }

  if (context.lineStart !== undefined && context.lineEnd !== undefined) {
    const rangeStart = clampLine(context.lineStart, lines.length);
    const rangeEnd = clampLine(context.lineEnd, lines.length);
    lines.splice(rangeStart, rangeEnd - rangeStart + 1, "```mermaid", ...nextLines, "```");
    return lines.join("\n");
  }

  lines.push("```mermaid", ...nextLines, "```");
  return lines.join("\n");
}

function findReplacementFence(lines: string[], context: MermaidBlockContext): MermaidFenceInfo | undefined {
  const rangeStart = context.lineStart === undefined ? undefined : clampLine(context.lineStart, lines.length);
  const rangeEnd = context.lineEnd === undefined ? undefined : clampLine(context.lineEnd, lines.length);

  if (rangeStart !== undefined && rangeEnd !== undefined) {
    const opening = findFenceLine(lines, rangeStart, rangeEnd, true);
    const closing = opening === -1 ? -1 : findFenceLine(lines, opening + 1, rangeEnd, false);
    if (opening >= 0 && closing > opening) return createFenceInfo(lines, opening, closing);
  }

  const fences = findMermaidFencesFromLines(lines);

  if (rangeStart !== undefined && rangeEnd !== undefined) {
    const containingFence = fences.find((fence) => fence.lineStart <= rangeStart && rangeEnd <= fence.lineEnd);
    if (containingFence) return containingFence;

    const touchingFence = fences.find((fence) => fence.lineStart <= rangeStart && rangeStart <= fence.lineEnd);
    if (touchingFence) return touchingFence;
  }

  const source = context.source?.trim();
  if (source) {
    const matchingFence = fences.find((fence) => fence.source.trim() === source);
    if (matchingFence) return matchingFence;
  }

  const blockIndex = context.blockIndex ?? -1;
  if (blockIndex >= 0 && blockIndex < fences.length) return fences[blockIndex];
  return undefined;
}

function findMermaidFencesFromLines(lines: string[]): MermaidFenceInfo[] {
  const fences: MermaidFenceInfo[] = [];
  let opening = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (opening === -1) {
      if (/^```\s*mermaid\b/i.test(line)) opening = index;
      continue;
    }

    if (/^```\s*$/.test(line)) {
      fences.push(createFenceInfo(lines, opening, index));
      opening = -1;
    }
  }

  return fences;
}

function createFenceInfo(lines: string[], opening: number, closing: number): MermaidFenceInfo {
  return {
    lineStart: opening,
    lineEnd: closing,
    source: lines.slice(opening + 1, closing).join("\n"),
  };
}

function findFenceLine(lines: string[], start: number, end: number, opening: boolean): number {
  for (let index = start; index <= end; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (opening && /^```\s*mermaid\b/i.test(line)) return index;
    if (!opening && /^```\s*$/.test(line)) return index;
  }
  return -1;
}

function clampLine(line: number, lineCount: number): number {
  return Math.max(0, Math.min(Math.max(0, lineCount - 1), line));
}
