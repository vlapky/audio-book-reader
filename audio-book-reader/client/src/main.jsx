import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ePub from 'epubjs';
import { BookOpen, Menu, Moon, Sun, Upload, X } from 'lucide-react';
import './styles.css';

const apiBase = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:5174' : '');
const storageKey = 'audio-book-reader-state';
const defaultVoice = 'ru-RU-SvetlanaNeural';
const maxClientAudioBatches = 10;
const targetBatchChars = 2500;
const audioDbName = 'audio-book-reader-audio';
const audioStoreName = 'batches';

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(audioDbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(audioStoreName, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAudioKey(index, voice, rate) {
  return `${voice}:${rate}:batch:${index}`;
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function saveAudioBlob(index, voice, rate, blob) {
  const db = await openAudioDb();
  const key = getAudioKey(index, voice, rate);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(audioStoreName, 'readwrite');
    const store = transaction.objectStore(audioStoreName);
    store.put({ key, index, voice, rate, blob, createdAt: Date.now() });
    const request = store.getAll();
    request.onsuccess = () => request.result
      .filter((item) => item.voice === voice && String(item.rate) === String(rate))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(maxClientAudioBatches)
      .forEach((item) => store.delete(item.key));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function getAudioBlob(index, voice, rate) {
  const db = await openAudioDb();
  const key = getAudioKey(index, voice, rate);
  const blob = await new Promise((resolve) => {
    const transaction = db.transaction(audioStoreName, 'readonly');
    const store = transaction.objectStore(audioStoreName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return blob;
}

async function clearAudioBlobs() {
  const db = await openAudioDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(audioStoreName, 'readwrite');
    transaction.objectStore(audioStoreName).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToArrayBuffer(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function textFromHtml(html) {
  if (typeof html === 'string') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent.replace(/\s+/g, ' ').trim();
  }

  const root = html?.body || html?.documentElement || html;
  return root?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

async function parseEpub(dataUrl) {
  const book = ePub(dataUrlToArrayBuffer(dataUrl));
  await book.ready;
  const sections = [];
  for (const item of book.spine.spineItems) {
    const html = await item.load(book.load.bind(book));
    const text = textFromHtml(html);
    if (text) sections.push({ title: item.href, text });
    item.unload();
  }
  return { title: book.package?.metadata?.title || 'EPUB книга', sections };
}

function parseFb2(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const title = xml.querySelector('book-title')?.textContent?.trim() || 'FB2 книга';
  const sections = [...xml.querySelectorAll('body section')]
    .map((section, index) => ({
      title: section.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() || `Раздел ${index + 1}`,
      text: [...section.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean).join('\n\n')
    }))
    .filter((section) => section.text);
  return { title, sections: sections.length ? sections : [{ title, text: xml.body?.textContent?.replace(/\s+/g, ' ').trim() || text }] };
}

function makeBatches(sections) {
  return sections.flatMap((section, sectionIndex) => {
    const sentences = section.text.match(/[^.!?…]+[.!?…]?\s*/g) || [section.text];
    const batches = [];
    let buffer = '';
    let start = 0;
    let cursor = 0;

    sentences.forEach((sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) {
        cursor += sentence.length;
        return;
      }

      const nextText = `${buffer} ${trimmed}`.trim();
      if (nextText.length > targetBatchChars && buffer) {
        batches.push({ sectionIndex, start, end: cursor, text: buffer.trim() });
        start = cursor;
        buffer = trimmed;
      } else {
        buffer = nextText;
      }
      cursor += sentence.length;
    });

    if (buffer) batches.push({ sectionIndex, start, end: section.text.length, text: buffer.trim() });
    return batches;
  });
}

function trimAudioCache(cache, preferredIndexes = []) {
  const entries = Object.entries(cache);
  if (entries.length <= maxClientAudioBatches) return cache;
  const preferred = new Set(preferredIndexes.map(String));
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => {
        const aPreferred = preferred.has(a) ? 1 : 0;
        const bPreferred = preferred.has(b) ? 1 : 0;
        return bPreferred - aPreferred || Number(b) - Number(a);
      })
      .slice(0, maxClientAudioBatches)
  );
}

function revokeObjectUrls(urls) {
  Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
}

function SectionText({ section, sectionIndex, batches, currentBatch, audioCache, onSelectBatch }) {
  const sectionBatches = batches
    .map((batch, index) => ({ ...batch, index }))
    .filter((batch) => batch.sectionIndex === sectionIndex);
  let cursor = 0;
  const parts = [];

  sectionBatches.forEach((batch) => {
    if (batch.start > cursor) parts.push(<span key={`plain-${batch.index}`}>{section.text.slice(cursor, batch.start)}</span>);
    parts.push(
      <button
        className={`text-batch ${batch.index === currentBatch ? 'current' : ''} ${audioCache[batch.index] ? 'ready' : ''}`}
        data-batch-index={batch.index}
        key={batch.index}
        onClick={() => onSelectBatch(batch.index)}
        type="button"
      >
        {section.text.slice(batch.start, batch.end)}
      </button>
    );
    cursor = batch.end;
  });

  if (cursor < section.text.length) parts.push(<span key="plain-end">{section.text.slice(cursor)}</span>);
  return <p>{parts}</p>;
}

function batchPreview(batch) {
  return batch?.text?.split(/\s+/).slice(0, 6).join(' ') || '';
}

function App() {
  const initial = loadState();
  const [theme, setTheme] = useState(initial.theme || 'dark');
  const [book, setBook] = useState(initial.book || null);
  const [currentBatch, setCurrentBatch] = useState(initial.currentBatch || 0);
  const [voice, setVoice] = useState(initial.voice || defaultVoice);
  const [rate, setRate] = useState(initial.rate || 1);
  const [playerRate, setPlayerRate] = useState(initial.playerRate || 1);
  const [audioPositions, setAudioPositions] = useState(initial.audioPositions || {});
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [voices, setVoices] = useState([defaultVoice, 'ru-RU-DmitryNeural']);
  const [audioCache, setAudioCache] = useState({});
  const [pendingBatches, setPendingBatches] = useState([]);
  const [status, setStatus] = useState('Загрузите EPUB или FB2 книгу.');
  const audioRef = useRef(null);
  const pendingRef = useRef(new Set());
  const autoplayBatchRef = useRef(null);
  const objectUrlsRef = useRef({});

  const batches = useMemo(() => (book ? makeBatches(book.sections) : []), [book]);
  const audioUrl = audioCache[currentBatch] || '';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    saveState({ theme, book, currentBatch, voice, rate, playerRate, audioPositions });
  }, [theme, book, currentBatch, voice, rate, playerRate, audioPositions]);

  useEffect(() => {
    fetch(`${apiBase}/api/voices`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => Array.isArray(data.voices) && data.voices.length ? setVoices(data.voices) : null)
      .catch(() => setStatus('Голоса не загружены: проверьте backend и Edge TTS.'));
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = Number(playerRate);
  }, [playerRate, audioUrl]);

  useEffect(() => {
    if (!audioRef.current || !audioUrl) return;
    const savedTime = audioPositions[currentBatch] || 0;
    const applySavedTime = () => {
      if (savedTime > 0 && Math.abs(audioRef.current.currentTime - savedTime) > 1) {
        audioRef.current.currentTime = savedTime;
      }
    };
    if (audioRef.current.readyState >= 1) applySavedTime();
    else audioRef.current.addEventListener('loadedmetadata', applySavedTime, { once: true });
    return () => audioRef.current?.removeEventListener('loadedmetadata', applySavedTime);
  }, [currentBatch, audioUrl]);

  useEffect(() => {
    if (autoplayBatchRef.current === currentBatch && audioUrl) playBatch(currentBatch, audioUrl);
  }, [currentBatch, audioUrl]);

  useEffect(() => {
    if (batches.length && !audioCache[currentBatch]) preloadFrom(currentBatch);
  }, [currentBatch]);

  useEffect(() => () => revokeObjectUrls(objectUrlsRef.current), []);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus('Читаю файл...');
    const dataUrl = await fileToDataUrl(file);
    let parsed;
    if (file.name.toLowerCase().endsWith('.epub')) {
      parsed = await parseEpub(dataUrl);
    } else {
      const text = await file.text();
      parsed = parseFb2(text);
    }
    setBook({ name: file.name, ...parsed });
    setCurrentBatch(0);
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = {};
    await clearAudioBlobs();
    setAudioCache({});
    setPendingBatches([]);
    setStatus(`Книга загружена: ${parsed.title}`);
  }

  async function synthesize(index, shouldAutoplay = false) {
    const batch = batches[index];
    if (shouldAutoplay) autoplayBatchRef.current = index;
    if (!batch || audioCache[index] || pendingRef.current.has(index)) return audioCache[index] || null;

    pendingRef.current.add(index);
    setPendingBatches([...pendingRef.current]);
    setStatus(`Генерирую аудио ${index + 1} / ${batches.length}...`);
    try {
      const response = await fetch(`${apiBase}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: batch.text, voice, rate, batchId: `batch-${index}` })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ошибка генерации аудио.');
      const blob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/mpeg');
      await saveAudioBlob(index, voice, rate, blob);
      const localUrl = URL.createObjectURL(blob);
      objectUrlsRef.current[index] = localUrl;
      setAudioCache((cache) => trimAudioCache({ ...cache, [index]: localUrl }, [currentBatch, currentBatch + 1, currentBatch + 2]));
      if (autoplayBatchRef.current === index) playBatch(index, localUrl);
      return localUrl;
    } catch (error) {
      setStatus(error.message);
      return null;
    } finally {
      pendingRef.current.delete(index);
      setPendingBatches([...pendingRef.current]);
    }
  }

  async function preloadFrom(index) {
    const indexes = [index, index + 1, index + 2].filter((item) => item >= 0 && item < batches.length);
    await Promise.all(indexes.map((item) => ensureAudio(item, item === index && autoplayBatchRef.current === index)));
    setStatus(`Готово к прослушиванию: батч ${index + 1}`);
  }

  async function ensureAudio(index, shouldAutoplay = false) {
    if (audioCache[index]) {
      if (shouldAutoplay) playBatch(index, audioCache[index]);
      return audioCache[index];
    }

    const blob = await getAudioBlob(index, voice, rate);
    if (blob) {
      const localUrl = URL.createObjectURL(blob);
      objectUrlsRef.current[index] = localUrl;
      setAudioCache((cache) => trimAudioCache({ ...cache, [index]: localUrl }, [index, index + 1, index + 2]));
      if (shouldAutoplay) playBatch(index, localUrl);
      return localUrl;
    }

    return synthesize(index, shouldAutoplay);
  }

  async function playBatch(index, url = audioCache[index]) {
    if (!url || !audioRef.current || autoplayBatchRef.current !== index) return;
    if (audioRef.current.src !== url) {
      audioRef.current.src = url;
      audioRef.current.load();
      audioRef.current.currentTime = audioPositions[index] || 0;
    }
    await audioRef.current.play().catch(() => setStatus('Браузер заблокировал автозапуск. Нажмите play в аудиоплеере.'));
  }

  function saveAudioPosition() {
    if (!audioRef.current) return;
    const time = audioRef.current.currentTime;
    if (!Number.isFinite(time)) return;
    setAudioPositions((positions) => ({ ...positions, [currentBatch]: time }));
  }

  function restoreAudioPosition() {
    if (!audioRef.current) return;
    const savedTime = audioPositions[currentBatch] || 0;
    if (savedTime > 0 && Math.abs(audioRef.current.currentTime - savedTime) > 1) {
      audioRef.current.currentTime = savedTime;
    }
  }

  function handleAudioError() {
    URL.revokeObjectURL(audioCache[currentBatch]);
    setAudioCache((cache) => {
      const next = { ...cache };
      delete next[currentBatch];
      return next;
    });
    setStatus('Локальное аудио недоступно, генерирую заново...');
    synthesize(currentBatch, autoplayBatchRef.current === currentBatch);
  }

  function scrollToBatch(index) {
    requestAnimationFrame(() => {
      document.querySelector(`[data-batch-index="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function selectBatch(index) {
    autoplayBatchRef.current = index;
    setCurrentBatch(index);
    scrollToBatch(index);
    setIsSidebarOpen(false);
    ensureAudio(index, true);
    preloadFrom(index);
  }

  function selectSection(sectionIndex) {
    const index = batches.findIndex((batch) => batch.sectionIndex === Number(sectionIndex));
    if (index >= 0) selectBatch(index);
  }

  function playNextBatch() {
    const next = currentBatch + 1;
    setAudioPositions((positions) => {
      const nextPositions = { ...positions };
      delete nextPositions[currentBatch];
      return nextPositions;
    });
    if (next < batches.length) selectBatch(next);
  }

  const currentSection = batches[currentBatch]?.sectionIndex ?? 0;
  const readyBatches = Object.keys(audioCache).map(Number).sort((a, b) => a - b);

  async function resetAudioCache() {
    revokeObjectUrls(objectUrlsRef.current);
    objectUrlsRef.current = {};
    await clearAudioBlobs();
    setAudioCache({});
    setAudioPositions({});
  }

  return <main className="app">
    <button className="menu-toggle" onClick={() => setIsSidebarOpen(true)} type="button"><Menu size={22} /></button>
    {isSidebarOpen && <button className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} aria-label="Закрыть меню" type="button" />}
    <aside className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
      <div className="brand"><BookOpen /> <span>Audio Reader</span><button className="sidebar-close" onClick={() => setIsSidebarOpen(false)} type="button"><X size={18} /></button></div>
      <label className="upload"><Upload size={18} /> Загрузить EPUB/FB2<input type="file" accept=".epub,.fb2" onChange={handleFile} /></label>
      <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />} {theme === 'dark' ? 'Светлая тема' : 'Темная тема'}</button>
      <label>Глава<select value={currentSection} onChange={(event) => selectSection(event.target.value)} disabled={!book}>{book?.sections.map((section, index) => <option key={`${section.title}-${index}`} value={index}>{index + 1}. {section.title}</option>)}</select></label>
      <label>Голос<select value={voice} onChange={(event) => { setVoice(event.target.value); resetAudioCache(); }}>{voices.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Скорость генерации {rate}x<input type="range" min="0.5" max="2" step="0.1" value={rate} onChange={(event) => { setRate(event.target.value); resetAudioCache(); }} /></label>
      <label>Скорость плеера {playerRate}x<input type="range" min="0.5" max="2" step="0.1" value={playerRate} onChange={(event) => setPlayerRate(event.target.value)} /></label>
      <div className="player"><audio ref={audioRef} src={audioUrl} controls onPlay={restoreAudioPosition} onTimeUpdate={saveAudioPosition} onEnded={playNextBatch} onError={handleAudioError} /></div>
      <p className="status">{status}</p>
      <p className="status">Готово аудио: {Object.keys(audioCache).length} / 10</p>
      <div className="batch-list">
        <strong>Можно слушать</strong>
        {readyBatches.length ? readyBatches.map((index) => <button className="batch-list-item ready" key={index} onClick={() => selectBatch(index)} type="button">
          <span>#{index + 1}</span>
          <small>{batchPreview(batches[index])}</small>
        </button>) : <small className="muted">Пока нет готовых батчей</small>}
      </div>
      <div className="batch-list">
        <strong>Загружается</strong>
        {pendingBatches.length ? pendingBatches.sort((a, b) => a - b).map((index) => <div className="batch-list-item loading" key={index}>
          <span>#{index + 1}</span>
          <small>{batchPreview(batches[index])}</small>
        </div>) : <small className="muted">Нет активных загрузок</small>}
      </div>
    </aside>
    <section className="reader">
      {!book ? <div className="empty">Локальная читалка хранит последнюю книгу и прогресс до загрузки следующей.</div> : <>
        <header><h1>{book.title}</h1><p>{book.name} · батч {Math.min(currentBatch + 1, batches.length)} / {batches.length} · примерно 30 сек</p></header>
        {book.sections.map((section, index) => <article key={`${section.title}-${index}`} className={index === currentSection ? 'active-section' : ''}>
          <h2>{section.title}</h2>
          <SectionText section={section} sectionIndex={index} batches={batches} currentBatch={currentBatch} audioCache={audioCache} onSelectBatch={selectBatch} />
        </article>)}
      </>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
