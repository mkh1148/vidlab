// EN dictionary assembly (single source of truth): files are divided into fields, key=Chinese original text, value=English.
// Each field file is filled exclusively by the corresponding scanning and swapping work line and does not touch each other to avoid merge conflicts.
import audio from './audio';
import backgroundRemoval from './backgroundRemoval';
import b2 from './b2';
import captionTrack from './captionTrack';
import captions from './captions';
import chat from './chat';
import components from './components';
import editor from './editor';
import exportPanel from './exportPanel';
import faceRetouch from './faceRetouch';
import fx from './fx';
import generate from './generate';
import library from './library';
import media from './media';
import progress from './progress';
import proposal from './proposal';
import review from './review';
import script from './script';
import settings from './settings';
import sounds from './sounds';
import timeline from './timeline';
import topbar from './topbar';
import transcript from './transcript';
import voiceCleanup from './voiceCleanup';
import voiceIsolation from './voiceIsolation';

export const EN: Record<string, string> = Object.assign(
  {},
  audio, backgroundRemoval, b2, captionTrack, captions, chat, components, editor, exportPanel, faceRetouch, fx, generate,
  library, media, progress, proposal, review, script, settings, sounds, timeline, topbar, transcript,
  voiceCleanup, voiceIsolation,
);
