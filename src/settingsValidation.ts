import { normalizeVaultFolderPath } from "./exportPaths";

export const FALLBACK_OUTPUT_FOLDER = "exports/images";
export const FALLBACK_FILENAME_TEMPLATE = "{{name}}";
export const FALLBACK_IMAGE_BACKGROUND = "#FFFFFF";

const CSS_COLOR_KEYWORDS = new Set([
  "black",
  "blue",
  "currentcolor",
  "cyan",
  "gray",
  "green",
  "grey",
  "magenta",
  "orange",
  "purple",
  "red",
  "transparent",
  "white",
  "yellow",
]);

export function normalizeOutputFolderSetting(value: string, fallback = FALLBACK_OUTPUT_FOLDER): string {
  return normalizeVaultFolderPath(value.trim()) || fallback;
}

export function normalizeFilenameTemplateSetting(value: string, fallback = FALLBACK_FILENAME_TEMPLATE): string {
  return value.replace(/\s+/g, " ").trim() || fallback;
}

export function isValidImageBackground(value: string): boolean {
  const color = value.trim();
  if (!color || /[;{}]|url\s*\(/i.test(color)) return false;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return true;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-+]?\d+(?:\.\d+)?%?(?:\s*,\s*[-+]?\d+(?:\.\d+)?%?){2,3}\s*\)$/i.test(color)) return true;
  return CSS_COLOR_KEYWORDS.has(color.toLowerCase());
}

export function normalizeImageBackgroundSetting(value: string, fallback = FALLBACK_IMAGE_BACKGROUND): string {
  const color = value.trim();
  if (!color) return fallback;
  return isValidImageBackground(color) ? color : fallback;
}
