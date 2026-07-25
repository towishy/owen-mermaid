import assert from "node:assert/strict";
import test from "node:test";
import { layoutNodeLabel } from "../src/textLayout";

test("renders Mermaid br tags as centered node label lines", () => {
  const layout = layoutNodeLabel(
    "Microsoft Graph beta/v1.0<br/>/networkAccess, /identity/conditionalAccess,<br/>/auditLogs, /identityProtection, /security",
    404,
    260,
    13,
  );

  assert.ok(layout.lines.length >= 3);
  assert.equal(layout.lines.some((line) => /<br/i.test(line)), false);
  assert.equal(layout.truncated, false);
});

test("keeps an extremely long node label inside a short box", () => {
  const layout = layoutNodeLabel("A very long label ".repeat(40), 152, 68, 13);

  assert.ok(layout.lines.length * layout.lineHeight <= 52);
  assert.equal(layout.truncated, true);
  assert.match(layout.lines.at(-1) ?? "", /\.\.\.$/);
});