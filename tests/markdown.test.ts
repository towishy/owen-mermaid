import assert from "node:assert/strict";
import test from "node:test";
import { extractMermaidSource, findMermaidFences, replaceMermaidSourceInContent } from "../src/markdown";

test("extracts Mermaid source from a fenced section", () => {
  const section = ["```mermaid", "flowchart LR", "  A[Start] --> B[Next]", "```"].join("\n");

  assert.equal(extractMermaidSource(section), "flowchart LR\n  A[Start] --> B[Next]");
});

test("replaces a Mermaid fence when the context range points only at the inner source", () => {
  const content = [
    "# Note",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Before] --> B[After]",
    "```",
    "",
    "## 3. State Diagram",
    "",
    "This paragraph must stay outside a code block.",
    "",
    "```mermaid",
    "stateDiagram-v2",
    "  [*] --> Ready",
    "```",
  ].join("\n");

  const nextSource = ["flowchart TD", "  A[Changed] --> B[Done]", ""].join("\n");
  const output = replaceMermaidSourceInContent(content, { lineStart: 3, lineEnd: 4 }, nextSource);
  const fences = findMermaidFences(output);

  assert.equal(fences.length, 2);
  assert.equal(fences[0]?.source, "flowchart TD\n  A[Changed] --> B[Done]");
  assert.equal(output.split("\n")[5], "```");
  assert.match(output, /\n## 3\. State Diagram\n\nThis paragraph must stay outside a code block\./);
});

test("matches by source when a rendered section range starts before the Mermaid fence", () => {
  const content = [
    "## 2. Flowchart",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[One] --> B[Two]",
    "```",
    "",
    "## 3. Flowchart",
    "",
    "```mermaid",
    "flowchart LR",
    "  C[Three] --> D[Four]",
    "```",
  ].join("\n");

  const output = replaceMermaidSourceInContent(content, { lineStart: 7, lineEnd: 12, source: "flowchart LR\n  C[Three] --> D[Four]" }, "flowchart TD\n  C[Changed] --> D[Done]\n");
  const fences = findMermaidFences(output);

  assert.equal(fences.length, 2);
  assert.equal(fences[0]?.source, "flowchart LR\n  A[One] --> B[Two]");
  assert.equal(fences[1]?.source, "flowchart TD\n  C[Changed] --> D[Done]");
});
