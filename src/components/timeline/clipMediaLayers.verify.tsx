// AV1 C4: a detached video clip presents as picture-only in the timeline.
//
// The owner saw the opposite in the running app (2026-11-23): after Detach the
// video clip still drew its audio layer, because ClipMediaLayers rendered the wave
// strip whenever the source had peaks and never looked at `audioDetached`, and the
// filmstrip kept the 62% height that reserves room for that strip.
//
// This renders the real component with preview data in hand and pins the rule from
// both sides: the detached clip has no wave bar and a full-height filmstrip, the
// same clip before detach (and after merge) has both, and the detached AUDIO clip
// still shows the sound it carries.
//
// Run: npx tsx --tsconfig tsconfig.app.json src/components/timeline/clipMediaLayers.verify.tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineItem } from '../../editor/types';
import { isItemPictureOnly } from '../../editor/audioDetach';
import type { ClipPreview } from '../../media/clipPreview';
import { STRIP_RATIO, ClipMediaLayersView } from './ClipMediaLayers';

const video: TimelineItem = {
  id: 'v1', track: 'V1', kind: 'video', name: 'interview',
  src: '/media/uploads/interview.mp4', startFrame: 0, durationInFrames: 90, srcInFrame: 0,
} as TimelineItem;
const detachedVideo: TimelineItem = { ...video, audioDetached: true } as TimelineItem;
const detachedAudio: TimelineItem = {
  id: 'a1', track: 'A1', kind: 'audio', name: 'interview',
  src: '/media/uploads/interview.mp4', startFrame: 0, durationInFrames: 90, srcInFrame: 0,
  audioOfItemId: 'v1',
} as TimelineItem;

const preview: ClipPreview = {
  peaks: [0.2, 0.5, 0.9, 0.4, 0.1, 0.7, 0.3, 0.6],
  peaksPerSecond: 100,
  durationMs: 4000,
  stripUrl: '/api/filmstrip?src=%2Fmedia%2Fuploads%2Finterview.mp4',
  waveformStatus: 'ready',
  filmstripStatus: 'ready',
};

const geometryProps = {
  px: 4, fps: 30, height: 60, clipStartFrame: 0, durationInFrames: 90,
  srcInFrame: 0, playbackRate: 1, visibleWindow: { startFrame: 0, endFrame: 300 },
};
const render = (item: TimelineItem, data: ClipPreview | null = preview) =>
  renderToStaticMarkup(<ClipMediaLayersView item={item} preview={data} {...geometryProps} />);

const heights = (html: string) => [...html.matchAll(/height:([0-9.]+)%/g)].map((match) => match[1]);
const STRIP = `${STRIP_RATIO * 100}`;
const WAVE = `${(1 - STRIP_RATIO) * 100}`;

// ── the rule itself ─────────────────────────────────────────────────────────
assert.equal(isItemPictureOnly(detachedVideo), true, 'a detached video clip is picture-only');
assert.equal(isItemPictureOnly(video), false, 'a video clip that still has its audio is not');
assert.equal(isItemPictureOnly(detachedAudio), false, 'the detached audio clip is not picture-only');
assert.equal(isItemPictureOnly({ ...video, kind: 'image' } as TimelineItem), false, 'a still is not');

// ── before detach: filmstrip + wave, the 62/38 split ────────────────────────
const withSound = render(video);
assert.match(withSound, /class="cc-clip-wave on-video"/, 'a video clip with its own audio draws the wave layer');
assert.deepEqual(heights(withSound), [STRIP, WAVE],
  'the filmstrip takes the upper 62% and the wave strip the lower 38%');

// ── after detach: picture only, full height, no wave ────────────────────────
const pictureOnly = render(detachedVideo);
assert.doesNotMatch(pictureOnly, /cc-clip-wave/, 'a detached video clip draws NO wave layer');
assert.deepEqual(heights(pictureOnly), ['100'], 'and its filmstrip takes the full clip height');
assert.match(pictureOnly, /background-image:url\(\/api\/filmstrip/, 'the picture itself is still drawn');
assert.match(pictureOnly, /width:360px/, 'at the same geometry as before detach');

// ── the sound is on the audio clip, and that clip still shows it ────────────
const audioLayers = render(detachedAudio);
assert.match(audioLayers, /class="cc-clip-wave"/, 'the detached audio clip draws the wave it carries');
assert.doesNotMatch(audioLayers, /on-video/, 'on an audio lane, not over a filmstrip');
assert.deepEqual(heights(audioLayers), ['100'], 'the wave fills an audio clip (no filmstrip to share with)');

// ── merge restores the strip: the flag is the only input that changed ───────
const merged = render({ ...video, audioDetached: undefined } as TimelineItem);
assert.equal(merged, withSound, 'clearing the flag brings the wave strip back byte for byte');

// ── a clip with no audio track in its source is unchanged either way ────────
const silent: ClipPreview = { ...preview, peaks: [] };
assert.doesNotMatch(render(video, silent), /cc-clip-wave/, 'no peaks, no wave — the rule only removes a strip');
assert.deepEqual(heights(render(video, silent)), ['100'], 'and the filmstrip already had the full height');

// ── wiring: the lane renders the component, the chrome drops audio-only claims ──
const lane = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
assert.match(lane, /<ClipMediaLayers\b/, 'the clip band renders the media layers');
assert.match(lane, /item\.denoisedSrc && !isItemPictureOnly\(item\)/,
  'the voice-isolation badge is dropped on a picture-only clip (the sound carries it)');
const layers = readFileSync(new URL('./ClipMediaLayers.tsx', import.meta.url), 'utf8');
assert.match(layers, /const hasWave = !isItemPictureOnly\(item\) && preview\.peaks\.length > 0/,
  'the wave strip is gated on the one picture-only rule');
assert.match(layers, /useClipPreview\(props\.item\.src/, 'the hook wrapper still fetches the preview');

console.log('clipMediaLayers.verify: ok (detached video is picture-only, merge restores the strip, chrome sweep)');
