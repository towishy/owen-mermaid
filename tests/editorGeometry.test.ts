import assert from "node:assert/strict";
import test from "node:test";
import { getDraggedScrollPosition } from "../src/editorGeometry";

test("scrolls down when a tall canvas background is dragged down", () => {
  const scroll = getDraggedScrollPosition(
    { left: 0, top: 0 },
    { x: 0, y: 180 },
    { left: 400, top: 1200 },
  );

  assert.deepEqual(scroll, { left: 0, top: 180 });
});

test("clamps background drag scrolling to the available canvas range", () => {
  assert.deepEqual(
    getDraggedScrollPosition(
      { left: 380, top: 1150 },
      { x: 100, y: 200 },
      { left: 400, top: 1200 },
    ),
    { left: 400, top: 1200 },
  );
  assert.deepEqual(
    getDraggedScrollPosition(
      { left: 20, top: 30 },
      { x: -100, y: -200 },
      { left: 400, top: 1200 },
    ),
    { left: 0, top: 0 },
  );
});