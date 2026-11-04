import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "../types";
import { driveFileId, ensureCached, isDriveId } from "./gdrive";

export interface TextResult {
  text: string;
  encoding: string;
  bytes: number;
  chars: number;
}

const decoder = new TextDecoder("utf-8");

/** Google Drive files are downloaded into the local cache before Rust reads them. */
async function prepare(id: string) {
  if (isDriveId(id)) await ensureCached(driveFileId(id));
}

/** Reads a document as plain text. Handles txt/html/docx/hwpx/rtf and archive members. */
export async function readText(id: string, encoding?: string, ext?: string): Promise<TextResult> {
  await prepare(id);
  const buf = await invoke<ArrayBuffer>("read_text", { id, ext: ext ?? null, encoding: encoding && encoding !== "auto" ? encoding : null });
  const bytes = new Uint8Array(buf);
  const nl = bytes.indexOf(10);
  const meta = JSON.parse(decoder.decode(bytes.subarray(0, nl)));
  const text = decoder.decode(bytes.subarray(nl + 1));
  return { text, ...meta };
}

export async function readBinary(id: string): Promise<Uint8Array> {
  await prepare(id);
  const buf = await invoke<ArrayBuffer>("read_binary", { id });
  return new Uint8Array(buf);
}

export function scanLibrary(roots: string[]): Promise<Entry[]> {
  return invoke<Entry[]>("scan_library", { roots });
}

export function watchRoots(roots: string[]): Promise<void> {
  return invoke("watch_roots", { roots });
}

/** Android: system folder picker; returns the persisted folder URI id and its display name. */
export function pickRootDir(): Promise<{ id: string; name: string } | null> {
  return invoke("pick_root_dir");
}

/** Saves text: desktop writes `path` (from the save dialog); Android opens the system "save as" picker. */
export function saveTextAs(path: string | null, fileName: string, contents: string): Promise<boolean> {
  return invoke("save_text_as", { path, fileName, contents });
}

export function listEncodings(): Promise<[string, string][]> {
  return invoke<[string, string][]>("list_encodings");
}
