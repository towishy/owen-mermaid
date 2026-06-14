import { App, PluginSettingTab, Setting } from "obsidian";
import type OwenMermaidPlugin from "./main";
import type { ExportFormat } from "./types";

export type ImageSaveLocation = "ask" | "vault";
export type BatchReportMode = "never" | "failures" | "always";

export interface OwenMermaidSettings {
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
    containerEl.empty();
    containerEl.addClass("owen-mermaid-settings");

    this.addSectionHeader(
      containerEl,
      "SVG image export",
      "Configure rasterized SVG downloads, vault saves, filenames, and batch reports.",
    );

    new Setting(containerEl)
      .setName("Default image format")
      .setDesc("Format used by the primary SVG download menu item.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("png", "PNG")
          .addOption("jpg", "JPG")
          .setValue(this.plugin.settings.exportFormat)
          .onChange(async (value) => {
            this.plugin.settings.exportFormat = value as ExportFormat;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image save location")
      .setDesc("Ask for a save location or save directly into a vault folder.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask every time")
          .addOption("vault", "Vault folder")
          .setValue(this.plugin.settings.saveLocation)
          .onChange(async (value) => {
            this.plugin.settings.saveLocation = value as ImageSaveLocation;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image output folder")
      .setDesc("Vault-relative folder for direct SVG image exports and batch exports.")
      .addText((text) =>
        text
          .setPlaceholder("exports/images")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("SVG batch report")
      .setDesc("Write a Markdown report for batch SVG exports.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("never", "Never")
          .addOption("failures", "Only when something fails")
          .addOption("always", "Always")
          .setValue(this.plugin.settings.batchReportMode)
          .onChange(async (value) => {
            this.plugin.settings.batchReportMode = value as BatchReportMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image filename template")
      .setDesc("Supports {{name}}, {{rawName}}, {{note}}, {{folder}}, {{heading}}, {{index}}, {{format}}, {{scale}}, {{date}}, and {{time}}.")
      .addText((text) =>
        text
          .setPlaceholder("{{name}}")
          .setValue(this.plugin.settings.filenameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.filenameTemplate = value.trim() || DEFAULT_SETTINGS.filenameTemplate;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image quality")
      .setDesc("JPEG quality from 0.1 to 1.0. PNG ignores this setting.")
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.imageQuality)
          .onChange(async (value) => {
            this.plugin.settings.imageQuality = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image scale")
      .setDesc("Rasterization multiplier. Use 2 or 3 for high-resolution exports.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 4, 1)
          .setValue(this.plugin.settings.exportScale)
          .onChange(async (value) => {
            this.plugin.settings.exportScale = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Image background")
      .setDesc("Canvas background used for JPG and transparent Mermaid SVGs. Use a CSS color such as #FFFFFF.")
      .addText((text) =>
        text
          .setPlaceholder("#FFFFFF")
          .setValue(this.plugin.settings.imageBackground)
          .onChange(async (value) => {
            this.plugin.settings.imageBackground = value.trim() || DEFAULT_SETTINGS.imageBackground;
            await this.plugin.saveSettings();
          }),
      );

    this.addSectionHeader(
      containerEl,
      "Mermaid zoom viewer",
      "Configure inline controls and the full-screen pan and zoom experience.",
    );

    new Setting(containerEl)
      .setName("Zoom step")
      .setDesc("How much the inline and full-screen zoom buttons change the scale.")
      .addSlider((slider) =>
        slider
          .setLimits(0.05, 0.4, 0.05)
          .setValue(this.plugin.settings.zoomStep)
          .onChange(async (value) => {
            this.plugin.settings.zoomStep = value;
            await this.plugin.saveSettings();
          }),
      );

    this.addSectionHeader(
      containerEl,
      "Visual Mermaid editor",
      "Configure the drag-and-drop editor used from the Mermaid SVG context menu.",
    );

    new Setting(containerEl)
      .setName("New diagram direction")
      .setDesc("Direction used when the visual editor creates a diagram from an empty or unsupported block.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("LR", "Left to right")
          .addOption("TD", "Top to bottom")
          .setValue(this.plugin.settings.defaultEditorDirection)
          .onChange(async (value) => {
            this.plugin.settings.defaultEditorDirection = value as "TD" | "LR";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Render saved layouts first")
      .setDesc("Use Owen Mermaid's visual renderer immediately when a Mermaid block has saved Owen layout metadata.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.renderStoredLayoutsImmediately)
          .onChange(async (value) => {
            this.plugin.settings.renderStoredLayoutsImmediately = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  private addSectionHeader(containerEl: HTMLElement, title: string, description: string): void {
    const section = containerEl.createDiv({ cls: "owen-mermaid-settings-section" });
    section.createSpan({ cls: "owen-mermaid-section-glyph" });
    const copy = section.createDiv({ cls: "owen-mermaid-settings-section-copy" });
    copy.createDiv({ cls: "owen-mermaid-settings-section-title", text: title });
    copy.createDiv({ cls: "owen-mermaid-settings-section-description", text: description });
  }
}
