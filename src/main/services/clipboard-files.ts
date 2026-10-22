/**
 * Files and images on the local clipboard, uploaded to the host on paste.
 *
 * Electron's clipboard.read() only looks at the first pasteboard item, and a
 * Finder copy of several files puts one item per file — so on macOS the full
 * list is read through AppKit with a short JXA script instead.
 */
import { execFile } from 'child_process'
import { clipboard } from 'electron'
import type { ClipboardPaste } from '../../shared/domain'
import { uploadBytes, uploadLocalPaths } from './upload'
import { fileUrlToPath, parseUriList, pastedImageName } from './upload-util'

const JXA_FILE_URLS = `
ObjC.import("AppKit");
const pb = $.NSPasteboard.generalPasteboard;
const opts = $.NSDictionary.dictionaryWithObjectForKey(
  $.NSNumber.numberWithBool(true), "NSPasteboardURLReadingFileURLsOnlyKey");
const urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), opts);
const out = [];
if (urls) for (let i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path));
JSON.stringify(out);
`

function macFilePaths(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', JXA_FILE_URLS], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(err)
        return
      }
      try {
        const parsed: unknown = JSON.parse(stdout.trim())
        resolve(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [])
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** Local paths of files copied in Finder (or a Linux file manager); [] when none. */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (process.platform === 'darwin') {
    const first = clipboard.read('public.file-url')
    if (first === '') return [] // the common case — skip spawning osascript
    try {
      const all = await macFilePaths()
      if (all.length > 0) return all
    } catch {
      // fall through to the one file Electron can see
    }
    const path = fileUrlToPath(first)
    return path ? [path] : []
  }
  const list = clipboard.read('text/uri-list')
  if (list !== '') return parseUriList(list)
  // GNOME/Nautilus: "copy\nfile:///a\nfile:///b"
  const gnome = clipboard.read('x-special/gnome-copied-files')
  if (gnome !== '') return parseUriList(gnome.split('\n').slice(1).join('\n'))
  return []
}

function clipboardPng(): Buffer | null {
  const image = clipboard.readImage()
  return image.isEmpty() ? null : image.toPNG()
}

/**
 * Upload whatever files or image are on the clipboard into `remoteDir` (or a
 * staging dir). Resolves null when the clipboard holds neither.
 */
export async function uploadClipboard(hostId: string, remoteDir: string | null): Promise<string[] | null> {
  const files = await readClipboardFilePaths()
  if (files.length > 0) return uploadLocalPaths(hostId, files, remoteDir)
  const png = clipboardPng()
  if (png) return [await uploadBytes(hostId, pastedImageName(new Date()), png, remoteDir)]
  return null
}

/**
 * What ⌘V in a terminal should send. Copied files win (Finder also puts
 * their names on the clipboard as text), then text, then an image — so a
 * spreadsheet copy, which carries both text and a picture, still pastes text.
 */
export async function clipboardPasteForTerminal(hostId: string): Promise<ClipboardPaste> {
  const files = await readClipboardFilePaths()
  if (files.length > 0) return { kind: 'files', paths: await uploadLocalPaths(hostId, files, null) }
  const text = clipboard.readText()
  if (text !== '') return { kind: 'text', text }
  const png = clipboardPng()
  if (png) {
    return { kind: 'files', paths: [await uploadBytes(hostId, pastedImageName(new Date()), png, null)] }
  }
  return { kind: 'empty' }
}
