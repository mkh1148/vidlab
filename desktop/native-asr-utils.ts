// Pure helpers shared between the native-ASR worker and its verification.
import type { DesktopAsrChunk } from '../shared/desktop-inference.ts';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import { ASR_MODELS } from '../shared/asr-models.ts';
import {
  whisperTokensToWordSpans,
  whisperWordsToWordSpans,
  type WhisperJsonSegment,
} from '../shared/whisper-tokens.ts';

export const NATIVE_ASR_SAMPLE_RATE = ASR_INFERENCE_CONTRACT.sampleRate;

// Every catalog tier that can run natively records its GGML companion in
// shared/asr-models.ts. The map that used to patch small/medium here named a
// `ggml-medium-q5_1.bin` that does not exist upstream (whisper.cpp ships
// medium as q5_0), so the desktop engine could never load it.
export function nativeGgmlFileName(modelId: string): string | undefined {
  return ASR_MODELS.find((model) => model.modelId === modelId)?.ggmlFile?.fileName;
}

export type { WhisperJson, WhisperJsonSegment, WhisperWordToken } from '../shared/whisper-tokens.ts';

export function whisperLanguage(language: string | undefined): string {
  const value = (language ?? '').trim().toLowerCase();
  if (!value || value === 'auto' || value === 'autodetect') return 'auto';
  if (value.startsWith('zh') || value === 'cmn' || value === 'yue') return 'zh';
  if (value.startsWith('en')) return 'en';
  return value.slice(0, 3);
}

// The token-to-word rule lives in shared/whisper-tokens.ts: the server
// transcription engine (D3a) reads the same whisper.cpp output and must split
// words identically, and the caption track D3b builds reads those word times.
// These two wrappers keep the desktop chunk contract (`DesktopAsrChunk`, ms)
// exactly as the worker and its verify expect it.

/** Project whisper.cpp token output into the desktop ASR chunk contract. */
export function whisperTokensToChunks(
  transcription: readonly WhisperJsonSegment[] | undefined,
): { text: string; chunks: DesktopAsrChunk[] } {
  const { text, words } = whisperTokensToWordSpans(transcription);
  return { text, chunks: words };
}

/** Project whisper.cpp server verbose_json words (BPE tokens) into the chunk contract. */
export function whisperWordsToChunks(
  words: readonly { word?: string; start?: number; end?: number }[] | undefined,
): DesktopAsrChunk[] {
  return whisperWordsToWordSpans(words);
}

export async function writeWav(samples: Float32Array, path: string): Promise<void> {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(NATIVE_ASR_SAMPLE_RATE, 24);
  header.writeUInt32LE(NATIVE_ASR_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.concat([header, pcm]));
}
