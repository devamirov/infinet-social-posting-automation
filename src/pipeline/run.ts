import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { generateCaption } from '../services/openai-caption';
import { img2imgWithNanoBanana, imageToVideoSVD } from '../services/replicate';
import { textToSpeech } from '../services/openai-tts';
import { mergeAudioWithVideo } from '../services/merge-audio-video';
import { createPost, getPlatformAccountIds } from '../services/late';
import { postVideoDirect } from '../services/tiktok-direct';
import { getConnectedAccounts } from '../connected-accounts';
import { getUsedSet, markUsed, clearUsedForFolder } from '../used-images';

/** Pick one reference image. Uses only unused images; when folder is exhausted, resets that folder and reuses. */
function pickReferenceImage(brandFolderIndex?: number): string | null {
  const used = getUsedSet();
  const folders = config.paths.brandFolders;
  const indices = brandFolderIndex !== undefined && brandFolderIndex >= 0 && brandFolderIndex < folders.length
    ? [brandFolderIndex]
    : folders.map((_, i) => i);

  for (const idx of indices) {
    const dir = folders[idx];
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .map((f) => path.join(dir, f));
    if (files.length === 0) continue;

    const unused = files.filter((f) => !used.has(path.resolve(f)));
    const pool = unused.length > 0 ? unused : (clearUsedForFolder(dir), files);
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    markUsed(chosen);
    return chosen;
  }
  return null;
}

export interface RunPipelineOptions {
  topic: string;
  productHint?: string;
  /** Public base URL for media (e.g. https://automation.infinet.services) */
  baseUrl?: string;
  /** Brand folder index from config.paths.brandFolders; if set, use only this folder. */
  brandFolderIndex?: number;
  /** If set, post is scheduled for this time (ISO string); otherwise post now. */
  scheduledFor?: string;
  /** Timezone for scheduled post (e.g. Europe/London). */
  timezone?: string;
}

export interface RunPipelineResult {
  caption: string;
  imagePath: string;
  videoPath: string;
  videoWithAudioPath: string;
  postedImage: boolean;
  postedVideo: boolean;
  /** Set when post was scheduled (not published immediately). */
  scheduledFor?: string;
  error?: string;
}

export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
  const { topic, productHint, baseUrl = process.env.BASE_URL || 'http://localhost:3000', brandFolderIndex, scheduledFor, timezone } = options;
  const publishNow = !scheduledFor;
  const ids = getPlatformAccountIds();
  const direct = getConnectedAccounts();
  const directTiktok = !!(direct.tiktok?.accessToken);

  const platforms = [
    ids.instagram && { platform: 'instagram' as const, accountId: ids.instagram },
    ids.facebook && { platform: 'facebook' as const, accountId: ids.facebook },
    ids.tiktok && !directTiktok && { platform: 'tiktok' as const, accountId: ids.tiktok },
    ids.twitter && { platform: 'twitter' as const, accountId: ids.twitter },
  ].filter(Boolean) as { platform: 'instagram' | 'facebook' | 'tiktok' | 'twitter'; accountId: string }[];

  const hasAnyPostTarget = platforms.length > 0 || directTiktok;
  if (!hasAnyPostTarget) throw new Error('No posting target: connect TikTok/Facebook/Instagram (direct or Late) and/or set LATE_ACCOUNT_* in .env');

  if (!fs.existsSync(config.paths.temp)) fs.mkdirSync(config.paths.temp, { recursive: true });
  if (!fs.existsSync(config.paths.output)) fs.mkdirSync(config.paths.output, { recursive: true });

  const caption = await generateCaption(topic, productHint);
  const shortCaption = caption.slice(0, 200);

  const referenceImage = pickReferenceImage(brandFolderIndex);
  if (!referenceImage) throw new Error('No brand reference image found in brand folders');
  const imagePrompt = `${topic}. Style inspired by the reference. Professional, modern, clean. ${productHint || ''}`;
  const imagePath = await img2imgWithNanoBanana(referenceImage, imagePrompt);
  const imageFilename = path.basename(imagePath);
  const imageOutputPath = path.join(config.paths.output, imageFilename);
  fs.copyFileSync(imagePath, imageOutputPath);
  const imageUrl = `${baseUrl.replace(/\/$/, '')}/media/${imageFilename}`;

  const videoPath = await imageToVideoSVD(imageOutputPath);
  const audioPath = path.join(config.paths.temp, `tts_${Date.now()}.mp3`);
  await textToSpeech(shortCaption, audioPath);
  const videoWithAudioPath = path.join(config.paths.output, `video_${Date.now()}.mp4`);
  await mergeAudioWithVideo(videoPath, audioPath, videoWithAudioPath);
  const videoFilename = path.basename(videoWithAudioPath);
  const videoUrl = `${baseUrl.replace(/\/$/, '')}/media/${videoFilename}`;

  const imagePlatforms = platforms.filter((p) => p.platform === 'facebook' || p.platform === 'twitter');
  const videoPlatforms = platforms.filter((p) => p.platform === 'instagram' || p.platform === 'tiktok');

  let postedImage = false;
  let postedVideo = false;

  if (imagePlatforms.length > 0) {
    await createPost({
      content: caption,
      mediaItems: [{ type: 'image', url: imageUrl }],
      platforms: imagePlatforms,
      publishNow,
      scheduledFor: publishNow ? undefined : scheduledFor,
      timezone: publishNow ? undefined : timezone,
    });
    postedImage = true;
  }

  if (videoPlatforms.length > 0) {
    await createPost({
      content: caption,
      mediaItems: [{ type: 'video', url: videoUrl }],
      platforms: videoPlatforms.map((p) =>
        p.platform === 'instagram' ? { ...p, platformSpecificData: { contentType: 'reel' } } : p
      ),
      publishNow,
      scheduledFor: publishNow ? undefined : scheduledFor,
      timezone: publishNow ? undefined : timezone,
    });
    postedVideo = true;
  }

  if (directTiktok && publishNow) {
    await postVideoDirect({ videoUrl, caption: shortCaption });
    postedVideo = true;
  }

  return {
    caption,
    imagePath: imageOutputPath,
    videoPath,
    videoWithAudioPath,
    postedImage,
    postedVideo,
    scheduledFor: publishNow ? undefined : scheduledFor,
  };
}
