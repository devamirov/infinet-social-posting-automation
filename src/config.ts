import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env from app root (parent of dist/) so it works regardless of process.cwd()
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });
if (!process.env.BRAND_ASSETS_PATH) dotenv.config();
const brandFoldersEnv = (process.env.BRAND_ASSETS_PATH || '').split(',').map((p) => p.trim()).filter(Boolean);

const root = path.resolve(__dirname, '..');

const defaultBrandFolders = [
  'brand-assets/InfiNetHub',
  'brand-assets/hosting',
  'brand-assets/infinet',
  'brand-assets/infinet.services',
  'brand-assets/spectre.guru',
  'brand-assets/uncensored',
].map((p) => path.join(root, p));

const fromEnv = brandFoldersEnv.map((p) => path.resolve(root, p));
const atLeastOneExists = fromEnv.some((dir) => fs.existsSync(dir));
const brandFoldersResolved = atLeastOneExists ? fromEnv : defaultBrandFolders;

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  adminEmail: process.env.ADMIN_EMAIL || 'admin@infinet.services',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    captionApiKey: process.env.OPENAI_CAPTION_API_KEY || process.env.OPENAI_API_KEY || '',
  },
  replicate: {
    apiToken: process.env.REPLICATE_API_TOKEN || '',
  },
  late: {
    apiKey: process.env.LATE_API_KEY || '',
    accounts: {
      instagram: process.env.LATE_ACCOUNT_INSTAGRAM || '',
      facebook: process.env.LATE_ACCOUNT_FACEBOOK || '',
      tiktok: process.env.LATE_ACCOUNT_TIKTOK || '',
      twitter: process.env.LATE_ACCOUNT_TWITTER || '',
    },
  },

  /** Direct API OAuth (TikTok, Facebook, Instagram) – optional; when set, pipeline can use these instead of or alongside Late. */
  direct: {
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY || '',
      clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
      redirectUri: process.env.TIKTOK_REDIRECT_URI || '',
    },
    facebook: {
      appId: process.env.FACEBOOK_APP_ID || '',
      appSecret: process.env.FACEBOOK_APP_SECRET || '',
      redirectUri: process.env.FACEBOOK_REDIRECT_URI || '',
    },
    instagram: {
      /** Same Meta app as Facebook; only redirect path may differ. */
      appId: process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID || '',
      appSecret: process.env.INSTAGRAM_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '',
      redirectUri: process.env.INSTAGRAM_REDIRECT_URI || process.env.FACEBOOK_REDIRECT_URI || '',
    },
  },

  paths: {
    root,
    temp: path.resolve(root, process.env.TEMP_DIR || 'tmp'),
    output: path.resolve(root, process.env.OUTPUT_DIR || 'output'),
    brandFolders: brandFoldersResolved,
  },
};
