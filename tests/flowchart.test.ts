import assert from "node:assert/strict";
import test from "node:test";
import { generateFlowchart, parseFlowchart } from "../src/flowchart";

test("round-trips a labelled flowchart edge", () => {
  const diagram = parseFlowchart("flowchart LR\n  A[Start] -- approve --> B{Done}\n", "TD");

  assert.equal(diagram.direction, "LR");
  assert.equal(diagram.nodes.length, 2);
  assert.equal(diagram.edges[0]?.label, "approve");
  assert.match(generateFlowchart(diagram, false), /A -- approve --> B/);
});

test("keeps Mermaid init directives before the generated header", () => {
  const diagram = parseFlowchart('%%{init: {"theme": "base"}}%%\nflowchart TD\n  A[One]\n', "LR");
  const output = generateFlowchart(diagram, false).split("\n");

  assert.equal(output[0], '%%{init: {"theme": "base"}}%%');
  assert.equal(output[1], "flowchart TD");
});

test("preserves unsupported subgraph blocks without parsing their contents twice", () => {
  const diagram = parseFlowchart("flowchart LR\nsubgraph Group\n  A[Inside]\n  A --> B\nend\n", "TD");
  const output = generateFlowchart(diagram, false);

  assert.equal(diagram.nodes.length, 0);
  assert.match(output, /subgraph Group/);
  assert.match(output, /A --> B/);
  assert.match(output, /end/);
});

test("sequence participant aliases are not overwritten by message parsing", () => {
  const diagram = parseFlowchart("sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A-->>B: Hello\n", "TD");

  assert.equal(diagram.nodes.find((node) => node.id === "A")?.label, "Alice");
  assert.equal(diagram.nodes.find((node) => node.id === "B")?.label, "Bob");
  assert.equal(diagram.edges[0]?.style, "dotted");
});

test("preserves common flowchart styling and interaction lines", () => {
  const source = [
    "flowchart TD",
    "  A[Start] --> B[Next]",
    "  classDef active fill:#fff,stroke:#333",
    "  class A active",
    "  style B fill:#eef",
    "  click A callback",
    "  linkStyle 0 stroke:#999",
  ].join("\n");
  const output = generateFlowchart(parseFlowchart(source, "LR"), false);

  assert.match(output, /classDef active/);
  assert.match(output, /class A active/);
  assert.match(output, /style B fill:#eef/);
  assert.match(output, /click A callback/);
  assert.match(output, /linkStyle 0 stroke:#999/);
});

test("round-trips free line metadata", () => {
  const source = 'flowchart LR\n  %% owen-mermaid: {"nodes":{"A":{"x":120,"y":100}},"freeLines":[{"id":"freeLine1","x1":0,"y1":0,"x2":100,"y2":40,"label":"note","style":"dotted"}]}\n  A[Start]\n';
  const diagram = parseFlowchart(source, "TD");

  assert.equal(diagram.freeLines.length, 1);
  assert.equal(diagram.freeLines[0]?.style, "dotted");
  assert.match(generateFlowchart(diagram), /"freeLines"/);
});

test("normalizes quoted node labels", () => {
  const diagram = parseFlowchart('flowchart TD\n  A["Quoted label"]\n', "LR");

  assert.equal(diagram.nodes[0]?.label, "Quoted label");
  assert.match(generateFlowchart(diagram, false), /A\[Quoted label\]/);
});

test("keeps state diagram markers and labels", () => {
  const diagram = parseFlowchart('stateDiagram-v2\n  [*] --> Ready\n  state "Ready state" as Ready\n  Ready --> [*]: done\n', "LR");
  const output = generateFlowchart(diagram, false);

  assert.equal(diagram.syntax, "stateDiagram");
  assert.match(output, /\[\*\] --> Ready/);
  assert.match(output, /Ready --> \[\*\]: done/);
});