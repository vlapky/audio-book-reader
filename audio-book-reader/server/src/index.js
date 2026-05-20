import cors from 'cors';
import { EdgeTTS, VoicesManager } from 'edge-tts-universal';
import express from 'express';
import { nanoid } from 'nanoid';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = process.env.PORT || 5174;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');

app.use(cors());
app.use(express.json({ limit: '3mb' }));

function normalizeRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value)) return '+0%';
  const clamped = Math.max(0.5, Math.min(2, value));
  const percent = Math.round((clamped - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function sanitizeTtsText(text) {
  return [...text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()]
    .slice(0, 4500)
    .join('');
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/voices', async (req, res) => {
  try {
    const voicesManager = await VoicesManager.create();
    const voices = voicesManager
      .find({})
      .map((voice) => voice.ShortName)
      .filter(Boolean);
    res.json({ voices });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось получить список голосов Edge TTS.', details: error.message });
  }
});

app.post('/api/synthesize', async (req, res) => {
  const { text, voice = 'ru-RU-SvetlanaNeural', rate = 1, batchId } = req.body || {};

  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Поле text обязательно.' });
    return;
  }

  const id = batchId || nanoid(10);

  try {
    const safeText = sanitizeTtsText(text);
    if (!safeText) {
      res.status(400).json({ error: 'Текст не содержит символов, подходящих для озвучки.' });
      return;
    }
    const tts = new EdgeTTS(safeText, voice, { rate: normalizeRate(rate) });
    const result = await tts.synthesize();
    const audioBuffer = Buffer.from(await result.audio.arrayBuffer());
    res.json({ id, mimeType: 'audio/mpeg', audioBase64: audioBuffer.toString('base64') });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось сгенерировать аудио через Edge TTS.', details: error.message });
  }
});

try {
  await access(clientDistPath);
  app.use(express.static(clientDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
} catch {
  console.log('Frontend build not found, serving API only.');
}

app.listen(port, () => {
  console.log(`Audio book backend: http://localhost:${port}`);
});
