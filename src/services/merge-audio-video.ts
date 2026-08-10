import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { config } from '../config';

export function mergeAudioWithVideo(videoPath: string, audioPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}
