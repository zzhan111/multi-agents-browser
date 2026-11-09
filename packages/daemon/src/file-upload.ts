/**
 * File upload helpers — path normalization and validation for the `upload`
 * command (CDP DOM.setFileInputFiles). Pure functions; no CDP access here.
 */

import { statSync } from "node:fs";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown",
  html: "text/html", htm: "text/html", json: "application/json", xml: "application/xml",
  zip: "application/zip", gz: "application/gzip", "7z": "application/x-7z-compressed",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", heic: "image/heic", avif: "image/avif",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
};

/** Path flavor for the machine the daemon (and Chrome) runs on. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Resolve a user-supplied path to an absolute one. Relative paths resolve
 * against `cwd` (the CLI's working directory). Windows paths such as
 * `C:/Users/me/a.pdf` are normalized to `C:\Users\me\a.pdf` on win32.
 */
export function resolveUploadPath(file: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).resolve(cwd, file);
}

export function isAbsoluteUploadPath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathFor(platform).isAbsolute(file);
}

/**
 * Whether `fileName` satisfies an `<input accept>` attribute. Returns true for
 * an empty accept, or when a MIME token can't be decided from the extension
 * (the browser treats accept as a hint; we only reject clear mismatches).
 */
export function acceptMatches(accept: string | null | undefined, fileName: string): boolean {
  const tokens = (accept ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  const base = fileName.split(/[\\/]/).pop()!.toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const mime = MIME_BY_EXT[ext];
  let undecidable = false;
  for (const token of tokens) {
    if (token.startsWith(".")) {
      if (base.endsWith(token)) return true;
    } else if (!mime) {
      undecidable = true;
    } else if (token.endsWith("/*")) {
      if (mime.startsWith(token.slice(0, -1))) return true;
    } else if (token === mime) {
      return true;
    }
  }
  return undecidable;
}

export interface FileInputInfo {
  multiple: boolean;
  accept: string;
  disabled: boolean;
}

/**
 * Validate files for a file input; returns absolute paths or throws a
 * readable error. `force` skips the accept check (not existence checks).
 */
export function validateUploadFiles(
  files: string[] | undefined,
  input: FileInputInfo,
  options: { force?: boolean; platform?: NodeJS.Platform; stat?: (p: string) => { isFile(): boolean } } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const stat = options.stat ?? ((p: string) => statSync(p));
  if (!files || files.length === 0) throw new Error("Missing files parameter: pass at least one local file path");
  if (input.disabled) throw new Error("File input is disabled");
  if (files.length > 1 && !input.multiple) {
    throw new Error(`File input does not accept multiple files (got ${files.length}); add the multiple attribute or upload one file`);
  }
  return files.map((file) => {
    if (!isAbsoluteUploadPath(file, platform)) {
      throw new Error(`File path must be absolute: ${file}`);
    }
    let isFile = false;
    try {
      isFile = stat(file).isFile();
    } catch {
      throw new Error(`File not found: ${file}`);
    }
    if (!isFile) throw new Error(`Not a regular file: ${file}`);
    if (!options.force && !acceptMatches(input.accept, file)) {
      throw new Error(`File ${file} does not match the input's accept="${input.accept}" (use --force to upload anyway)`);
    }
    return pathFor(platform).normalize(file);
  });
}
