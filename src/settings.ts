import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import { createTranslator, normalizeLocalePreference, type LocalePreference } from "./i18n";
import type OwenMermaidPlugin from "./main";
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

export class OwenMermaidSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OwenMermaidPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const t = createTranslator(this.plugin.locale);
    containerEl.empty();
    containerEl.addClass("owen-mermaid-settings");

    const interfaceSection = this.addSection(
      containerEl,
      t("settings.interface.section"),
      t("settings.interface.sectionDesc"),
      "languages",
    );

    new Setting(interfaceSection)
      .setName(t("settings.language.name"))
      .setDesc(t("settings.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("settings.language.auto"))
          .addOption("en", t("settings.language.en"))
          .addOption("ko", t("settings.language.ko"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            await this.plugin.setLanguage(normalizeLocalePreference(value));
            this.display();
          }),
      );

    const exportSection = this.addSection(
      containerEl,
      t("settings.export.section"),
      t("settings.export.sectionDesc"),
      "image-down",
    );

    new Setting(exportSection)
      .setName(t("settings.format.name"))
      .setDesc(t("settings.format.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("png", "PNG")
          .addOption("jpg", "JPG")
          .setValue(this.plugin.settings.exportFormat)
          .onChange(async (value) => {
            this.plugin.settings.exportFormat = value as ExportFormat;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(exportSection)
      .setName(t("settings.location.name"))
      .setDesc(t("settings.location.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", t("settings.location.ask"))
          .addOption("vault", t("settings.location.vault"))
          .setValue(this.plugin.settings.saveLocation)
          .onChange(async (value) => {
            this.plugin.settings.saveLocation = value as ImageSaveLocation;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(exportSection)
      .setName(t("settings.folder.name"))
      .setDesc(t("settings.folder.desc"))
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
      );

    new Setting(exportSection)
      .setName(t("settings.report.name"))
      .setDesc(t("settings.report.desc"))
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
      );

    new Setting(exportSection)
      .setName(t("settings.filename.name"))
      .setDesc(t("settings.filename.desc"))
      .addText((text) =>
        text
          .setPlaceholder("{{name}}")
          .setValue(this.plugin.settings.filenameTemplate)
          .then((component) => component.inputEl.addClass("owen-mermaid-settings-text-wide"))
          .onChange(async (value) => {
            this.plugin.settings.filenameTemplate = normalizeFilenameTemplateSetting(value, DEFAULT_SETTINGS.filenameTemplate);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(exportSection)
      .setName(t("settings.quality.name"))
      .setDesc(t("settings.quality.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.imageQuality)
          .setDisabled(this.plugin.settings.exportFormat !== "jpg")
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.imageQuality = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(exportSection)
      .setName(t("settings.scale.name"))
      .setDesc(t("settings.scale.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 4, 1)
          .setValue(this.plugin.settings.exportScale)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.exportScale = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(exportSection)
      .setName(t("settings.background.name"))
      .setDesc(t("settings.background.desc"))
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
      );

    const zoomSection = this.addSection(
      containerEl,
      t("settings.zoom.section"),
      t("settings.zoom.sectionDesc"),
      "zoom-in",
    );

    new Setting(zoomSection)
      .setName(t("settings.zoomStep.name"))
      .setDesc(t("settings.zoomStep.desc"))
      .addSlider((slider) =>
        slider
          .setLimits(0.05, 0.4, 0.05)
          .setValue(this.plugin.settings.zoomStep)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.zoomStep = value;
            await this.plugin.saveSettings();
          }),
      );

    const editorSection = this.addSection(
      containerEl,
      t("settings.editor.section"),
      t("settings.editor.sectionDesc"),
      "workflow",
    );

    new Setting(editorSection)
      .setName(t("settings.direction.name"))
      .setDesc(t("settings.direction.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("LR", t("settings.direction.lr"))
          .addOption("TD", t("settings.direction.td"))
          .setValue(this.plugin.settings.defaultEditorDirection)
          .onChange(async (value) => {
            this.plugin.settings.defaultEditorDirection = value as "TD" | "LR";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(editorSection)
      .setName(t("settings.renderFirst.name"))
      .setDesc(t("settings.renderFirst.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.renderStoredLayoutsImmediately)
          .onChange(async (value) => {
            this.plugin.settings.renderStoredLayoutsImmediately = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private addSection(containerEl: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const group = containerEl.createEl("section", { cls: "owen-mermaid-settings-group", attr: { "aria-label": title } });
    const header = group.createDiv({ cls: "owen-mermaid-settings-section" });
    const glyph = header.createSpan({ cls: "owen-mermaid-section-glyph" });
    setIcon(glyph, icon);
    const copy = header.createDiv({ cls: "owen-mermaid-settings-section-copy" });
    copy.createDiv({ cls: "owen-mermaid-settings-section-title", text: title });
    copy.createDiv({ cls: "owen-mermaid-settings-section-description", text: description });
    return group;
  }
}
