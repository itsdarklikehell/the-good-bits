// io-fs.js
//
// Folder/file selection, recursive audio discovery, and output writing.
// Two paths, feature-detected at runtime:
//
//   - File System Access API (Chrome/Edge): folders are opened read-write,
//     so wav/ and chops/ get written straight back into the source folder.
//   - Fallback (Safari/Firefox, or any browser without that API): folders
//     are read via a hidden <input type="file" webkitdirectory> element,
//     and the whole batch's output is assembled into one ZIP for download,
//     mirroring the same folder structure inside it.
//
// "Add Source Folder" can be clicked repeatedly to build up a multi-folder
// batch, the same way Cmd/Shift-click builds a multi-file/folder selection
// in a native picker.

export const AUDIO_EXTS = new Set([".wav", ".m4a", ".aif", ".aiff", ".flac", ".mp3"]);

export function supportsFileSystemAccess() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export function supportsFilePickerFSA() {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/**
 * Compact " / "-joined provenance path for one source file: the picker-chosen root folder's name,
 * any relative subfolder path discovered under it (populated by the recursive collectors below for
 * every import path - FSA folder, legacy webkitdirectory, drag-and-drop), and the file's own name.
 * Never fabricates anything beyond what those already hold - there is no absolute filesystem path to
 * show (the browser deliberately never exposes one), so this is the most truthful "where did this
 * come from" available. Two files with the same basename from different subfolders always produce
 * different output here, since relativeDir differs.
 */
export function formatSourcePath(rootName, relativeDir, fileName) {
  const parts = [rootName, ...(relativeDir ? relativeDir.split("/") : []), fileName].filter(Boolean);
  return parts.join(" / ");
}

function isExcludedSegment(name) {
  const n = name.toLowerCase();
  return n === "wav" || n === "chops" || n === "one shots" || n === "chops clean" || n === "one shots clean";
}

// ---------------------------------------------------------------------------
// File System Access API path
// ---------------------------------------------------------------------------

/** Opens the native folder picker. Returns null if the user cancels. */
export async function pickFolderFSA() {
  try {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
}

/** Opens the native multi-file picker for individual audio files. Returns [] if the user cancels. */
export async function pickFilesFSA() {
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: "Audio files",
          accept: { "audio/*": [".wav", ".m4a", ".aif", ".aiff", ".flac", ".mp3"] },
        },
      ],
    });
    return handles.filter((h) => AUDIO_EXTS.has(extOf(h.name)));
  } catch (err) {
    if (err && err.name === "AbortError") return [];
    throw err;
  }
}

export async function ensureReadWritePermission(dirHandle) {
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

/** Recursively collect audio files under a FileSystemDirectoryHandle, skipping wav/ and chops/. */
export async function collectAudioFilesFSA(dirHandle, relPrefix = "") {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      if (isExcludedSegment(name)) continue;
      const nested = await collectAudioFilesFSA(handle, relPrefix ? `${relPrefix}/${name}` : name);
      out.push(...nested);
    } else if (handle.kind === "file") {
      const ext = extOf(name);
      if (AUDIO_EXTS.has(ext)) {
        out.push({ relativeDir: relPrefix, name, ext, fsaHandle: handle });
      }
    }
  }
  out.sort((a, b) => (a.relativeDir + "/" + a.name).localeCompare(b.relativeDir + "/" + b.name));
  return out;
}

async function hasAudioRecursiveFSA(dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      if (isExcludedSegment(name)) continue;
      if (await hasAudioRecursiveFSA(handle)) return true;
    } else if (handle.kind === "file") {
      if (AUDIO_EXTS.has(extOf(name))) return true;
    }
  }
  return false;
}

/**
 * For "treat each subfolder as its own source": look at the immediate
 * children of a picked folder and return the ones that contain audio
 * (directly or nested), each as its own {name, handle}. Returns [] if none
 * qualify, in which case the caller should fall back to treating the picked
 * folder itself as a single source.
 */
export async function discoverImmediateSourceChildren(rootHandle) {
  const children = [];
  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind !== "directory") continue;
    if (isExcludedSegment(name)) continue;
    if (await hasAudioRecursiveFSA(handle)) children.push({ name, handle });
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

async function getNestedDirHandle(rootHandle, relDir, create) {
  if (!relDir) return rootHandle;
  let cur = rootHandle;
  for (const part of relDir.split("/").filter(Boolean)) {
    cur = await cur.getDirectoryHandle(part, { create });
  }
  return cur;
}

/** Write a Blob to sourceDirHandle/subdirName/relDir/fileName (creating folders as needed). */
export async function writeFileFSA(sourceDirHandle, subdirName, relDir, fileName, blob) {
  const subdir = await sourceDirHandle.getDirectoryHandle(subdirName, { create: true });
  const targetDir = await getNestedDirHandle(subdir, relDir, true);
  const fileHandle = await targetDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Delete any previously-generated NN.wav files in a <rootName>/relDir/stem destination directory
 * (idempotent re-runs). Shared by chops, one-shots, and their "clean" (unprocessed-copy) siblings -
 * all four use the same plain sequential-number naming.
 *
 * Deliberately `create: false` throughout: this function only ever cleans up, it never needs to
 * write anything, so it must never bring a directory into existence that wasn't already there.
 * `create: true` here was the actual cause of the "CHOP produces an empty chops clean/ folder even
 * with Output Stage off" bug - clearing "chops clean/<stem>/" unconditionally on every export
 * (idempotent re-run cleanup, called regardless of whether a clean copy was ever wanted) created that
 * whole empty directory tree just to find it empty, defeating the try/catch below whose comment
 * always intended "doesn't exist -> nothing to clear" to be a no-op, not a side effect.
 */
export async function clearOldNumberedFilesFSA(sourceDirHandle, rootName, relDir, stem) {
  try {
    const root = await sourceDirHandle.getDirectoryHandle(rootName, { create: false });
    const destDir = await getNestedDirHandle(root, relDir ? `${relDir}/${stem}` : stem, false);
    for await (const [name, handle] of destDir.entries()) {
      if (handle.kind === "file" && /^\d+\.wav$/i.test(name)) {
        try {
          await destDir.removeEntry(name);
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* destination didn't exist yet - nothing to clear */
  }
}

/** Delete any previously-generated NN.wav files in a chops destination directory (idempotent re-runs). */
export async function clearOldChopsFSA(sourceDirHandle, relDir, stem) {
  return clearOldNumberedFilesFSA(sourceDirHandle, "chops", relDir, stem);
}

/** Delete any previously-generated NN.wav one-shots in a destination directory (idempotent re-runs). */
export async function clearOldOneShotsFSA(sourceDirHandle, relDir, stem) {
  return clearOldNumberedFilesFSA(sourceDirHandle, "one shots", relDir, stem);
}

/**
 * Delete every .wav file in a variations/relDir/stem destination directory (idempotent re-runs).
 * Not the NN.wav pattern clearOldNumberedFilesFSA looks for: a variation export is named by
 * character ("loop Glitch.wav"), not by a running number, and that named set can shrink between
 * runs (uncheck a character) exactly the way a shrinking chop count already does - so this clears
 * the whole directory rather than trying to guess which specific names might now be stale. Safe to
 * be this blunt because nothing else ever writes into a source's own variations/ folder.
 */
export async function clearOldVariationsFSA(sourceDirHandle, relDir, stem) {
  try {
    const root = await sourceDirHandle.getDirectoryHandle("variations", { create: false });
    const destDir = await getNestedDirHandle(root, relDir ? `${relDir}/${stem}` : stem, false);
    for await (const [name, handle] of destDir.entries()) {
      if (handle.kind === "file" && /\.wav$/i.test(name)) {
        try {
          await destDir.removeEntry(name);
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* destination didn't exist yet - nothing to clear */
  }
}

// ---------------------------------------------------------------------------
// Legacy <input webkitdirectory> / <input multiple> path
// ---------------------------------------------------------------------------

/**
 * Build one or more source-folder descriptors from a FileList produced by
 * <input type="file" webkitdirectory>. All files share a common top-level
 * folder name in their webkitRelativePath.
 *
 * With splitSubfolders:true, files are grouped by their immediate
 * subfolder instead of all being lumped under the picked folder - each
 * subfolder becomes its own source group. Files sitting directly in the
 * picked folder (no subfolder) stay grouped under the picked folder's own
 * name.
 *
 * Returns an array of {rootName, files} groups (normally length 1).
 */
export function collectAudioFilesLegacy(fileList, { splitSubfolders = false } = {}) {
  const files = Array.from(fileList);
  if (files.length === 0) return [];
  const pickedRootName = files[0].webkitRelativePath.split("/")[0];

  const groups = new Map(); // groupName -> files[]
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/").slice(1); // drop the picked folder's own name
    if (parts.length === 0) continue;
    const name = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);
    if (dirParts.some(isExcludedSegment)) continue;
    const ext = extOf(name);
    if (!AUDIO_EXTS.has(ext)) continue;

    let groupName = pickedRootName;
    let relativeDir = dirParts.join("/");
    if (splitSubfolders && dirParts.length > 0) {
      groupName = `${pickedRootName}/${dirParts[0]}`;
      relativeDir = dirParts.slice(1).join("/");
    }

    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ relativeDir, name, ext, legacyFile: file });
  }

  const out = [];
  for (const [rootName, groupFiles] of groups) {
    groupFiles.sort((a, b) => (a.relativeDir + "/" + a.name).localeCompare(b.relativeDir + "/" + b.name));
    out.push({ rootName, files: groupFiles });
  }
  out.sort((a, b) => a.rootName.localeCompare(b.rootName));
  return out;
}

/** Build a single source-folder descriptor for loose individually-picked files (legacy path). */
export function collectIndividualFilesLegacy(fileList, groupName) {
  const files = Array.from(fileList).filter((f) => AUDIO_EXTS.has(extOf(f.name)));
  return {
    rootName: groupName,
    files: files.map((f) => ({ relativeDir: "", name: f.name, ext: extOf(f.name), legacyFile: f })),
  };
}

// ---------------------------------------------------------------------------
// Drag-and-drop (read-only fallback path, used when the File System Access API - or its
// DataTransferItem.getAsFileSystemHandle() drop variant - isn't available: Safari, Firefox).
// Walks the older webkitGetAsEntry() entry tree instead, so it works everywhere drag-and-drop
// itself does, at the cost of only ever producing a ZIP-fallback (read-only) source, same as the
// hidden <input webkitdirectory> path. See app.js's drop handler for the FSA-capable branch,
// which uses real DataTransferItem.getAsFileSystemHandle() directory/file handles instead of this.
// ---------------------------------------------------------------------------

function readEntries(dirEntry) {
  const reader = dirEntry.createReader();
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });
}

function readEntryFile(fileEntry) {
  return new Promise((resolve, reject) => fileEntry.file(resolve, reject));
}

/** Recursively walks a dropped FileSystemDirectoryEntry into a flat list of
 * {relativeDir, name, ext, legacyFile} descriptors - the same shape collectAudioFilesLegacy
 * produces, without depending on webkitRelativePath (drag-and-drop File objects don't reliably
 * carry that the way an <input webkitdirectory> selection does). */
async function walkDroppedDirEntry(dirEntry, relativeDir, out) {
  for (const entry of await readEntries(dirEntry)) {
    if (entry.isDirectory) {
      if (isExcludedSegment(entry.name)) continue;
      await walkDroppedDirEntry(entry, relativeDir ? `${relativeDir}/${entry.name}` : entry.name, out);
    } else if (entry.isFile) {
      const ext = extOf(entry.name);
      if (!AUDIO_EXTS.has(ext)) continue;
      out.push({ relativeDir, name: entry.name, ext, legacyFile: await readEntryFile(entry) });
    }
  }
}

/**
 * Reads one dropped top-level folder (a FileSystemDirectoryEntry from webkitGetAsEntry()) into
 * {rootName, files} group(s) - normally one, or one per immediate subfolder with
 * splitSubfolders:true, mirroring collectAudioFilesLegacy's own splitSubfolders option.
 */
export async function collectDroppedFolderLegacy(dirEntry, { splitSubfolders = false } = {}) {
  const flat = [];
  await walkDroppedDirEntry(dirEntry, "", flat);
  const sortKey = (f) => `${f.relativeDir}/${f.name}`;

  if (!splitSubfolders) {
    flat.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return [{ rootName: dirEntry.name, files: flat }];
  }

  const groups = new Map();
  for (const f of flat) {
    const [first, ...rest] = f.relativeDir ? f.relativeDir.split("/") : [""];
    const groupName = first ? `${dirEntry.name}/${first}` : dirEntry.name;
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ ...f, relativeDir: first ? rest.join("/") : "" });
  }
  const out = [];
  for (const [rootName, groupFiles] of groups) {
    groupFiles.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    out.push({ rootName, files: groupFiles });
  }
  out.sort((a, b) => a.rootName.localeCompare(b.rootName));
  return out;
}

// ---------------------------------------------------------------------------
// ZIP export (fallback output path)
// ---------------------------------------------------------------------------

/**
 * Accumulates output blobs across an entire batch and produces one ZIP,
 * mirroring "<Source Folder>/wav/..." and "<Source Folder>/chops/..." for
 * every queued folder, just like a direct-write run would leave on disk.
 */
export class ZipBatch {
  constructor() {
    this.zip = new window.JSZip();
  }
  addFile(sourceFolderName, subdirName, relDir, fileName, blob) {
    const parts = [sourceFolderName, subdirName, ...(relDir ? relDir.split("/") : [])];
    let folder = this.zip;
    for (const p of parts) folder = folder.folder(p);
    folder.file(fileName, blob);
  }
  async downloadAs(filename) {
    const blob = await this.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
