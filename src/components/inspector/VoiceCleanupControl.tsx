// The D2 inspector control: run voice clean-up on the selected clip, watch it
// progress, cancel it, run it again, and restore the original audio.
//
// Same division of responsibility as D1's BackgroundRemovalControl, because the
// same rule applies: start/poll are sessionless media operations, so this control
// is a VIEWER of a job that outlives it, not the owner of one. Only the mutation
// goes through the editor (`onApply`/`onClear` dispatch an undoable command), so
// the clip's cleaned track is revision-guarded exactly like every other edit.
//
// The artifact replaces the clip's audio in the mix at full strength: the job's
// output is already the cleaned voice, so a dry/wet blend would only re-introduce
// the noise the job removed. The original track stays on the clip (I4) and
// "Restore original" puts it back.
//
// Copy is English-keyed on purpose (the D surface is English; the keys are
// registered in the EN dictionary), so nothing here renders a Chinese literal.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import type { TimelineItem } from '../../editor/types';
import { VOICE_CLEANUP_ENGINE, denoisedSlotOwner } from '../../audio/denoisedSlot';
import { uploadNameOf } from '../../audio/isolateVoice';

const MOUNT = '/api/media-job/voice-cleanup';
const POLL_MS = 800;

/** The artifact is the cleaned voice; the mix plays it fully. */
const CLEANUP_STRENGTH = 100;

type JobStatus = 'queued' | 'deferred' | 'running' | 'completed' | 'failed' | 'cancelled';

interface JobState {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly progress: number;
  readonly phase: string | null;
  readonly error: string | null;
  readonly code: string | null;
  readonly artifactUrl: string | null;
  readonly engine: string | null;
}

function jobFromPayload(payload: Record<string, unknown>): JobState {
  const artifact = payload.artifact as { url?: string } | null | undefined;
  const key = String(payload.key ?? '');
  return {
    jobId: String(payload.jobId ?? ''),
    status: String(payload.status ?? 'queued') as JobStatus,
    progress: Number(payload.progress) || 0,
    phase: payload.phase ? String(payload.phase) : null,
    error: payload.error ? String(payload.error) : null,
    code: payload.code ? String(payload.code) : null,
    artifactUrl: artifact?.url ? String(artifact.url) : null,
    engine: key.includes(':') ? key.split(':')[0]! : null,
  };
}

export function VoiceCleanupControl({ item, sourceRevisionOf, onApply, onClear }: {
  item: TimelineItem;
  sourceRevisionOf: (item: TimelineItem) => string | null;
  onApply: (url: string, strength: number, engine?: string | null) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedRef = useRef<string | null>(null);
  // Only THIS engine's artifact makes this control active: D6's isolation writes the
  // same slot, and both controls reading "active" on one clip was the defect.
  const active = denoisedSlotOwner(item) === VOICE_CLEANUP_ENGINE;
  const sourceName = uploadNameOf(item.src);

  // Poll while the job is live. The interval is the only timer: the job outlives
  // this component, so nothing here is authoritative about the job's state.
  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return;
    const timer = setInterval(() => {
      void fetch(`${MOUNT}/jobs/${encodeURIComponent(job.jobId)}`)
        .then((response) => response.json())
        .then((payload: Record<string, unknown>) => setJob(jobFromPayload(payload)))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job]);

  // Apply once, when the artifact lands. The clip keeps its original source (I4);
  // this only changes which track the mix plays.
  useEffect(() => {
    if (!job || job.status !== 'completed' || !job.artifactUrl) return;
    if (appliedRef.current === job.jobId) return;
    appliedRef.current = job.jobId;
    onApply(job.artifactUrl, CLEANUP_STRENGTH, job.engine ?? VOICE_CLEANUP_ENGINE);
    showAppToast(t('Voice clean-up applied'));
  }, [job, onApply, t]);

  const start = useCallback(() => {
    if (!sourceName) return;
    setError(null);
    appliedRef.current = null;
    void fetch(`${MOUNT}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceName, revision: sourceRevisionOf(item) }),
    })
      .then(async (response) => ({ status: response.status, payload: await response.json() as Record<string, unknown> }))
      .then(({ status, payload }) => {
        if (status !== 202 || !payload.jobId) {
          setError(String(payload.error ?? `job start failed (${status})`));
          return;
        }
        setJob({
          jobId: String(payload.jobId),
          status: String(payload.status ?? 'queued') as JobStatus,
          progress: 0,
          phase: null,
          error: null,
          code: null,
          artifactUrl: null,
          engine: null,
        });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [sourceName, sourceRevisionOf, item]);

  const cancel = useCallback(() => {
    if (!job) return;
    void fetch(`${MOUNT}/jobs/${encodeURIComponent(job.jobId)}`, { method: 'DELETE' })
      .then((response) => response.json())
      .then((payload: Record<string, unknown>) => setJob(jobFromPayload(payload)))
      .catch(() => undefined);
  }, [job]);

  const restore = useCallback(() => {
    onClear();
    setJob(null);
    appliedRef.current = null;
    showAppToast(t('Original audio restored'));
  }, [onClear, t]);

  const live = job && (job.status === 'queued' || job.status === 'deferred' || job.status === 'running');
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
          {job?.error ?? t('Voice clean-up failed')}
          {job?.code ? ` (${job.code})` : ''}
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>{error}</div>}
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
            title={sourceName ? t('Clean up the speech on this device') : t('Import the clip into the media pool first')}
            onClick={start}
          >
            {active || failed ? t('Run again') : t('Clean up voice')}
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
          {t('This clip plays a cleaned voice track; its original audio is still on the clip.')}
        </div>
      )}
    </div>
  );
}
