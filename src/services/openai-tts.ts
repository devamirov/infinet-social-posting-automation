import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function textToSpeech(text: string, outPath: string): Promise<string> {
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text.slice(0, 4096),
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, buffer);
  return outPath;
}
