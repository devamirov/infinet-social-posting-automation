import Replicate from 'replicate';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { config } from '../config';

const replicate = new Replicate({ auth: config.replicate.apiToken });

const NANO_BANANA = 'google/nano-banana:f0a9d34b12ad1c1cd76269a844b218ff4e64e128ddaba93e15891f47368958a0';
const SVD_VIDEO = 'aicapcut/stable-video-diffusion-img2vid-xt-optimized:7b595c69ca428904c1907155b93a5580653d1e9dcd407612142595908650dd67';

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

export async function img2imgWithNanoBanana(imagePath: string, prompt: string): Promise<string> {
  const imageData = fs.readFileSync(imagePath);
  const imageBase64 = `data:image/png;base64,${imageData.toString('base64')}`;
  const output = await replicate.run(NANO_BANANA as any, {
    input: {
      image_input: [imageBase64],
      prompt,
      output_format: 'png',
    },
  });
  const url = Array.isArray(output) ? output[0] : (output as unknown as string);
  if (!url || typeof url !== 'string') throw new Error('nano-banana returned no image');
  const ext = path.extname(new URL(url).pathname) || '.png';
  const dest = path.join(config.paths.temp, `img2img_${Date.now()}${ext}`);
  await downloadFile(url, dest);
  return dest;
}

export async function imageToVideoSVD(imagePath: string): Promise<string> {
  const imageData = fs.readFileSync(imagePath);
  const imageBase64 = `data:image/png;base64,${imageData.toString('base64')}`;
  const output = await replicate.run(SVD_VIDEO as any, {
    input: {
      image: imageBase64,
      fps: 6,
      motion_bucket_id: 127,
      cond_aug: 0.02,
    },
  });
  const url = Array.isArray(output) ? output[0] : (output as unknown as string);
  if (!url || typeof url !== 'string') throw new Error('SVD returned no video');
  const dest = path.join(config.paths.temp, `video_${Date.now()}.mp4`);
  await downloadFile(url, dest);
  return dest;
}
