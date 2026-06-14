import assert from "node:assert/strict";
import test from "node:test";
import { isValidImageBackground, normalizeFilenameTemplateSetting, normalizeImageBackgroundSetting, normalizeOutputFolderSetting } from "../src/settingsValidation";

test("normalizes setting text values", () => {
  assert.equal(normalizeOutputFolderSetting("/exports\\images/../safe//"), "exports/images/safe");
  assert.equal(normalizeOutputFolderSetting("   ", "fallback"), "fallback");
  assert.equal(normalizeFilenameTemplateSetting("  {{note}} - {{index}}  "), "{{note}} - {{index}}");
  assert.equal(normalizeFilenameTemplateSetting("   ", "{{name}}"), "{{name}}");
});

test("validates image background colors", () => {
  assert.equal(isValidImageBackground("#fff"), true);
  assert.equal(isValidImageBackground("#FFFFFF"), true);
  assert.equal(isValidImageBackground("rgba(255, 255, 255, 0.92)"), true);
  assert.equal(isValidImageBackground("transparent"), true);
  assert.equal(isValidImageBackground("url(javascript:alert(1))"), false);
  assert.equal(isValidImageBackground("#12"), false);
  assert.equal(isValidImageBackground("not-a-color"), false);
  assert.equal(normalizeImageBackgroundSetting("not-a-color", "#FFFFFF"), "#FFFFFF");
});
