import { describe, expect, it } from 'vitest';
import { extensionFor, transcribe } from '../src/voice/service.js';

/**
 * Every voice turn failed with 400 "Audio file might be corrupted or
 * unsupported". The recording was fine — 18KB to 129KB of clean audio, with
 * speech and silence correctly detected — and the upload carried the MIME
 * type a browser MediaRecorder reports, `audio/webm;codecs=opus`, verbatim.
 * The codec parameter alone was enough to have the file rejected.
 */
const CFG = { apiKey: 'sk-test', sttModel: 'whisper-1', ttsModel: 't', voice: 'v' } as Parameters<
  typeof transcribe
>[2];

function capturingFetch(statuses: number[]) {
  const uploads: { type: string; filename: string }[] = [];
  let n = 0;
  const doFetch = (async (_url: unknown, init: { body: FormData }) => {
    const file = init.body.get('file') as File;
    uploads.push({ type: file.type, filename: file.name });
    const status = statuses[n++] ?? 200;
    return status === 200
      ? new Response(JSON.stringify({ text: 'how much is the snowboard' }), { status: 200 })
      : new Response('{"error":{"message":"Audio file might be corrupted or unsupported"}}', { status });
  }) as unknown as typeof fetch;
  return { doFetch, uploads };
}

describe('transcription upload', () => {
  it('strips the codec parameter a MediaRecorder reports', async () => {
    const { doFetch, uploads } = capturingFetch([200]);
    await transcribe(Buffer.from('audio'), 'audio/webm;codecs=opus', CFG, doFetch);
    expect(uploads[0]).toEqual({ type: 'audio/webm', filename: 'turn.webm' });
  });

  it('retries webm as ogg when the container is refused', async () => {
    // Both are the same opus stream in a different wrapper, and a
    // MediaRecorder webm carries no duration in its header.
    const { doFetch, uploads } = capturingFetch([400, 200]);
    const text = await transcribe(Buffer.from('audio'), 'audio/webm;codecs=opus', CFG, doFetch);
    expect(uploads.map((u) => u.filename)).toEqual(['turn.webm', 'turn.ogg']);
    expect(text).toBe('how much is the snowboard');
  });

  it('does not retry a format that is not ambiguous', async () => {
    const { doFetch, uploads } = capturingFetch([400]);
    await expect(transcribe(Buffer.from('a'), 'audio/mp4', CFG, doFetch)).rejects.toThrow();
    expect(uploads).toHaveLength(1);
  });

  it('does not retry forever when both attempts fail', async () => {
    const { doFetch, uploads } = capturingFetch([400, 400]);
    await expect(transcribe(Buffer.from('a'), 'audio/webm', CFG, doFetch)).rejects.toThrow(
      /corrupted or unsupported/,
    );
    expect(uploads).toHaveLength(2);
  });

  /**
   * Auto-detection reads the language off a second of a shopper in a noisy
   * room and gets it wrong: a spoken English question came back transcribed
   * in Urdu script, and the model then answered in Urdu — correctly, to
   * someone who had spoken English. A storefront has one language and we
   * know it, so there is nothing to detect.
   */
  it('tells transcription the language instead of letting it guess', async () => {
    const langs: (string | null)[] = [];
    const doFetch = (async (_u: unknown, init: { body: FormData }) => {
      langs.push(init.body.get('language') as string | null);
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as unknown as typeof fetch;

    await transcribe(Buffer.from('a'), 'audio/webm', { ...CFG, language: 'en' }, doFetch);
    expect(langs).toEqual(['en']);
  });

  it('restores auto-detection when the language is cleared', async () => {
    // An genuinely multilingual storefront sets VOICE_LANGUAGE to empty.
    const langs: (string | null)[] = [];
    const doFetch = (async (_u: unknown, init: { body: FormData }) => {
      langs.push(init.body.get('language') as string | null);
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as unknown as typeof fetch;

    await transcribe(Buffer.from('a'), 'audio/webm', { ...CFG, language: '' }, doFetch);
    expect(langs).toEqual([null]);
  });

  it('names the file for its container, not its codec', () => {
    expect(extensionFor('audio/webm')).toBe('webm');
    expect(extensionFor('audio/ogg')).toBe('ogg');
    expect(extensionFor('audio/mp4')).toBe('mp4');
  });
});
