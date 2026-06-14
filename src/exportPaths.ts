const DEFAULT_OUTPUT_FOLDER = "exports/images";

export interface ExportFilenameContext {
  sourceName: string;
  sourcePath?: string;
  lineStart?: number;
  heading?: string;
  index?: number;
}

interface VaultPathApp {
  vault: {
    adapter: {
      exists(path: string): Promise<boolean>;
    };
  };
}

export function getVaultExportFolder(settings: { outputFolder: string }): string {
  return normalizeVaultFolderPath(settings.outputFolder) || DEFAULT_OUTPUT_FOLDER;
}

export async function getAvailableVaultPath(app: VaultPathApp, folder: string, baseName: string, extension: string): Promise<{ path: string; fileName: string }> {
  const normalizedFolder = normalizeVaultFolderPath(folder);
  const safeBaseName = sanitizeFilename(baseName).replace(/\s+/g, " ").trim() || "mermaid-diagram";
  let counter = 1;

  while (true) {
    const suffix = counter === 1 ? "" : `-${counter}`;
    const fileName = `${safeBaseName}${suffix}.${extension}`;
    const path = normalizedFolder ? `${normalizedFolder}/${fileName}` : fileName;
    if (!(await app.vault.adapter.exists(path))) return { path, fileName };
    counter += 1;
  }
}

export function normalizeVaultFolderPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

export function formatFilename(template: string, source: ExportFilenameContext | string, format: string, scale: number): string {
  const context = normalizeFilenameContext(source);
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const sourcePath = context.sourcePath ?? context.sourceName;
  const rawName = sourcePath.split("/").pop() ?? context.sourceName;
  const note = rawName.replace(/\.md$/i, "") || context.sourceName;
  const folder = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "";
  const index = String(context.index ?? (context.lineStart === undefined ? 1 : context.lineStart + 1));
  const base = template
    .replace(/\{\{name\}\}/g, context.sourceName || note || "mermaid-diagram")
    .replace(/\{\{rawName\}\}/g, rawName || context.sourceName || "mermaid-diagram")
    .replace(/\{\{note\}\}/g, note || context.sourceName || "mermaid-diagram")
    .replace(/\{\{folder\}\}/g, folder)
    .replace(/\{\{heading\}\}/g, context.heading ?? "")
    .replace(/\{\{index\}\}/g, index)
    .replace(/\{\{format\}\}/g, format)
    .replace(/\{\{scale\}\}/g, String(scale))
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time);
  const safeName = sanitizeFilename(base).replace(/\s+/g, " ").trim();
  return hasMeaningfulFilenameStem(safeName) ? safeName : `mermaid-diagram-${Date.now()}`;
}

export function sanitizeFilename(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || /[<>:"/\\|?*]/.test(character) ? "-" : character;
  }).join("");
}

function normalizeFilenameContext(source: ExportFilenameContext | string): ExportFilenameContext {
  if (typeof source === "string") return { sourceName: source || "mermaid-diagram" };
  return { ...source, sourceName: source.sourceName || "mermaid-diagram" };
}

function hasMeaningfulFilenameStem(value: string): boolean {
  return value.replace(/[\s._-]/g, "").length > 0;
}
