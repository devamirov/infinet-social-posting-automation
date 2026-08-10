import OpenAI from 'openai';
import { config } from '../config';

const CAPTION_SYSTEM = `You are a social media copywriter for InfiNet digital services. Brands: InfiNet AI (ai.infinet.services), InfiNet web/mobile dev & hosting (infinet.services), Spectre.guru OSINT tool, InfiNet Hub mobile app. Write short, engaging captions. Tone: professional but approachable. Include a clear hook and CTA. Return ONLY the caption text, no labels.`;

export async function generateCaption(topic: string, productHint?: string): Promise<string> {
  const apiKey = config.openai.captionApiKey;
  if (!apiKey) throw new Error('OpenAI caption API key not set (OPENAI_CAPTION_API_KEY or OPENAI_API_KEY)');

  const openai = new OpenAI({ apiKey });
  const userPrompt = productHint
    ? `Topic: ${topic}. Focus on: ${productHint}. Write one caption (under 200 chars for Twitter, can be longer for others - we'll trim).`
    : `Topic: ${topic}. Write one engaging social media caption.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: CAPTION_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 300,
  });

  const text = completion.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned empty caption');
  return text;
}
