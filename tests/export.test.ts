import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import { formatFilename, getAvailableVaultPath, getVaultExportFolder, normalizeVaultFolderPath, sanitizeFilename } from "../src/exportPaths";

function createMockApp(existingPaths: string[] = []): App {
  const existing = new Set(existingPaths);
  return {
    vault: {
      adapter: {
        exists: async (path: string) => existing.has(path),
      },
    },
  } as unknown as App;
}

test("normalizes vault output folders", () => {
  assert.equal(normalizeVaultFolderPath("/exports\\images/../safe//"), "exports/images/safe");
  assert.equal(getVaultExportFolder({ outputFolder: "" }), "exports/images");
});

test("sanitizes generated filenames", () => {
  assert.equal(sanitizeFilename('bad:name/with*chars?'), "bad-name-with-chars-");
  assert.equal(
    formatFilename("{{note}}-{{index}}-{{format}}-{{scale}}", { sourceName: "Note", sourcePath: "Folder/Note.md", lineStart: 4 }, "png", 2),
    "Note-5-png-2",
  );
  assert.equal(
    formatFilename("{{folder}}-{{heading}}-{{rawName}}", { sourceName: "Diagram", sourcePath: "Area/Note.md", heading: "A/B: C" }, "jpg", 3),
    "Area-A-B- C-Note.md",
  );
  assert.match(formatFilename("<>:\"/\\|?*", "", "png", 2), /^mermaid-diagram-\d+$/);
});

test("finds an available vault path with numeric suffixes", async () => {
  const app = createMockApp(["exports/images/diagram.png", "exports/images/diagram-2.png"]);
  const target = await getAvailableVaultPath(app, "exports/images", "diagram", "png");

  assert.deepEqual(target, { path: "exports/images/diagram-3.png", fileName: "diagram-3.png" });
});
