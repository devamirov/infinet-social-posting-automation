import fs from 'fs';
import path from 'path';

const USED_IMAGES_FILE = path.join(__dirname, '..', 'data', 'used-images.json');

function ensureDir() {
  const dir = path.dirname(USED_IMAGES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readUsedList(): string[] {
  ensureDir();
  if (!fs.existsSync(USED_IMAGES_FILE)) return [];
  try {
    const data = fs.readFileSync(USED_IMAGES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeUsedList(list: string[]) {
  ensureDir();
  fs.writeFileSync(USED_IMAGES_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

/** Returns the set of full paths that have been used as reference images. */
export function getUsedSet(): Set<string> {
  return new Set(readUsedList());
}

/** Mark an image path as used (called after picking it for a run). */
export function markUsed(imagePath: string) {
  const list = readUsedList();
  const normalized = path.resolve(imagePath);
  if (!list.includes(normalized)) {
    list.push(normalized);
    writeUsedList(list);
  }
}

/** Clear used marks for all images under this folder (so we can cycle when folder is exhausted). */
export function clearUsedForFolder(folderPath: string) {
  const list = readUsedList();
  const dir = path.resolve(folderPath);
  const filtered = list.filter((p) => !p.startsWith(dir + path.sep) && p !== dir);
  if (filtered.length !== list.length) writeUsedList(filtered);
}
