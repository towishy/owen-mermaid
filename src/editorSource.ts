import { generateFlowchart, parseFlowchart } from "./flowchart";
import { createTranslator, type Locale } from "./i18n";
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

export function assessSourceDraft(source: string, currentDiagram: FlowDiagram, locale: Locale = "en"): SourceDraftAssessment {
  const t = createTranslator(locale);
  const nextDiagram = parseFlowchart(source, currentDiagram.direction);
  const warnings: string[] = [];
  if (nextDiagram.syntax !== currentDiagram.syntax) warnings.push(t("source.syntaxChange", { from: currentDiagram.syntax, to: nextDiagram.syntax }));
  if (currentDiagram.nodes.length > 0 && nextDiagram.nodes.length < currentDiagram.nodes.length) warnings.push(t("source.nodesDecrease", { from: currentDiagram.nodes.length, to: nextDiagram.nodes.length }));
  if (currentDiagram.edges.length > 0 && nextDiagram.edges.length < currentDiagram.edges.length) warnings.push(t("source.connectorsDecrease", { from: currentDiagram.edges.length, to: nextDiagram.edges.length }));
  if (nextDiagram.unsupportedLines.length > currentDiagram.unsupportedLines.length) warnings.push(t("source.preservedLines", { count: nextDiagram.unsupportedLines.length }));
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

export function createChangeSummary(previousSource: string, diagram: FlowDiagram, locale: Locale = "en"): string[] {
  const t = createTranslator(locale);
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

  if (nodeTextChanges > 0) items.push(t("source.nodeTextChanges", { count: nodeTextChanges }));
  if (nodeStyleChanges > 0) items.push(t("source.nodeStyleChanges", { count: nodeStyleChanges }));
  if (connectorChanges > 0) items.push(t("source.connectorChanges", { count: connectorChanges }));
  if (layoutChanges > 0) items.push(t("source.layoutChanges", { count: layoutChanges }));
  if (previous.freeLines.length !== diagram.freeLines.length) items.push(t("source.freeLineCountChanged"));
  return items;
}

export function createSourceDiagnostics(source: string, currentDiagram: FlowDiagram, locale: Locale = "en"): SourceDiagnostic[] {
  const t = createTranslator(locale);
  const nextDiagram = parseFlowchart(source, currentDiagram.direction);
  const diagnostics: SourceDiagnostic[] = [];
  diagnostics.push({ severity: "info", message: t("source.diagnosticSummary", { syntax: nextDiagram.syntax, nodes: nextDiagram.nodes.length, connectors: nextDiagram.edges.length }) });
  if (nextDiagram.unsupportedLines.length > 0) diagnostics.push({ severity: "warning", message: t("source.diagnosticPreserved", { count: nextDiagram.unsupportedLines.length }) });
  if (nextDiagram.syntax !== currentDiagram.syntax) diagnostics.push({ severity: "warning", message: t("source.diagnosticSyntax", { from: currentDiagram.syntax, to: nextDiagram.syntax }) });
  if (currentDiagram.nodes.length > 0 && nextDiagram.nodes.length === 0) diagnostics.push({ severity: "warning", message: t("source.diagnosticNoNodes") });
  return diagnostics;
}

export function generateEditorSource(diagram: FlowDiagram): string {
  return generateFlowchart(diagram);
}
