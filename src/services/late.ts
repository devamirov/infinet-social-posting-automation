import axios from 'axios';
import { config } from '../config';

const LATE_BASE = 'https://getlate.dev/api/v1';

function headers() {
  return {
    Authorization: `Bearer ${config.late.apiKey}`,
    'Content-Type': 'application/json',
  };
}

export interface LatePostOptions {
  content: string;
  mediaItems?: { type: 'image' | 'video'; url: string }[];
  platforms: { platform: 'instagram' | 'facebook' | 'tiktok' | 'twitter'; accountId: string; platformSpecificData?: Record<string, unknown> }[];
  publishNow?: boolean;
  scheduledFor?: string;
  timezone?: string;
}

const MAX_POST_RETRIES = 4;
const RETRY_DELAYS_MS = [2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createPost(options: LatePostOptions): Promise<{ post: { _id: string }; message?: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_POST_RETRIES; attempt++) {
    try {
      const { data } = await axios.post(
        `${LATE_BASE}/posts`,
        {
          content: options.content,
          mediaItems: options.mediaItems,
          platforms: options.platforms,
          publishNow: options.publishNow ?? true,
          scheduledFor: options.scheduledFor,
          timezone: options.timezone,
        },
        { headers: headers(), timeout: 60000 }
      );
      return data;
    } catch (err: unknown) {
      lastError = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const isRetryable = status === undefined || status === 429 || (status >= 500 && status < 600);
      if (attempt === MAX_POST_RETRIES || !isRetryable) break;
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 8000;
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function listAccounts(): Promise<{ accounts: { _id: string; platform: string; username?: string }[] }> {
  const { data } = await axios.get(`${LATE_BASE}/accounts`, { headers: headers() });
  return data;
}

export function getPlatformAccountIds(): {
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  twitter?: string;
} {
  const acc = config.late.accounts;
  return {
    instagram: acc.instagram || undefined,
    facebook: acc.facebook || undefined,
    tiktok: acc.tiktok || undefined,
    twitter: acc.twitter || undefined,
  };
}
