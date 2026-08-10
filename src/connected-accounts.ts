import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'connected-accounts.json');

export interface ConnectedAccounts {
  tiktok?: {
    accessToken: string;
    refreshToken: string;
    openId?: string;
    expiresAt?: number;
  };
  facebook?: {
    accessToken: string;
    pageId?: string;
    pageAccessToken?: string;
  };
  instagram?: {
    accessToken: string;
    igUserId?: string;
  };
}

function read(): ConnectedAccounts {
  if (!fs.existsSync(FILE)) return {};
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw) as ConnectedAccounts;
  } catch {
    return {};
  }
}

function write(data: ConnectedAccounts) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function getConnectedAccounts(): ConnectedAccounts {
  return read();
}

export function setTikTok(tokens: ConnectedAccounts['tiktok']) {
  const data = read();
  data.tiktok = tokens ?? undefined;
  if (!data.tiktok) delete data.tiktok;
  write(data);
}

export function setFacebook(tokens: ConnectedAccounts['facebook']) {
  const data = read();
  data.facebook = tokens ?? undefined;
  if (!data.facebook) delete data.facebook;
  write(data);
}

export function setInstagram(tokens: ConnectedAccounts['instagram']) {
  const data = read();
  data.instagram = tokens ?? undefined;
  if (!data.instagram) delete data.instagram;
  write(data);
}

export function isDirectConnected(platform: 'tiktok' | 'facebook' | 'instagram'): boolean {
  const data = read();
  switch (platform) {
    case 'tiktok':
      return !!(data.tiktok?.accessToken);
    case 'facebook':
      return !!(data.facebook?.pageAccessToken || data.facebook?.accessToken);
    case 'instagram':
      return !!(data.instagram?.accessToken);
    default:
      return false;
  }
}
