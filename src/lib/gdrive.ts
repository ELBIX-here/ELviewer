import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "../types";
import { kindForExt } from "./formats";
import { isAndroid } from "./platform";
import { loadValue, saveValue } from "./persist";

/**
 * Google Drive over its REST API (v3). The calls run here with `fetch` – the API
 * answers cross-origin requests – so desktop and Android share them. Access tokens
 * come from Rust on desktop (browser sign-in, refresh token in the app data folder)
 * and from Google Play services on Android (MainActivity's `window.ElAuth`).
 *
 * Library ids of Drive files are `gdrive:<fileId>` (archive members
 * `gdrive:<fileId>|<member>`); roots are `gdrive:<folderId>`. Files are downloaded
 * into a local cache (Rust side) before the normal readers open them.
 */

export const DRIVE_PREFIX = "gdrive:";
export const isDriveId = (id: string) => id.startsWith(DRIVE_PREFIX);
/** Drive file id behind a library id (also for archive members). */
export const driveFileId = (id: string) => id.slice(DRIVE_PREFIX.length).split("|")[0];

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
/** Archives up to this size are downloaded while scanning so their members can be listed. */
const ARCHIVE_SCAN_LIMIT = 64 * 1024 * 1024;

/** Tests point this at a local mock: localStorage["elviewer.gdriveApi"] = "http://127.0.0.1:…". */
function apiBase(): string {
  try {
    return localStorage.getItem("elviewer.gdriveApi") || "https://www.googleapis.com";
  } catch {
    return "https://www.googleapis.com";
  }
}
function mockToken(): string | null {
  try {
    return localStorage.getItem("elviewer.gdriveMockToken");
  } catch {
    return null;
  }
}

/** Signed out, or the grant was revoked: the user has to connect again. */
export class DriveAuthError extends Error {}

/** Fires "lost" when Google no longer accepts this sign-in (expired / revoked). */
export const authEvents = new EventTarget();
const EXPIRED = "Google 로그인이 만료되었습니다. 다시 로그인해 주세요.";
function authLost(message = EXPIRED): DriveAuthError {
  authEvents.dispatchEvent(new Event("lost"));
  return new DriveAuthError(message);
}
/** No network. */
export class DriveOfflineError extends Error {}

// ---- tokens ------------------------------------------------------------------

let token: { value: string; until: number } | null = null;

interface AuthBridge {
  /** `stale`: a token the API rejected, cleared from Play services' cache first ("" for none) */
  authorize(requestId: string, interactive: boolean, stale: string): void;
}

/** Android: ask Google Play services for an access token (interactive = may show the consent screen). */
/** Play services ApiException status codes → what to do about them. */
function androidAuthMessage(code: string | undefined): string {
  switch (code) {
    case "api_10":
      return "Google Cloud에 이 앱이 등록되지 않았습니다 (패키지 이름·서명 SHA-1 확인).";
    case "scope_missing":
      return "Google 로그인 화면에서 권한 두 개(Drive 파일 보기, 앱 데이터)를 모두 허용해야 합니다. 다시 연결하세요.";
    case "api_7":
      return "네트워크에 연결할 수 없습니다.";
    case "api_16":
    case "api_12501":
      return "로그인을 취소했습니다.";
    default:
      return `Google 로그인 실패: ${code ?? "알 수 없는 오류"}`;
  }
}

function androidAuthorize(interactive: boolean, stale = ""): Promise<string> {
  const bridge = (window as unknown as { ElAuth?: AuthBridge }).ElAuth;
  if (!bridge) return Promise.reject(new Error("Google Play 서비스를 사용할 수 없습니다."));
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; token?: string; error?: string }>).detail;
      if (d.id !== requestId) return;
      window.removeEventListener("elauth", on);
      if (d.token) resolve(d.token);
      else if (d.error === "consent_required") reject(authLost());
      else if (d.error === "cancelled") reject(new DriveAuthError("로그인을 취소했습니다."));
      else reject(new Error(androidAuthMessage(d.error)));
    };
    window.addEventListener("elauth", on);
    bridge.authorize(requestId, interactive, stale);
  });
}

function rustError(e: unknown): Error {
  const s = String(e);
  // The refresh token was revoked or expired (e.g. a 7-day test-mode grant): sign in again.
  if (s.startsWith("NOT_CONNECTED")) return authLost();
  if (s.startsWith("CANCELLED") || s.startsWith("SCOPE")) return new DriveAuthError(s.replace(/^\w+: /, ""));
  if (s.startsWith("OFFLINE")) return new DriveOfflineError(s.replace(/^\w+: /, ""));
  return new Error(s.replace(/^\w+: /, ""));
}

async function getToken(force = false): Promise<string> {
  const mock = mockToken();
  if (mock) return mock;
  if (!force && token && token.until > Date.now()) return token.value;
  if (isAndroid()) {
    // Play services caches the token and renews it when needed.
    const value = await androidAuthorize(false, force ? (token?.value ?? "") : "");
    token = { value, until: Date.now() + 45 * 60_000 };
    return value;
  }
  try {
    const t = await invoke<{ accessToken: string; expiresIn: number }>("gdrive_access_token", { force });
    token = { value: t.accessToken, until: Date.now() + Math.max(60, t.expiresIn - 60) * 1000 };
    return t.accessToken;
  } catch (e) {
    throw rustError(e);
  }
}

/** Whether this build can sign in at all (desktop builds need an OAuth client compiled in). */
export async function authAvailable(): Promise<boolean> {
  if (mockToken()) return true;
  return invoke<boolean>("gdrive_auth_available").catch(() => false);
}

/** Interactive sign-in. Resolves with the account's e-mail address. */
export async function connect(): Promise<string> {
  token = null;
  if (!mockToken()) {
    if (isAndroid()) {
      const value = await androidAuthorize(true);
      token = { value, until: Date.now() + 45 * 60_000 };
    } else {
      try {
        const t = await invoke<{ accessToken: string; expiresIn: number }>("gdrive_connect");
        token = { value: t.accessToken, until: Date.now() + Math.max(60, t.expiresIn - 60) * 1000 };
      } catch (e) {
        throw rustError(e);
      }
    }
  }
  return accountEmail();
}

export function cancelConnect() {
  if (!isAndroid()) void invoke("gdrive_cancel_connect");
}

export async function disconnect(): Promise<void> {
  const t = token?.value;
  token = null;
  syncFileId = null;
  if (isAndroid()) {
    // Revoke the grant so the next connect asks again (and another account can be chosen).
    if (t) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: "POST" }).catch(() => {});
  } else await invoke("gdrive_disconnect").catch(() => {});
}

// ---- REST --------------------------------------------------------------------

async function driveFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const t = await getToken(retried);
  let res: Response;
  try {
    res = await fetch(apiBase() + path, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` } });
  } catch {
    throw new DriveOfflineError("Google Drive에 연결할 수 없습니다. 인터넷 연결을 확인하세요.");
  }
  if (res.status === 401 && !retried) {
    if (token) token.until = 0;
    return driveFetch(path, init, true);
  }
  if (res.status === 401) throw authLost();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try {
      msg = JSON.parse(body).error?.message ?? body;
    } catch {
      /* not JSON */
    }
    throw new Error(`Google Drive 오류 (${res.status}): ${msg}`.slice(0, 300));
  }
  return res;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export async function accountEmail(): Promise<string> {
  const res = await driveFetch(`/drive/v3/about?${q({ fields: "user(emailAddress,displayName)" })}`);
  const j = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
  return j.user?.emailAddress ?? j.user?.displayName ?? "Google 계정";
}

export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  /** Drive modifiedTime (RFC 3339) – also the cache revision */
  rev: string;
  mtime: number;
  /** a shortcut to a file: id is the target; size and revision are looked up when scanning */
  shortcut?: boolean;
  /** Google Docs / Sheets / … – can't be read as a book */
  gdoc?: boolean;
}

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

function toItem(f: RawFile): DriveItem | null {
  // Shortcuts to folders (e.g. "add shortcut to Drive" for shared folders) act as folders.
  if (f.mimeType === SHORTCUT) {
    const t = f.shortcutDetails;
    if (!t) return null;
    const mtime = Date.parse(f.modifiedTime ?? "") || 0;
    if (t.targetMimeType === FOLDER) return { id: t.targetId, name: f.name, isFolder: true, size: 0, rev: f.modifiedTime ?? "", mtime };
    // Shortcut to a file ("add shortcut to Drive"): read the target.
    return { id: t.targetId, name: f.name, isFolder: false, size: 0, rev: "", mtime, shortcut: true, gdoc: t.targetMimeType.startsWith("application/vnd.google-apps.") };
  }
  if (f.mimeType.startsWith("application/vnd.google-apps.") && f.mimeType !== FOLDER)
    return { id: f.id, name: f.name, isFolder: false, size: 0, rev: "", mtime: 0, gdoc: true }; // Docs, Sheets…
  return { id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, size: Number(f.size ?? 0), rev: f.modifiedTime ?? "", mtime: Date.parse(f.modifiedTime ?? "") || 0 };
}

async function listQuery(query: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken = "";
  do {
    const params: Record<string, string> = {
      q: query,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails(targetId,targetMimeType))",
      pageSize: "1000",
      orderBy: "folder,name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await driveFetch(`/drive/v3/files?${q(params)}`);
    const j = (await res.json()) as { files?: RawFile[]; nextPageToken?: string };
    for (const f of j.files ?? []) {
      const it = toItem(f);
      if (it) out.push(it);
    }
    pageToken = j.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** Children of a folder. `parent` is a folder id, "root" (My Drive) or "shared" (shared with me). */
export function listFolder(parent: string, foldersOnly = false): Promise<DriveItem[]> {
  const kind = foldersOnly ? ` and (mimeType = '${FOLDER}' or mimeType = '${SHORTCUT}')` : "";
  const list = parent === "shared" ? listQuery(`sharedWithMe and trashed = false${kind}`) : listQuery(`'${esc(parent)}' in parents and trashed = false${kind}`);
  // The folder query also matches shortcuts to files – leave those out.
  return foldersOnly ? list.then((items) => items.filter((i) => i.isFolder)) : list;
}

// ---- download cache ------------------------------------------------------------

/** Known revisions from the last scan, so opening a file doesn't need a metadata request. */
const revs = new Map<string, string>();
const downloads = new Map<string, Promise<void>>();

async function fileRev(fileId: string): Promise<string> {
  const known = revs.get(fileId);
  if (known) return known;
  const res = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?${q({ fields: "modifiedTime", supportsAllDrives: "true" })}`);
  const rev = ((await res.json()) as { modifiedTime?: string }).modifiedTime ?? "";
  revs.set(fileId, rev);
  return rev;
}

/** Makes sure the current revision of a Drive file is in the local cache. */
export function ensureCached(fileId: string): Promise<void> {
  let p = downloads.get(fileId);
  if (!p) {
    p = (async () => {
      let rev: string;
      try {
        rev = await fileRev(fileId);
      } catch (e) {
        // Offline: fall back to whatever copy is cached (Rust reports if there is none).
        if (e instanceof DriveOfflineError || e instanceof DriveAuthError) return;
        throw e;
      }
      if (await invoke<boolean>("gdrive_cache_has", { fileId, rev })) return;
      const res = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?${q({ alt: "media", supportsAllDrives: "true" })}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await storeDownload(fileId, rev, bytes);
    })().finally(() => downloads.delete(fileId));
    downloads.set(fileId, p);
  }
  return p;
}

/** Desktop passes the bytes as a raw IPC body; Android's bridge only carries text, so base64 chunks. */
async function storeDownload(fileId: string, rev: string, bytes: Uint8Array): Promise<void> {
  if (!isAndroid()) {
    await invoke("gdrive_cache_put", bytes, { headers: { "x-file-id": fileId, "x-rev": rev } });
    return;
  }
  const CHUNK = 3 * 1024 * 1024; // multiple of 3: chunks encode to base64 without padding in between
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let index = 0; index < count; index++) {
    const part = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    await invoke("gdrive_cache_put_chunk", { fileId, rev, index, last: index === count - 1, data: toBase64(part) });
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function clearCache(): Promise<void> {
  return invoke("gdrive_cache_clear");
}

// ---- library scan ------------------------------------------------------------

const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
/** Folder names become `\`-separated display paths. */
const seg = (name: string) => name.replace(/\\/g, "＼");

interface ScanReport {
  folders: number;
  files: number;
  googleDocs: number;
  /** names of files in formats ELviewer can't read (first few) */
  unsupported: string[];
  unsupportedCount: number;
  bigArchives: number;
  failed: number;
}

async function scanRoot(root: string): Promise<{ entries: Entry[]; report: ScanReport }> {
  const out: Entry[] = [];
  const report: ScanReport = { folders: 0, files: 0, googleDocs: 0, unsupported: [], unsupportedCount: 0, bigArchives: 0, failed: 0 };
  const folderId = root.slice(DRIVE_PREFIX.length);
  // Breadth first, a few folders at a time.
  let level: { id: string; dir: string }[] = [{ id: folderId, dir: root }];
  const seen = new Set<string>([folderId]);
  while (level.length) {
    const next: { id: string; dir: string }[] = [];
    const lists = await mapLimit(level, 4, (f) => listFolder(f.id).then((items) => ({ f, items })));
    for (const { f, items } of lists) {
      for (const item of items) {
        let it = item;
        if (it.name.startsWith(".")) continue;
        if (it.isFolder) {
          if (!seen.has(it.id)) {
            seen.add(it.id);
            report.folders++;
            next.push({ id: it.id, dir: `${f.dir}\\${seg(it.name)}` });
          }
          continue;
        }
        report.files++;
        if (it.gdoc) {
          report.googleDocs++;
          continue;
        }
        if (it.shortcut) {
          // The listing only describes the shortcut; size and revision come from the target.
          try {
            const res = await driveFetch(`/drive/v3/files/${encodeURIComponent(it.id)}?${q({ fields: "size,modifiedTime", supportsAllDrives: "true" })}`);
            const m = (await res.json()) as { size?: string; modifiedTime?: string };
            it = { ...it, size: Number(m.size ?? 0), rev: m.modifiedTime ?? "", mtime: Date.parse(m.modifiedTime ?? "") || it.mtime };
          } catch (e) {
            console.warn("drive shortcut skipped", it.name, e);
            report.failed++;
            continue;
          }
        }
        revs.set(it.id, it.rev);
        const ext = extOf(it.name);
        const id = DRIVE_PREFIX + it.id;
        if (ext === "zip" || ext === "7z") {
          if (it.size > ARCHIVE_SCAN_LIMIT) {
            report.bigArchives++;
            continue;
          }
          try {
            await ensureCached(it.id);
            out.push(...(await invoke<Entry[]>("archive_entries", { id, name: it.name, dir: f.dir, root, size: it.size, mtime: it.mtime })));
          } catch (e) {
            console.warn("drive archive skipped", it.name, e);
            report.failed++;
          }
          continue;
        }
        const kind = kindForExt(ext);
        if (kind) out.push({ id, name: it.name, dir: f.dir, root, ext, kind, size: it.size, mtime: it.mtime, inArchive: false });
        else {
          report.unsupportedCount++;
          if (report.unsupported.length < 3) report.unsupported.push(it.name);
        }
      }
    }
    level = next;
  }
  return { entries: out, report };
}

/** Why a Drive folder came up empty, in words. */
function describeEmpty(name: string, r: ScanReport): string {
  if (!r.files) return `"${name}" 폴더에 파일이 없습니다 (하위 폴더 ${r.folders}개 확인).`;
  const why: string[] = [];
  if (r.googleDocs) why.push(`Google 문서·스프레드시트 ${r.googleDocs}개`);
  if (r.unsupportedCount) why.push(`지원하지 않는 형식 ${r.unsupportedCount}개 (${r.unsupported.join(", ")}${r.unsupportedCount > r.unsupported.length ? " …" : ""})`);
  if (r.bigArchives) why.push(`64 MB가 넘는 압축 파일 ${r.bigArchives}개`);
  if (r.failed) why.push(`읽기 실패 ${r.failed}개`);
  return `"${name}" 폴더의 파일 ${r.files}개 중 읽을 수 있는 파일이 없습니다: ${why.join(", ")}.`;
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const lastScan = new Map<string, { at: number; entries: Entry[] }>();
/** Drive folders are rescanned at most this often unless forced. */
const RESCAN_MS = 60_000;

/**
 * Lists the Drive library roots. Results are remembered on disk, so the library –
 * and books already downloaded – stay available offline.
 */
export async function scanDrive(roots: string[], force = false, labelOf: (root: string) => string = (r) => r): Promise<{ entries: Entry[]; error: string | null }> {
  const saved = await loadValue<Record<string, Entry[]>>("gdrive.json", "entries", {});
  const entries: Entry[] = [];
  let error: string | null = null;
  for (const root of roots) {
    const recent = lastScan.get(root);
    if (!force && recent && Date.now() - recent.at < RESCAN_MS) {
      entries.push(...recent.entries);
      continue;
    }
    try {
      const { entries: list, report } = await scanRoot(root);
      if (!list.length) error = describeEmpty(labelOf(root), report);
      lastScan.set(root, { at: Date.now(), entries: list });
      saved[root] = list;
      entries.push(...list);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      entries.push(...(saved[root] ?? recent?.entries ?? []));
    }
  }
  // Forget removed roots.
  for (const k of Object.keys(saved)) if (!roots.includes(k)) delete saved[k];
  await saveValue("gdrive.json", "entries", saved);
  return { entries, error };
}

// ---- sync file (hidden app data folder) -------------------------------------------

const SYNC_NAME = "elviewer-sync.json";
let syncFileId: string | null = null;

async function findSyncFile(): Promise<string | null> {
  if (syncFileId) return syncFileId;
  const res = await driveFetch(`/drive/v3/files?${q({ spaces: "appDataFolder", q: `name = '${SYNC_NAME}' and trashed = false`, fields: "files(id,modifiedTime)", orderBy: "modifiedTime desc" })}`);
  const files = ((await res.json()) as { files?: { id: string }[] }).files ?? [];
  syncFileId = files[0]?.id ?? null;
  return syncFileId;
}

/** Contents of the sync file, or null when there is none yet. */
export async function readSyncFile(): Promise<string | null> {
  const id = await findSyncFile();
  if (!id) return null;
  try {
    const res = await driveFetch(`/drive/v3/files/${id}?alt=media`, { cache: "no-store" });
    return await res.text();
  } catch (e) {
    // Deleted meanwhile (e.g. "delete hidden app data" in Drive settings).
    if (String(e).includes("(404)")) {
      syncFileId = null;
      return null;
    }
    throw e;
  }
}

export async function writeSyncFile(json: string): Promise<void> {
  const id = await findSyncFile();
  if (id) {
    await driveFetch(`/upload/drive/v3/files/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: json });
    return;
  }
  const boundary = `elviewer${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: SYNC_NAME, parents: ["appDataFolder"], mimeType: "application/json" });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  const res = await driveFetch(`/upload/drive/v3/files?${q({ uploadType: "multipart", fields: "id" })}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  syncFileId = ((await res.json()) as { id: string }).id;
}
