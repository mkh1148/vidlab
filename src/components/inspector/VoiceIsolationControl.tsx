// The D6 inspector control: separate the voice from music and background sound on
// the selected clip, watch the job, cancel it, and switch between the Original and
// the Processed track without re-running anything.
//
// Same division of responsibility as D1's matte control and D2's clean-up control:
// start/poll are sessionless media operations, so this is a VIEWER of a job that
// outlives it. Only the mutation goes through the editor (`onApply`/`onClear`
// dispatch undoable commands), so the clip's processed track is revision-guarded
// like every other edit.
//
// The switch is the kit's I4 requirement made visible: the artifact is a SECOND
// file beside the source, so Original (mix 0) and Processed (mix 100) are the same
// two files heard at different weights. Nothing is deleted when you switch, and
// nothing is re-rendered.
//
// Copy is English-keyed on purpose (the D surface is English; the keys are
// registered in the EN dictionary), so nothing here renders a Chinese literal.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import type { TimelineItem } from '../../editor/types';
import {
  VOICE_CLEANUP_ENGINE,
  VOICE_ISOLATION_ENGINE,
  denoisedSlotOwner,
} from '../../audio/denoisedSlot';
import {
  cancelVoiceIsolationJob,
  pollVoiceIsolationJob,
  startVoiceIsolationJob,
  uploadNameOf,
  voiceIsolationJobIsLive,
  type VoiceIsolationJobSnapshot,
} from '../../audio/isolateVoice';

const POLL_MS = 800;

/** The artifact IS the processed voice; the switch is what blends it. */
const PROCESSED = 100;
const ORIGINAL = 0;

/** Which engine produced the artifact this clip is playing, for the tag line. */
function engineLabel(owner: string | null): string {
  if (owner === VOICE_ISOLATION_ENGINE) return 'Spleeter 2stems + clean-up';
  if (owner === VOICE_CLEANUP_ENGINE) return 'RNNoise clean-up';
  if (owner === 'legacy') return 'an older build';
  return owner ?? '';
}

export function VoiceIsolationControl({ item, sourceRevisionOf, onApply, onClear }: {
  item: TimelineItem;
  /** The source revision the artifact identity is built from (backlog: revision arg). */
  sourceRevisionOf: (item: TimelineItem) => string | null;
  onApply: (url: string, strength: number, engine?: string | null) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [job, setJob] = useState<VoiceIsolationJobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const appliedRef = useRef<string | null>(null);
  const owner = denoisedSlotOwner(item);
  const active = owner === VOICE_ISOLATION_ENGINE;
  const foreign = owner !== null && !active;
  const sourceName = uploadNameOf(item.src);
  const processed = (item.denoiseStrength ?? PROCESSED) >= 50;

  // Poll while the job is live. The job outlives this component, so nothing here
  // is authoritative about its state.
  useEffect(() => {
    if (!voiceIsolationJobIsLive(job) || !job) return;
    const timer = setInterval(() => {
      void pollVoiceIsolationJob(job.jobId)
        .then((next) => setJob(next))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job]);

  // Apply once, when the artifact lands. The clip keeps its original source (I4);
  // this only changes which track the mix plays, and at what weight.
  useEffect(() => {
    if (!job || job.status !== 'completed' || !job.artifactUrl) return;
    if (appliedRef.current === job.jobId) return;
    appliedRef.current = job.jobId;
    onApply(job.artifactUrl, PROCESSED, job.engine ?? VOICE_ISOLATION_ENGINE);
    if (job.startedAt !== null && job.finishedAt !== null) {
      setElapsedMs(job.finishedAt - job.startedAt);
    }
    showAppToast(t('Voice isolation applied'));
  }, [job, onApply, t]);

  const start = useCallback(() => {
    if (!sourceName) return;
    setError(null);
    setElapsedMs(null);
    appliedRef.current = null;
    void startVoiceIsolationJob({
      sourceName,
      revision: sourceRevisionOf(item),
    })
      .then((snapshot) => setJob(snapshot))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [sourceName, sourceRevisionOf, item]);

  const cancel = useCallback(() => {
    if (!job) return;
    void cancelVoiceIsolationJob(job.jobId)
      .then((snapshot) => setJob(snapshot))
      .catch(() => undefined);
  }, [job]);

  const restore = useCallback(() => {
    onClear();
    setJob(null);
    setElapsedMs(null);
    appliedRef.current = null;
    showAppToast(t('Original audio restored'));
  }, [onClear, t]);

  const switchTo = useCallback((strength: number) => {
    if (!item.denoisedSrc) return;
    // Two arguments on purpose: an omitted engine keeps the tag the artifact already
    // carries, because the switch changes the mix, not the engine that produced it.
    onApply(item.denoisedSrc, strength);
  }, [item.denoisedSrc, onApply]);

  const live = voiceIsolationJobIsLive(job);
  const deferred = job?.status === 'deferred';
  const failed = job?.status === 'failed';
  const percent = Math.round((job?.progress ?? 0) * 100);

  return (
    <div>
      {live && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ height: 4, background: 'var(--cc-border, #333)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--cc-accent, #4c8dff)' }} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>
            {deferred
              ? t('Deferred - waiting for memory')
              : `${percent}%${job?.phase ? ` · ${job.phase}` : ''}`}
          </div>
        </div>
      )}
      {failed && (
        <div style={{ fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>
          {job?.error ?? t('Voice isolation failed')}
          {job?.code ? ` (${job.code})` : ''}
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>{error}</div>}

      {active && !live && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <button
            type="button"
            className="cc-insp-btn"
            style={{ flex: 1, fontSize: 11, opacity: processed ? 0.55 : 1 }}
            aria-pressed={!processed}
            onClick={() => switchTo(ORIGINAL)}
          >
            {t('Original')}
          </button>
          <button
            type="button"
            className="cc-insp-btn"
            style={{ flex: 1, fontSize: 11, opacity: processed ? 1 : 0.55 }}
            aria-pressed={processed}
            onClick={() => switchTo(PROCESSED)}
          >
            {t('Processed')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        {live ? (
          <button type="button" className="cc-insp-btn" style={{ flex: 1, fontSize: 11 }} onClick={cancel}>
            {t('Cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="cc-insp-btn"
            style={{ flex: 1, fontSize: 11 }}
            disabled={!sourceName}
            title={sourceName
              ? t('Separate the voice from music and background sound on this device')
              : t('Import the clip into the media pool first')}
            onClick={start}
          >
            {active || failed ? t('Run again') : t('Separate voice')}
          </button>
        )}
        {active && !live && (
          <button type="button" className="cc-insp-btn" style={{ fontSize: 11 }} onClick={restore}>
            {t('Restore original')}
          </button>
        )}
      </div>

      {active && (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          {processed
            ? t('Playing the separated voice track; the original audio stays on the clip.')
            : t('Playing the original audio; the separated track is kept beside it.')}
        </div>
      )}
      {foreign && (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          {t('This clip already plays a voice track from {engine}.', { engine: t(engineLabel(owner)) })}
        </div>
      )}
      {active && (
        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>
          {t('Engine')}: {engineLabel(owner)}
          {elapsedMs !== null ? ` · ${t('processed in {s} s', { s: (elapsedMs / 1000).toFixed(1) })}` : ''}
        </div>
      )}
    </div>
  );
}
