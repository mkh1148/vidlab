// D3b · the caption track that follows transcripts.
//
// What this pins down, in the order the kit states it:
//
//   1. the join: ONE undoable editor command binds a caption track to a clip's
//      STORED transcript, creating the track when there is none, and refusing with a
//      code (never guessing) when the clip has nothing to caption;
//   2. "trimming a clip trims its captions" — MEASURED, not asserted: the track holds
//      no words, so the words come from the clip's current trim/edit state, and a trim
//      that cuts into a word clamps it while a trim past it drops it;
//   3. "a caption never mixes words from two clips or from both sides of a cut" — as a
//      PAGINATION rule (a hard page break at every clip-origin change), proven on the
//      four cases the mandate names — trim into the middle of a caption, split at a
//      caption boundary, two clips from the same source, two clips from different
//      sources butted together — plus the cut that lands INSIDE a word (section 6);
//   4. a re-transcription re-times and re-texts the captions with NO caption command at
//      all — the strongest form of "follows the transcript";
//   5. moving a clip moves its captions; deleting it drops the binding and keeps the
//      track (rebindable), and neither leaves a page behind;
//   6. the single-source path is unchanged: no origin change, no extra break.
//
// Run: npx tsx src/captions/captionTrack.verify.ts
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { buildCommands } from '../editor/storeCommandBuilder';
import { historyReduce, type History } from '../editor/reduce';
import { activeTimeline, captionTrackEntries, type ProjectDoc } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { buildCaptionPages } from './captionPages';
import { captionTrackPlan } from './captionTrack';
import type { CaptionsData } from './types';
import { makeDraft } from '../editor/store';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from '../agent/context';
import { execCaptionsTool } from '../agent/tools/captions-tools';
import { CAPTIONS_TOOL_SCHEMAS } from '../agent/tools/schemas/captions-tools';

const FPS = 30;
const words = (...texts: string[]): TranscriptWord[] =>
  texts.map((text, index) => ({ id: `w${index}`, text, start: index * 500, end: index * 500 + 500 }));

const TR_A = words('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve');
const TR_B = words('red', 'green', 'blue', 'cyan', 'magenta', 'yellow');

function project(items: ProjectDoc['timelines'][number]['items'], tracks: ProjectDoc['timelines'][number]['tracks'] = {}): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline',
    timelines: [{
      id: 'timeline', name: 'main', order: 0, fps: FPS, width: 1920, height: 1080,
      items, selectedId: null,
      trackOrder: ['track_v1', 'track_a1'],
      tracks: { track_v1: { kind: 'video' }, track_a1: { kind: 'audio' }, ...tracks },
    }],
  };
}

const audio = (id: string, startFrame: number, durationInFrames: number, transcript: TranscriptWord[], extra = {}) => ({
  id, track: 'track_a1', startFrame, durationInFrames, name: id, kind: 'audio' as const,
  src: '/media/uploads/speech.mp3', transcript, ...extra,
});

const harness = (doc: ProjectDoc) => {
  let history: History = { past: [], present: structuredClone(doc), future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  return {
    commands,
    get state() { return activeTimeline(history.present); },
    get depth() { return history.past.length; },
    undo() { history = historyReduce(history, { type: 'undo' }); },
    redo() { history = historyReduce(history, { type: 'redo' }); },
    dispatch(action: Parameters<typeof historyReduce>[1]) { history = historyReduce(history, action); },
  };
};

const pagesOf = (state: ReturnType<typeof activeTimeline>, trackId: string) => {
  const captions = state.tracks?.[trackId]?.captions as CaptionsData | undefined;
  assert.ok(captions, `track ${trackId} must carry captions`);
  return buildCaptionPages(captions, state.items, FPS);
};
const pageText = (page: { words: { text: string }[] }) => page.words.map((word) => word.text).join(' ');
const captionTracks = (state: ReturnType<typeof activeTimeline>) => captionTrackEntries(state);

// ── 1. refusals: the join never guesses ─────────────────────────────────────
{
  const h = harness(project([
    audio('clip_ok', 0, 180, TR_A),
    audio('clip_stale', 180, 60, TR_A.slice(0, 2), { transcriptStale: true }),
    audio('clip_empty', 240, 60, []),
    { id: 'clip_image', track: 'track_v1', startFrame: 0, durationInFrames: 60, name: 'still', kind: 'image' as const, src: '/media/uploads/x.png' },
  ]));
  assert.deepEqual(
    (({ ok, code }) => ({ ok, code }))(captionTrackPlan(h.state, 'nope') as never),
    { ok: false, code: 'item_missing' },
    'an id that is not on the timeline is a refusal, not an empty track',
  );
  assert.equal((captionTrackPlan(h.state, 'clip_image') as { code: string }).code, 'not_speech_media');
  assert.equal((captionTrackPlan(h.state, 'clip_stale') as { code: string }).code, 'transcript_stale',
    'a stale transcript is review-only and must never drive captions');
  assert.equal((captionTrackPlan(h.state, 'clip_empty') as { code: string }).code, 'no_transcript');
  const refused = h.commands.captionTrackFromTranscript('clip_empty');
  assert.equal(refused.ok, false);
  assert.equal(h.depth, 0, 'a refusal writes nothing');
  assert.equal(captionTracks(h.state).length, 0, 'and creates no track');
}

// ── 2. create: one command, one undo step, captions resolve from the transcript ──
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  assert.ok(created.ok && created.created, 'the first call creates the track');
  const trackId = created.ok ? created.trackId : '';
  assert.equal(h.depth, 1, 'track.create + setCaptions are ONE undo step');
  assert.equal(captionTracks(h.state).length, 1);
  assert.equal(h.state.tracks?.[trackId]?.kind, 'caption');
  const captions = h.state.tracks?.[trackId]?.captions as CaptionsData;
  assert.equal(captions.sourceItemId, 'clip_ok', 'the track stores the BINDING, not the words');
  assert.equal(captions.words, undefined, 'and no word copies — that is what makes trims follow');
  assert.equal(captions.enabled, true);

  const pages = pagesOf(h.state, trackId);
  assert.deepEqual(pages.map((page) => pageText(page.page)), ['one two three four five six', 'seven eight nine ten eleven twelve']);

  h.undo();
  assert.equal(captionTracks(h.state).length, 0, 'undo removes the track');
  h.redo();
  assert.equal(captionTracks(h.state).length, 1, 'redo restores it');
  assert.equal(pagesOf(h.state, trackId).length, 2, 'and the captions come back with it');
}

// ── 3. refresh is idempotent: no phantom history step ───────────────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const first = h.commands.captionTrackFromTranscript('clip_ok');
  const depth = h.depth;
  const again = h.commands.captionTrackFromTranscript('clip_ok');
  assert.ok(first.ok && again.ok);
  assert.equal(again.created, false, 'the second call finds the bound track');
  assert.equal(again.changed, false, 'and nothing changed');
  assert.equal(h.depth, depth, 'so it is not a history step');

  // Turning the track off and refreshing turns it back on — one step, look intact.
  const trackId = first.ok ? first.trackId : '';
  h.commands.updateCaptions({ enabled: false }, trackId);
  const before = h.depth;
  const refreshed = h.commands.captionTrackFromTranscript('clip_ok');
  assert.ok(refreshed.ok && refreshed.changed);
  assert.equal(h.depth, before + 1);
  const captions = h.state.tracks?.[trackId]?.captions as CaptionsData;
  assert.equal(captions.enabled, true);
  assert.equal(captions.template, 'plain', 'refresh never resets the look');
}

// ── 4. re-transcription flows through with NO caption command ───────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  const trackId = created.ok ? created.trackId : '';
  const before = pagesOf(h.state, trackId).map((page) => pageText(page.page));

  // The D3a apply path: one command, the clip's transcript replaced.
  h.commands.setItemTranscript('clip_ok', words('alpha', 'bravo', 'charlie'));
  const after = pagesOf(h.state, trackId).map((page) => pageText(page.page));
  assert.deepEqual(after, ['alpha bravo charlie'], 'the captions follow the new transcript');
  assert.notDeepEqual(after, before);
  assert.equal(captionTracks(h.state).length, 1, 'and no second track appeared');
  h.undo();
  assert.deepEqual(pagesOf(h.state, trackId).map((page) => pageText(page.page)), before,
    'undoing the re-transcription restores the old captions too');
}

// ── 5. trim into the middle of a caption ────────────────────────────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  const trackId = created.ok ? created.trackId : '';

  // Trim the head so the clip starts 20 frames in: "one" (0-500 ms = 0-15 frames) is
  // entirely outside, "two" (500-1000 ms = 15-30 frames) straddles the cut.
  h.dispatch({ type: 'retime', id: 'clip_ok', srcInFrame: 20, durationInFrames: 160 });
  const trimmed = pagesOf(h.state, trackId);
  const flat = trimmed.flatMap((page) => page.page.words.map((word) => word.text));
  assert.ok(!flat.includes('one'), 'a word entirely outside the trim is gone');
  assert.ok(flat.includes('two'), 'a word the trim cuts into survives, clamped to the trim');
  const two = trimmed.flatMap((page) => page.page.words).find((word) => word.text === 'two')!;
  assert.equal(two.start, 0, 'and it starts at the new clip head, not at its source time');
  assert.equal(trimmed[0]!.page.start, 0);

  // Trim the tail: the words past the new out-point go with it. The exact clamp at
  // the boundary is the base's existing projection rule (a word that touches the
  // window edge is kept), so the assertion is the semantic one: nothing from outside
  // the trim survives, the survivors are a contiguous slice, and every page sits
  // inside the clip.
  h.dispatch({ type: 'retime', id: 'clip_ok', srcInFrame: 20, durationInFrames: 40 });
  const tail = pagesOf(h.state, trackId);
  const tailWords = tail.flatMap((page) => page.page.words.map((word) => word.text));
  assert.ok(!tailWords.includes('one'), 'nothing before the in-point survives');
  assert.ok(!tailWords.includes('twelve'), 'nothing after the out-point survives');
  assert.ok(tailWords.length > 0 && tailWords.length < TR_A.length, 'the trim shortened the captions');
  const slice = TR_A.map((word) => word.text).slice(
    TR_A.findIndex((word) => word.text === tailWords[0]),
    TR_A.findIndex((word) => word.text === tailWords[0]) + tailWords.length,
  );
  assert.deepEqual(tailWords, slice, 'the survivors are one contiguous slice of the transcript');
  for (const page of tail) {
    assert.ok(page.page.start >= 0 && page.page.end <= 40 * (1000 / FPS) + 1,
      `a page escaped the trimmed clip: ${page.page.start}-${page.page.end}`);
  }
}

// ── 6. split at a caption boundary, and split mid-word ──────────────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  const trackId = created.ok ? created.trackId : '';

  // 12 words = 6000 ms = 180 frames. Cut at frame 90 = between "six" and "seven".
  h.dispatch({ type: 'split', id: 'clip_ok', atFrame: 90, newId: 'clip_right' });
  const state = h.state;
  assert.equal(state.items.length, 2);
  const captions = state.tracks?.[trackId]?.captions as CaptionsData;
  assert.deepEqual(captions.sources, ['clip_ok', 'clip_right'],
    'both halves stay captioned — the split binds the fragment, it does not drop it');
  const pages = pagesOf(state, trackId);
  assert.deepEqual(pages.map((page) => pageText(page.page)), ['one two three four five six', 'seven eight nine ten eleven twelve']);
  // The invariant, structurally: no page may contain words from both halves.
  const left = new Set(state.items.find((item) => item.id === 'clip_ok')!.transcript!.map((word) => word.text));
  for (const page of pages) {
    const fromLeft = page.page.words.filter((word) => left.has(word.text)).length;
    assert.ok(fromLeft === 0 || fromLeft === page.page.words.length,
      `a page mixed the two sides of the cut: ${pageText(page.page)}`);
  }

  // The same cut through the MIDDLE of a word. 12 words = 180 frames, 15 frames each,
  // so frame 22 falls inside "two" (500-1000 ms = frames 15-30). Measured behaviour:
  // the split divides the transcript at the cut, so the straddling word belongs to the
  // LEFT half and is clamped to the cut; the right half starts at the next word. The
  // word is neither duplicated nor dropped, and the page break still sits on the cut.
  const mid = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const midCreated = mid.commands.captionTrackFromTranscript('clip_ok');
  const midTrack = midCreated.ok ? midCreated.trackId : '';
  mid.dispatch({ type: 'split', id: 'clip_ok', atFrame: 22, newId: 'clip_right' });
  const midPages = pagesOf(mid.state, midTrack);
  const cutMs = 22 * (1000 / FPS);
  const straddling = midPages.flatMap((page) => page.page.words).filter((word) => word.text === 'two');
  assert.equal(straddling.length, 1, 'a word the cut runs through appears exactly once, not once per half');
  assert.equal(straddling[0]!.start, 500, 'it keeps its source start');
  assert.equal(Math.round(straddling[0]!.end), Math.round(cutMs), 'and is clamped to the cut');
  assert.deepEqual(
    midPages.map((page) => pageText(page.page)),
    ['one two', 'three four five six seven eight', 'nine ten eleven twelve'],
    'the cut re-cuts the page, it does not stretch one across both halves',
  );
  assert.ok(midPages[0]!.page.end <= cutMs + 1, 'the first page ends at the cut');
  assert.ok(midPages[1]!.page.start >= cutMs - 1, 'and the second page starts there');
  const midLeft = new Set(mid.state.items.find((item) => item.id === 'clip_ok')!.transcript!.map((word) => word.text));
  for (const page of midPages) {
    const fromLeft = page.page.words.filter((word) => midLeft.has(word.text)).length;
    assert.ok(fromLeft === 0 || fromLeft === page.page.words.length,
      `a page mixed the two sides of a mid-word cut: ${pageText(page.page)}`);
  }
}

// ── 7. two clips from the SAME source, butted together ──────────────────────
{
  const h = harness(project([
    audio('clip_a', 0, 90, TR_A.slice(0, 6)),
    audio('clip_b', 90, 90, TR_A.slice(6), { srcInFrame: 0 }),
  ]));
  // A timeline-wide caption track: the case where the base used to merge every
  // clip's words into one stream and paginate straight across the cut.
  h.commands.setCaptions({ enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'timeline' });
  const trackId = captionTracks(h.state)[0]!.id;
  const pages = pagesOf(h.state, trackId);
  assert.deepEqual(pages.map((page) => pageText(page.page)), ['one two three four five six', 'seven eight nine ten eleven twelve'],
    'same-source clips are captioned separately and never share a page');
}

// ── 8. two clips from DIFFERENT sources, butted together ────────────────────
{
  const h = harness(project([
    audio('clip_a', 0, 90, TR_A.slice(0, 6)),
    audio('clip_b', 90, 90, TR_B),
  ]));
  h.commands.setCaptions({ enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'timeline' });
  const trackId = captionTracks(h.state)[0]!.id;
  const pages = pagesOf(h.state, trackId);
  assert.deepEqual(pages.map((page) => pageText(page.page)), ['one two three four five six', 'red green blue cyan magenta yellow']);
  for (const page of pages) {
    const texts = page.page.words.map((word) => word.text);
    const a = texts.filter((text) => TR_A.some((word) => word.text === text)).length;
    assert.ok(a === 0 || a === texts.length, `a page mixed two clips: ${texts.join(' ')}`);
  }

  // And a short clip butted against a long one: the page budget would have merged
  // them, which is exactly the case the origin break closes.
  const short = harness(project([
    audio('clip_c', 0, 30, words('alpha', 'bravo')),
    audio('clip_d', 30, 60, words('echo', 'foxtrot', 'golf')),
  ]));
  short.commands.setCaptions({ enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'timeline' });
  const shortTrack = captionTracks(short.state)[0]!.id;
  assert.deepEqual(pagesOf(short.state, shortTrack).map((page) => pageText(page.page)),
    ['alpha bravo', 'echo foxtrot golf'],
    'a 2-word clip and a 3-word clip fit one page budget but never one page');
}

// ── 9. move and delete ──────────────────────────────────────────────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  const trackId = created.ok ? created.trackId : '';
  const before = pagesOf(h.state, trackId)[0]!.page.start;
  h.dispatch({ type: 'move', id: 'clip_ok', startFrame: 300 });
  assert.equal(pagesOf(h.state, trackId)[0]!.page.start, before + 300 * (1000 / FPS),
    'moving the clip moves its captions by the same amount');

  h.dispatch({ type: 'remove', id: 'clip_ok' });
  assert.equal(captionTracks(h.state).length, 1, 'deleting the clip keeps the track — it is rebindable');
  const captions = h.state.tracks?.[trackId]?.captions as CaptionsData;
  assert.equal(captions.sourceItemId, undefined, 'and drops the dangling binding');
  assert.equal(buildCaptionPages(captions, h.state.items, FPS).length, 0, 'with no words left behind');
}

// ── 10. the single-source path is unchanged ─────────────────────────────────
{
  const h = harness(project([audio('clip_ok', 0, 180, TR_A)]));
  const created = h.commands.captionTrackFromTranscript('clip_ok');
  const trackId = created.ok ? created.trackId : '';
  const pages = pagesOf(h.state, trackId);
  assert.deepEqual(pages.map((page) => [page.page.start, page.page.end]), [[0, 3000], [3000, 6000]],
    'one clip, one origin: the pre-D3b pagination, unchanged');
}

// ── 11. multi-lane sources never mix either ─────────────────────────────────
{
  const h = harness(project([
    audio('clip_a', 0, 30, words('alpha', 'bravo')),
    audio('clip_b', 30, 60, words('echo', 'foxtrot', 'golf')),
  ]));
  h.commands.setCaptions({
    enabled: true, template: 'plain', pacing: 'phrase',
    sourceEntries: [
      { id: 'lane_a', itemId: 'clip_a', trackOrder: 0 },
      { id: 'lane_b', itemId: 'clip_b', trackOrder: 1 },
    ],
  });
  const trackId = captionTracks(h.state)[0]!.id;
  const pages = pagesOf(h.state, trackId);
  assert.deepEqual(pages.map((page) => [page.laneId, pageText(page.page)]),
    [['lane_a', 'alpha bravo'], ['lane_b', 'echo foxtrot golf']],
    'each lane paginates its own clip, so a lane cannot mix clips by construction');
}

// ── 12. the agent tool: one action on the existing caption tool group ───────
// The tool group keeps ONE schema module (H6): the join is an `edit_captions` action,
// not a second tool, because a second tool for the same domain would split routing
// (tool-routing.ts already sends caption keywords here) and duplicate target
// resolution. What this section proves is that an agent can create AND refresh a
// track, and that a refusal comes back as a code instead of a silent no-op.
{
  const draft = makeDraft(docFromTimeline(activeTimeline(project([audio('clip_ok', 0, 180, TR_A)]))));
  const ctx: AgentContext = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  };
  const schema = CAPTIONS_TOOL_SCHEMAS.find((entry) => entry.name === 'edit_captions')!;
  assert.ok(
    (schema.input_schema.properties as Record<string, { enum?: string[] }>).action?.enum?.includes('track_from_transcript'),
    'the action is advertised in the schema the agent reads',
  );

  const created = await execCaptionsTool('edit_captions', { action: 'track_from_transcript', json: { itemId: 'clip_ok' } }, ctx) as {
    ok: boolean; captionTrackId: string; captionTrackAlias: string; created: boolean; pageCount: number;
  };
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.captionTrackAlias, 'C1');
  assert.equal(created.pageCount, 2, 'the tool reports the real page count, not the word count');

  const again = await execCaptionsTool('edit_captions', { action: 'track_from_transcript', json: { itemId: 'clip_ok' } }, ctx) as {
    ok: boolean; created: boolean; changed: boolean;
  };
  assert.equal(again.created, false, 'a second call refreshes rather than duplicating the track');
  assert.equal(again.changed, false);
  assert.equal(captionTrackEntries(draft.getState()).length, 1);

  const refused = await execCaptionsTool('edit_captions', { action: 'track_from_transcript', json: { itemId: 'nope' } }, ctx) as {
    error?: string; code?: string;
  };
  assert.equal(refused.code, 'item_missing', 'a refusal is a code the agent can branch on');
  assert.ok(refused.error);
}

console.log('captionTrack.verify: join, refusals, trim, split, same/different source, move, delete, re-transcription, agent tool — OK');