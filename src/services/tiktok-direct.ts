import { config } from '../config';
import { getConnectedAccounts, setTikTok } from '../connected-accounts';

const TIKTOK_OPEN = 'https://open.tiktokapis.com';

/** Refresh TikTok access token if we have a refresh token. Returns current or new access token. */
async function ensureValidToken(): Promise<{ accessToken: string }> {
  const acc = getConnectedAccounts();
  const tiktok = acc.tiktok;
  if (!tiktok?.accessToken) throw new Error('TikTok not connected (direct API).');
  const { clientKey, clientSecret } = config.direct.tiktok;
  if (!clientKey || !clientSecret) throw new Error('TikTok direct API not configured.');

  const expired = tiktok.expiresAt && Date.now() >= tiktok.expiresAt - 60 * 1000;
  if (!expired && tiktok.accessToken) return { accessToken: tiktok.accessToken };
  if (!tiktok.refreshToken) throw new Error('TikTok token expired; reconnect TikTok.');

  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: tiktok.refreshToken,
  });
  const res = await fetch(`${TIKTOK_OPEN}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    open_id?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !data.access_token) throw new Error('TikTok token refresh failed.');
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
  setTikTok({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tiktok.refreshToken,
    openId: data.open_id || tiktok.openId,
    expiresAt,
  });
  return { accessToken: data.access_token };
}

export interface TikTokDirectPostOptions {
  videoUrl: string;
  caption: string;
  /** Default PUBLIC_TO_EVERYONE */
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
}

/**
 * Post a video to TikTok using the Content Posting API (direct).
 * Uses PULL_FROM_URL so the video must be on a verified domain.
 */
export async function postVideoDirect(options: TikTokDirectPostOptions): Promise<{ publishId: string }> {
  const { accessToken } = await ensureValidToken();
  const { videoUrl, caption, privacyLevel = 'PUBLIC_TO_EVERYONE' } = options;

  const res = await fetch(`${TIKTOK_OPEN}/v2/post/publish/video/init/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: privacyLevel,
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl,
      },
    }),
  });

  const data = (await res.json()) as {
    data?: { publish_id?: string };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || !data.data?.publish_id) {
    const msg = data.error?.message || data.error?.code || res.statusText;
    throw new Error(`TikTok direct post failed: ${msg}`);
  }
  return { publishId: data.data.publish_id };
}
