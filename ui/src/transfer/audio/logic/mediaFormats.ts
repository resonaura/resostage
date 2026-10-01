/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

/** File pickers and arrangement drops share the supported media entry points. */
const extensions = [
  "wav", "wave", "aif", "aiff", "aifc", "flac", "mp3", "ogg", "oga", "opus",
  "m4a", "aac", "wma", "caf", "mp4", "mov", "mkv", "avi", "webm", "m4v",
  "mpeg", "mpg", "mts", "m2ts", "ts", "flv", "wmv", "3gp", "mxf", "ogv",
  "vob", "asf", "dv",
] as const;

const mediaExtension = new RegExp(`\\.(${extensions.join("|")})$`, "i");
export const MEDIA_FILE_ACCEPT = ["audio/*", "video/*", ...extensions.map((value) => `.${value}`)].join(",");
export const MAXIMUM_MEDIA_FILE_BYTES = 20 * 1024 * 1024 * 1024;

export function isImportableMediaName(name: string): boolean {
  return mediaExtension.test(name);
}

export function isImportableMediaFile(file: Pick<File, "name" | "type">): boolean {
  // Finder and several browsers report either no MIME or application/octet-stream.
  return file.type.startsWith("audio/") || file.type.startsWith("video/") || isImportableMediaName(file.name);
}
