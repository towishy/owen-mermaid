import * as fs from "fs";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { ExportFilenameContext } from "./exportPaths";
import { formatFilename, getAvailableVaultPath, getVaultExportFolder, normalizeVaultFolderPath } from "./exportPaths";
import { createTranslator, type Translator } from "./i18n";
import type { OwenMermaidSettings } from "./settings";
import { svgToImageBlob } from "./svgExport";
import type { ExportFormat } from "./types";

export { formatFilename, getAvailableVaultPath, getVaultExportFolder, normalizeVaultFolderPath, sanitizeFilename } from "./exportPaths";
export type { ExportFilenameContext } from "./exportPaths";
export { svgToImageBlob } from "./svgExport";

interface ElectronRemoteDialog {
  showSaveDialog(options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
    properties: string[];
  }): Promise<{ canceled: boolean; filePath?: string }>;
}

interface ElectronWindow extends Window {
  electron?: {
    remote?: {
      dialog?: ElectronRemoteDialog;
    };
  };
}

export interface VaultExportResult {
  path: string;
  fileName: string;
  folder: string;
  format: ExportFormat;
  bytes: number;
}

export async function downloadSvgImage(
  svg: SVGSVGElement,
  format: ExportFormat,
  settings: OwenMermaidSettings,
  source: ExportFilenameContext | string,
  app: App,
  t: Translator = createTranslator("en"),
): Promise<void> {
  try {
    if (settings.saveLocation === "vault") {
      const result = await exportSvgImageToVault(svg, format, settings, source, app);
      new Notice(t("notice.saved", { path: result.path }));
    } else {
      const blob = await svgToImageBlob(svg, format, settings.exportScale, settings.imageBackground, settings.imageQuality);
      const path = await saveBlobWithDialog(blob, format, settings, source, svg.ownerDocument.defaultView ?? window, t);
      if (path) new Notice(t("notice.saved", { path }));
    }
  } catch (error) {
    new Notice(t("notice.downloadFailed", { error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function exportSvgImageToVault(
  svg: SVGSVGElement,
  format: ExportFormat,
  settings: OwenMermaidSettings,
  source: ExportFilenameContext | string,
  app: App,
): Promise<VaultExportResult> {
  const blob = await svgToImageBlob(svg, format, settings.exportScale, settings.imageBackground, settings.imageQuality);
  return saveBlobToVault(blob, format, settings, source, app);
}

async function saveBlobWithDialog(blob: Blob, format: ExportFormat, settings: OwenMermaidSettings, source: ExportFilenameContext | string, win: Window, t: Translator): Promise<string | null> {
  const electron = (win as ElectronWindow).electron;
  if (!electron?.remote?.dialog) {
    new Notice(t("notice.desktopRequired"));
    return null;
  }

  const extension = format === "jpg" ? "jpg" : "png";
  const result = await electron.remote.dialog.showSaveDialog({
    defaultPath: `${formatFilename(settings.filenameTemplate, source, extension, settings.exportScale)}.${extension}`,
    filters: [{ name: format === "jpg" ? t("export.jpgImages") : t("export.pngImages"), extensions: [extension] }],
    properties: ["showOverwriteConfirmation"],
  });

  if (result.canceled || !result.filePath) return null;
  const buffer = Buffer.from(await blob.arrayBuffer());
  await fs.promises.writeFile(result.filePath, buffer);
  return result.filePath;
}

async function saveBlobToVault(blob: Blob, format: ExportFormat, settings: OwenMermaidSettings, source: ExportFilenameContext | string, app: App): Promise<VaultExportResult> {
  const extension = format === "jpg" ? "jpg" : "png";
  const folder = getVaultExportFolder(settings);
  const baseName = formatFilename(settings.filenameTemplate, source, extension, settings.exportScale);
  await ensureVaultFolder(app, folder);
  const buffer = await blob.arrayBuffer();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = await getAvailableVaultPath(app, folder, baseName, extension);
    try {
      await app.vault.adapter.writeBinary(target.path, buffer);
      return { ...target, folder, format, bytes: blob.size };
    } catch (error) {
      if (attempt === 4) throw error;
      await ensureVaultFolder(app, folder);
    }
  }

  throw new Error("Vault export failed after retries");
}

export async function ensureVaultFolder(app: App, folder: string): Promise<void> {
  const normalized = normalizeVaultFolderPath(folder);
  if (!normalized) return;

  let current = "";
  for (const segment of normalized.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    if (await app.vault.adapter.exists(current)) continue;
    try {
      await app.vault.adapter.mkdir(current);
    } catch (error) {
      if (!(await app.vault.adapter.exists(current))) throw error;
    }
  }
}

export async function writeTextToAvailableVaultPath(app: App, folder: string, baseName: string, extension: string, content: string): Promise<{ path: string; fileName: string }> {
  await ensureVaultFolder(app, folder);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = await getAvailableVaultPath(app, folder, baseName, extension);
    try {
      await app.vault.adapter.write(target.path, content);
      return target;
    } catch (error) {
      if (attempt === 4) throw error;
      await ensureVaultFolder(app, folder);
    }
  }

  throw new Error("Vault text write failed after retries");
}

