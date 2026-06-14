import assert from "node:assert/strict";
import test from "node:test";
import { assessSourceDraft, createChangeSummary, createSourceDiagnostics, createSourceDiffLines, generateEditorSource } from "../src/editorSource";
import { parseFlowchart } from "../src/flowchart";

test("assesses source edits that reduce visual coverage", () => {
  const current = parseFlowchart("flowchart LR\n  A[Start] --> B[Done]\n", "TD");
  const assessment = assessSourceDraft("sequenceDiagram\n  participant A as Alice\n  note over A: preserved\n", current);

  assert.equal(assessment.diagram.syntax, "sequenceDiagram");
  assert.match(assessment.warnings.join("\n"), /Syntax changes from flowchart to sequenceDiagram/);
  assert.match(assessment.warnings.join("\n"), /Connectors decrease/);
  assert.match(assessment.warnings.join("\n"), /preserved but not visually editable/);
});

test("creates compact source diff lines", () => {
  const diff = createSourceDiffLines("flowchart LR\n  A[One]\n", "flowchart LR\n  A[Two]\n");

  assert.deepEqual(diff, [
    { kind: "removed", text: "-   A[One]" },
    { kind: "added", text: "+   A[Two]" },
  ]);
});

test("creates source diagnostics for preserved lines", () => {
  const current = parseFlowchart("flowchart LR\n  A[Start]\n", "TD");
  const diagnostics = createSourceDiagnostics("flowchart LR\n  A[Start]\n  subgraph Group\n    B[Inside]\n  end\n", current);

  assert.equal(diagnostics[0]?.severity, "info");
  assert.match(diagnostics.map((item) => item.message).join("\n"), /preserved line\(s\) are not visually editable/);
});

test("summarizes editor-visible changes", () => {
  const source = "flowchart LR\n  A[Start] --> B[Done]\n";
  const diagram = parseFlowchart(source, "TD");
  const node = diagram.nodes.find((item) => item.id === "A");
  const edge = diagram.edges[0];
  assert.ok(node);
  assert.ok(edge);

  node.label = "Changed";
  node.x += 25;
  node.fillColor = "#dbeafe";
  edge.label = "approve";

  assert.deepEqual(createChangeSummary(source, diagram), [
    "1 node text or shape change(s)",
    "1 node style change(s)",
    "1 connector change(s)",
    "1 editor layout change(s)",
  ]);
  assert.match(generateEditorSource(diagram), /A\[Changed\]/);
});
