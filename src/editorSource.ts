import { generateFlowchart, parseFlowchart } from "./flowchart";
import type { FlowDiagram } from "./types";

export type DiffLineKind = "added" | "removed";

export interface SourceDraftAssessment {
  diagram: FlowDiagram;
  warnings: string[];
}

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface SourceDiagnostic {
  severity: "info" | "warning";
  message: string;
}

export function assessSourceDraft(source: string, currentDiagram: FlowDiagram): SourceDraftAssessment {
  const nextDiagram = parseFlowchart(source, currentDiagram.direction);
  const warnings: string[] = [];
  if (nextDiagram.syntax !== currentDiagram.syntax) warnings.push(`Syntax changes from ${currentDiagram.syntax} to ${nextDiagram.syntax}.`);
  if (currentDiagram.nodes.length > 0 && nextDiagram.nodes.length < currentDiagram.nodes.length) warnings.push(`Visual nodes decrease from ${currentDiagram.nodes.length} to ${nextDiagram.nodes.length}.`);
  if (currentDiagram.edges.length > 0 && nextDiagram.edges.length < currentDiagram.edges.length) warnings.push(`Connectors decrease from ${currentDiagram.edges.length} to ${nextDiagram.edges.length}.`);
  if (nextDiagram.unsupportedLines.length > currentDiagram.unsupportedLines.length) warnings.push(`${nextDiagram.unsupportedLines.length} line(s) will be preserved but not visually editable.`);
  return { diagram: nextDiagram, warnings };
}

export function createSourceDiffLines(previousSource: string, nextSource: string, maxLines = 80): DiffLine[] {
  const previous = previousSource.trimEnd().split(/\r?\n/);
  const next = nextSource.trimEnd().split(/\r?\n/);
  if (previous.join("\n") === next.join("\n")) return [];

  const lines: DiffLine[] = [];
  const max = Math.max(previous.length, next.length);
  for (let index = 0; index < max; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === after) continue;
    if (before !== undefined) lines.push({ kind: "removed", text: `- ${before}` });
    if (after !== undefined) lines.push({ kind: "added", text: `+ ${after}` });
    if (lines.length > maxLines) {
      lines.push({ kind: "added", text: "..." });
      break;
    }
  }
  return lines;
}

export function createChangeSummary(previousSource: string, diagram: FlowDiagram): string[] {
  const previous = parseFlowchart(previousSource, diagram.direction);
  const items: string[] = [];
  let nodeTextChanges = 0;
  let nodeStyleChanges = 0;
  let layoutChanges = 0;
  let connectorChanges = 0;
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));

  for (const node of diagram.nodes) {
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
  for (const edge of diagram.edges) {
    const before = previousEdges.get(edge.id);
    if (!before || before.from !== edge.from || before.to !== edge.to || before.label !== edge.label || before.style !== edge.style || edge.route !== before.route || before.strokeColor !== edge.strokeColor || before.textColor !== edge.textColor || before.strokeWidth !== edge.strokeWidth || before.textSize !== edge.textSize) connectorChanges += 1;
  }

  if (nodeTextChanges > 0) items.push(`${nodeTextChanges} node text or shape change(s)`);
  if (nodeStyleChanges > 0) items.push(`${nodeStyleChanges} node style change(s)`);
  if (connectorChanges > 0) items.push(`${connectorChanges} connector change(s)`);
  if (layoutChanges > 0) items.push(`${layoutChanges} editor layout change(s)`);
  if (previous.freeLines.length !== diagram.freeLines.length) items.push("Free line count changed");
  return items;
}

export function createSourceDiagnostics(source: string, currentDiagram: FlowDiagram): SourceDiagnostic[] {
  const nextDiagram = parseFlowchart(source, currentDiagram.direction);
  const diagnostics: SourceDiagnostic[] = [];
  diagnostics.push({ severity: "info", message: `${nextDiagram.syntax}: ${nextDiagram.nodes.length} node(s), ${nextDiagram.edges.length} connector(s).` });
  if (nextDiagram.unsupportedLines.length > 0) diagnostics.push({ severity: "warning", message: `${nextDiagram.unsupportedLines.length} preserved line(s) are not visually editable.` });
  if (nextDiagram.syntax !== currentDiagram.syntax) diagnostics.push({ severity: "warning", message: `Applying changes switches syntax from ${currentDiagram.syntax} to ${nextDiagram.syntax}.` });
  if (currentDiagram.nodes.length > 0 && nextDiagram.nodes.length === 0) diagnostics.push({ severity: "warning", message: "No visual nodes were parsed from this source." });
  return diagnostics;
}

export function generateEditorSource(diagram: FlowDiagram): string {
  return generateFlowchart(diagram);
}
