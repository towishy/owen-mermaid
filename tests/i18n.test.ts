import assert from "node:assert/strict";
import test from "node:test";
import { catalogs, createTranslator, normalizeLocale, normalizeLocalePreference, resolveLocale, translate, type Locale } from "../src/i18n";

test("locale catalogs have exact key parity", () => {
  assert.deepEqual(Object.keys(catalogs.ko).sort(), Object.keys(catalogs.en).sort());
});

test("unknown persisted locale falls back to English", () => {
  assert.equal(normalizeLocale("fr"), "en");
  assert.equal(normalizeLocale(undefined), "en");
  assert.equal(normalizeLocale("ko"), "ko");
});

test("translator interpolates values and preserves missing placeholders", () => {
  assert.equal(translate("en", "notice.saved", { path: "exports/a.png" }), "Mermaid diagram saved: exports/a.png");
  assert.equal(translate("ko", "notice.batchSucceeded", { count: 2, report: "" }), "Mermaid 다이어그램 2개를 내보냈습니다.");
  assert.equal(translate("en", "notice.saved"), "Mermaid diagram saved: {path}");
});

test("translator resolves every catalog entry for both locales", () => {
  for (const locale of ["en", "ko"] satisfies Locale[]) {
    const t = createTranslator(locale);
    for (const key of Object.keys(catalogs.en) as Array<keyof typeof catalogs.en>) {
      assert.equal(t(key), catalogs[locale][key]);
    }
  }
});

test("automatic locale follows Korean Obsidian and explicit overrides win", () => {
  assert.equal(normalizeLocalePreference(undefined), "auto");
  assert.equal(resolveLocale("auto", "ko"), "ko");
  assert.equal(resolveLocale("auto", "ko-KR"), "ko");
  assert.equal(resolveLocale("auto", "fr"), "en");
  assert.equal(resolveLocale("en", "ko"), "en");
  assert.equal(resolveLocale("ko", "en"), "ko");
});