import fs from 'fs';
import path from 'path';

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'run-history.json');
const MAX_ENTRIES = 100;

export interface RunHistoryEntry {
  id: string;
  createdAt: string;
  topic: string;
  productHint?: string;
  imageUrl: string;
  videoUrl: string;
  caption: string;
  postedImage: boolean;
  postedVideo: boolean;
  /** When set, post was scheduled for this time (ISO string). */
  scheduledFor?: string;
}

function ensureDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readHistory(): RunHistoryEntry[] {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeHistory(entries: RunHistoryEntry[]) {
  ensureDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

export function getRecentRuns(limit = 50): RunHistoryEntry[] {
  const all = readHistory();
  return all.slice(0, limit);
}

export function addRun(entry: Omit<RunHistoryEntry, 'id' | 'createdAt'>): RunHistoryEntry {
  const full: RunHistoryEntry = {
    ...entry,
    id: `run_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
  const all = readHistory();
  all.unshift(full);
  writeHistory(all.slice(0, MAX_ENTRIES));
  return full;
}
