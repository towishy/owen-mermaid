import { App, PluginSettingTab, Setting, requireApiVersion, setIcon, setTooltip } from "obsidian";
import { createTranslator, normalizeLocalePreference, type LocalePreference } from "./i18n";
import type OwenMermaidPlugin from "./main";
import { styleSettingsHeading, styleSettingsRow } from "./settings-design";
import { normalizeFilenameTemplateSetting, normalizeImageBackgroundSetting, normalizeOutputFolderSetting } from "./settingsValidation";
import type { ExportFormat } from "./types";

export type ImageSaveLocation = "ask" | "vault";
export type BatchReportMode = "never" | "failures" | "always";

export interface OwenMermaidSettings {
  language: LocalePreference;
  exportFormat: ExportFormat;
  saveLocation: ImageSaveLocation;
  outputFolder: string;
  batchReportMode: BatchReportMode;
  filenameTemplate: string;
  imageQuality: number;
  exportScale: number;
  imageBackground: string;
  zoomStep: number;
  defaultEditorDirection: "TD" | "LR";
  renderStoredLayoutsImmediately: boolean;
}

export const DEFAULT_SETTINGS: OwenMermaidSettings = {
  language: "auto",
  exportFormat: "png",
  saveLocation: "ask",
  outputFolder: "exports/images",
  batchReportMode: "failures",
  filenameTemplate: "{{name}}",
  imageQuality: 0.92,
  exportScale: 2,
  imageBackground: "#FFFFFF",
  zoomStep: 0.15,
  defaultEditorDirection: "LR",
  renderStoredLayoutsImmediately: true,
};

type SearchableSetting = {
  name: string;
  desc?: string;
  render: (setting: Setting) => void;
};

type SearchableGroup = {
  type: "group";
  items: SearchableSetting[];
  title: string;
  description: string;
  icon: string;
};

export class OwenMermaidSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OwenMermaidPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SearchableGroup[] {
    const t = createTranslator(this.plugin.locale);
    const groups: SearchableGroup[] = [];
    const defineGroup = (title: string, description: string, icon: string): SearchableGroup => {
      const group: SearchableGroup = { type: "group", title, description, icon, items: [] };
      group.items.push({
        name: title,
        desc: description,
        render: (setting) => {
          this.prepareNativeRow(setting);
          setting.setHeading();
          styleSettingsHeading(setting.settingEl, icon);
          setting.settingEl.addClass("owen-mermaid-settings-section");
          setting.infoEl.addClass("owen-mermaid-settings-section-copy");
          setting.nameEl.addClass("owen-mermaid-settings-section-title");
          setting.descEl.addClass("owen-mermaid-settings-section-description");
          const glyph = setting.settingEl.createSpan({ cls: "owen-mermaid-section-glyph" });
          setIcon(glyph, icon);
          setting.settingEl.insertBefore(glyph, setting.infoEl);
        },
      });
      groups.push(group);
      return group;
    };
    const defineSetting = (group: SearchableGroup, name: string, description: string | undefined, configure: (setting: Setting) => Setting | void): void => {
      group.items.push({
        name,
        desc: description,
        render: (setting) => {
          this.prepareNativeRow(setting);
          configure(setting);
          styleSettingsRow(setting);
        },
      });
    };

    const interfaceSection = defineGroup(
      t("settings.interface.section"),
      t("settings.interface.sectionDesc"),
      "languages",
    );

    defineSetting(interfaceSection, t("settings.language.name"), t("settings.language.desc"), (setting) => setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("settings.language.auto"))
          .addOption("en", t("settings.language.en"))
          .addOption("ko", t("settings.language.ko"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            await this.plugin.setLanguage(normalizeLocalePreference(value));
            this.refresh();
          }),
      ));

    const exportSection = defineGroup(
      t("settings.export.section"),
      t("settings.export.sectionDesc"),
      "image-down",
    );

    defineSetting(exportSection, t("settings.format.name"), t("settings.format.desc"), (setting) => setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("png", "PNG")
          .addOption("jpg", "JPG")
          .setValue(this.plugin.settings.exportFormat)
          .onChange(async (value) => {
            this.plugin.settings.exportFormat = value as ExportFormat;
            await this.plugin.saveSettings();
            this.refresh();
          }),
      ));

    defineSetting(exportSection, t("settings.location.name"), t("settings.location.desc"), (setting) => setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", t("settings.location.ask"))
          .addOption("vault", t("settings.location.vault"))
          .setValue(this.plugin.settings.saveLocation)
          .onChange(async (value) => {
            this.plugin.settings.saveLocation = value as ImageSaveLocation;
            await this.plugin.saveSettings();
            this.refresh();
          }),
      ));

    defineSetting(exportSection, t("settings.folder.name"), t("settings.folder.desc"), (setting) => setting
      .addText((text) =>
        text
          .setDisabled(this.plugin.settings.saveLocation !== "vault")
          .setPlaceholder("exports/images")
          .setValue(this.plugin.settings.outputFolder)
          .then((component) => component.inputEl.addClass("owen-mermaid-settings-text-wide"))
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = normalizeOutputFolderSetting(value, DEFAULT_SETTINGS.outputFolder);
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(exportSection, t("settings.report.name"), t("settings.report.desc"), (setting) => setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("never", t("settings.report.never"))
          .addOption("failures", t("settings.report.failures"))
          .addOption("always", t("settings.report.always"))
          .setValue(this.plugin.settings.batchReportMode)
          .onChange(async (value) => {
            this.plugin.settings.batchReportMode = value as BatchReportMode;
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(exportSection, t("settings.filename.name"), t("settings.filename.desc"), (setting) => setting
      .addText((text) =>
        text
          .setPlaceholder("{{name}}")
          .setValue(this.plugin.settings.filenameTemplate)
          .then((component) => component.inputEl.addClass("owen-mermaid-settings-text-wide"))
          .onChange(async (value) => {
            this.plugin.settings.filenameTemplate = normalizeFilenameTemplateSetting(value, DEFAULT_SETTINGS.filenameTemplate);
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(exportSection, t("settings.quality.name"), t("settings.quality.desc"), (setting) => setting
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.imageQuality)
          .setDisabled(this.plugin.settings.exportFormat !== "jpg")
          .then((component) => setTooltip(component.sliderEl, String(this.plugin.settings.imageQuality)))
          .onChange(async (value) => {
            setTooltip(slider.sliderEl, String(value));
            this.plugin.settings.imageQuality = value;
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(exportSection, t("settings.scale.name"), t("settings.scale.desc"), (setting) => setting
      .addSlider((slider) =>
        slider
          .setLimits(1, 4, 1)
          .setValue(this.plugin.settings.exportScale)
          .then((component) => setTooltip(component.sliderEl, String(this.plugin.settings.exportScale)))
          .onChange(async (value) => {
            setTooltip(slider.sliderEl, String(value));
            this.plugin.settings.exportScale = value;
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(exportSection, t("settings.background.name"), t("settings.background.desc"), (setting) => setting
      .addText((text) =>
        text
          .setPlaceholder("#FFFFFF")
          .setValue(this.plugin.settings.imageBackground)
          .onChange(async (value) => {
            const normalized = normalizeImageBackgroundSetting(value, DEFAULT_SETTINGS.imageBackground);
            const invalid = Boolean(value.trim()) && normalized !== value.trim();
            text.inputEl.toggleClass("is-invalid", invalid);
            text.inputEl.setAttribute("aria-invalid", invalid ? "true" : "false");
            if (invalid) return;
            this.plugin.settings.imageBackground = normalized;
            await this.plugin.saveSettings();
          }),
      ));

    const zoomSection = defineGroup(
      t("settings.zoom.section"),
      t("settings.zoom.sectionDesc"),
      "zoom-in",
    );

    defineSetting(zoomSection, t("settings.zoomStep.name"), t("settings.zoomStep.desc"), (setting) => setting
      .addSlider((slider) =>
        slider
          .setLimits(0.05, 0.4, 0.05)
          .setValue(this.plugin.settings.zoomStep)
          .then((component) => setTooltip(component.sliderEl, String(this.plugin.settings.zoomStep)))
          .onChange(async (value) => {
            setTooltip(slider.sliderEl, String(value));
            this.plugin.settings.zoomStep = value;
            await this.plugin.saveSettings();
          }),
      ));

    const editorSection = defineGroup(
      t("settings.editor.section"),
      t("settings.editor.sectionDesc"),
      "workflow",
    );

    defineSetting(editorSection, t("settings.direction.name"), t("settings.direction.desc"), (setting) => setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("LR", t("settings.direction.lr"))
          .addOption("TD", t("settings.direction.td"))
          .setValue(this.plugin.settings.defaultEditorDirection)
          .onChange(async (value) => {
            this.plugin.settings.defaultEditorDirection = value as "TD" | "LR";
            await this.plugin.saveSettings();
          }),
      ));

    defineSetting(editorSection, t("settings.renderFirst.name"), t("settings.renderFirst.desc"), (setting) => setting
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.renderStoredLayoutsImmediately)
          .onChange(async (value) => {
            this.plugin.settings.renderStoredLayoutsImmediately = value;
            await this.plugin.saveSettings();
          }),
      ));
    return groups;
  }

  display(): void {
    this.displayLegacy();
  }

  private refresh(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else this.displayLegacy();
  }

  private displayLegacy(): void {
    this.containerEl.empty();
    this.containerEl.addClass("owen-mermaid-settings", "owen-settings-design");
    for (const group of this.getSettingDefinitions()) {
      const section = this.addSection(this.containerEl, group.title, group.description, group.icon);
      for (const item of group.items.slice(1)) {
        const setting = new Setting(section).setName(item.name);
        if (item.desc) setting.setDesc(item.desc);
        item.render(setting);
      }
    }
  }

  private prepareNativeRow(setting: Setting): void {
    if (!requireApiVersion("1.13.0")) return;
    this.containerEl.addClass("owen-mermaid-settings", "owen-mermaid-settings-native", "owen-settings-design");
    setting.settingEl.parentElement?.addClass("owen-mermaid-settings-group");
  }

  private addSection(containerEl: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const group = containerEl.createEl("section", { cls: "owen-mermaid-settings-group", attr: { "aria-label": title } });
    const header = group.createDiv({ cls: "owen-mermaid-settings-section" });
    styleSettingsHeading(header, icon);
    const glyph = header.createSpan({ cls: "owen-mermaid-section-glyph" });
    setIcon(glyph, icon);
    const copy = header.createDiv({ cls: "owen-mermaid-settings-section-copy" });
    copy.createDiv({ cls: "owen-mermaid-settings-section-title", text: title });
    copy.createDiv({ cls: "owen-mermaid-settings-section-description", text: description });
    return group;
  }
}
