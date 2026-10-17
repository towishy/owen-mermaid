import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import esbuild from "esbuild";

const sourcePath = fileURLToPath(new URL("../src/settings.ts", import.meta.url));
const { outputFiles } = await esbuild.build({
  stdin: {
    contents: readFileSync(sourcePath, "utf8") + "\nexport { createTranslator };",
    resolveDir: dirname(sourcePath),
    loader: "ts",
  },
  bundle: true,
  external: ["obsidian"],
  platform: "node",
  format: "cjs",
  write: false,
});

function createHost(modern) {
  let mutations = 0;
  const controls = new Map();
  class Element {
    constructor(parentElement) { this.parentElement = parentElement; }
    addClass() { mutations += 1; }
    empty() { mutations += 1; }
    createDiv() { mutations += 1; return new Element(this); }
    createSpan() { mutations += 1; return new Element(this); }
    createEl() { mutations += 1; return new Element(this); }
    insertBefore() { mutations += 1; }
    toggleClass() { mutations += 1; }
    setAttribute() { mutations += 1; }
  }
  const container = new Element();
  class Setting {
    constructor(parent) {
      this.settingEl = parent.createDiv();
      this.infoEl = this.settingEl.createDiv();
      this.nameEl = this.infoEl.createDiv();
      this.descEl = this.infoEl.createDiv();
    }
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addControl(configure) {
      const control = {
        inputEl: new Element(), sliderEl: new Element(),
        addOption() { return this; },
        setValue(value) { this.value = value; return this; },
        setDisabled(value) { this.disabled = value; return this; },
        setPlaceholder() { return this; },
        setLimits() { return this; },
        then(callback) { callback(this); return this; },
        onChange(callback) { this.change = callback; return this; },
      };
      configure(control);
      controls.set(this.name, control);
      return this;
    }
    addDropdown(configure) { return this.addControl(configure); }
    addToggle(configure) { return this.addControl(configure); }
    addSlider(configure) { return this.addControl(configure); }
    addText(configure) { return this.addControl(configure); }
  }
  class PluginSettingTab {
    containerEl = container;
    constructor() {
      if (modern) this.update = () => { this.settingItems = this.getSettingDefinitions(); };
    }
  }
  const module = { exports: {} };
  new Function("module", "exports", "require", outputFiles[0].text)(module, module.exports, (name) => {
    assert.equal(name, "obsidian");
    return { PluginSettingTab, Setting, requireApiVersion: () => modern, setIcon() {}, setTooltip() {} };
  });
  const plugin = {
    settings: { ...module.exports.DEFAULT_SETTINGS },
    locale: "en",
    saves: 0,
    async saveSettings() { this.saves += 1; },
    async setLanguage(language) {
      this.settings.language = language;
      this.locale = language === "ko" ? "ko" : "en";
      await this.saveSettings();
    },
  };
  return {
    tab: new module.exports.OwenMermaidSettingTab({}, plugin),
    plugin, container, Setting, controls,
    t: module.exports.createTranslator("en"),
    mutations: () => mutations,
  };
}

test("indexes all twelve Mermaid controls in four groups without changing the DOM", () => {
  const { tab, t, mutations } = createHost(true);
  const definitions = tab.getSettingDefinitions();
  assert.equal(definitions.length, 4);
  const names = definitions.flatMap((group) => group.items.slice(1).map((item) => item.name));
  assert.equal(names.length, 12);
  for (const key of [
    "settings.language.name", "settings.format.name", "settings.location.name", "settings.folder.name",
    "settings.report.name", "settings.filename.name", "settings.quality.name", "settings.scale.name",
    "settings.background.name", "settings.zoomStep.name", "settings.direction.name", "settings.renderFirst.name",
  ]) assert.equal(names.includes(t(key)), true, `Missing searchable setting: ${key}`);
  for (const item of definitions.flatMap((group) => group.items)) assert.ok(item.desc);
  assert.equal(mutations(), 0);
});

test("legacy locale and export settings save and rerender without a native update API", async () => {
  const { tab, plugin, controls, t } = createHost(false);
  assert.equal(tab.update, undefined);
  tab.display();
  await controls.get(t("settings.format.name")).change("jpg");
  assert.equal(plugin.settings.exportFormat, "jpg");
  assert.equal(controls.get(t("settings.quality.name")).disabled, false);
  await controls.get(t("settings.language.name")).change("ko");
  assert.equal(plugin.settings.language, "ko");
  assert.equal(plugin.locale, "ko");
  assert.equal(plugin.saves, 2);
});

test("native save-location changes refresh searchable definitions and enable the vault folder", async () => {
  const { tab, plugin, controls, container, Setting, t } = createHost(true);
  const render = (name) => {
    const definition = tab.getSettingDefinitions().flatMap((group) => group.items).find((item) => item.name === t(name));
    definition.render(new Setting(container.createDiv()).setName(definition.name));
  };
  render("settings.location.name");
  await controls.get(t("settings.location.name")).change("vault");
  assert.equal(plugin.settings.saveLocation, "vault");
  assert.equal(tab.settingItems.length, 4);
  render("settings.folder.name");
  assert.equal(controls.get(t("settings.folder.name")).disabled, false);
});
