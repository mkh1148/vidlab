// The D1 inspector control: run background removal on the selected clip, watch it
// progress, cancel it, run it again, and restore the original picture.
//
// It talks to the server job route directly (the same route pair the agent tools
// use) because start/poll are sessionless media operations — the control is a
// viewer of a job that outlives it, not the owner of one. Only the mutation goes
// through the editor: `onApply`/`onClear` dispatch the undoable command, so the
// clip's derived picture is revision-guarded exactly like every other edit.
//
// Copy is English-keyed on purpose (the D surface is English; the keys are
// registered in the EN dictionary), so nothing here renders a Chinese literal.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import type { TimelineItem } from '../../editor/types';

const MOUNT = '/api/media-job/background-removal';
const POLL_MS = 800;

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

/** The upload name behind a `/media/uploads/…` source, or null. */
function uploadNameOf(src: string | undefined): string | null {
  if (!src) return null;
  const match = /^\/media\/uploads\/([^/?#]+)/.exec(src);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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

export function BackgroundRemovalControl({ item, sourceRevisionOf, onApply, onClear }: {
  item: TimelineItem;
  /** The source revision the artifact identity is built from (a re-import is a new artifact). */
  sourceRevisionOf: (item: TimelineItem) => string | null;
  onApply: (url: string, engine: string | null) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedRef = useRef<string | null>(null);
  const active = Boolean(item.derivedPictureSrc);
  const sourceName = uploadNameOf(item.src);

  // Poll while the job is live. The interval is the only timer: a job outlives
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

  // Apply once, when the artifact lands. The clip keeps its original source for
  // audio and every fallback (I4); this only changes the picture.
  useEffect(() => {
    if (!job || job.status !== 'completed' || !job.artifactUrl) return;
    if (appliedRef.current === job.jobId) return;
    appliedRef.current = job.jobId;
    onApply(job.artifactUrl, job.engine);
    showAppToast(t('Background removal applied'));
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
    showAppToast(t('Original picture restored'));
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
          {job?.error ?? t('Background removal failed')}
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
            title={sourceName ? t('Remove the background on this device') : t('Import the clip into the media pool first')}
            onClick={start}
          >
            {active || failed ? t('Run again') : t('Remove background')}
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
          {t('This clip shows a cut-out picture; its audio is still the original source.')}
        </div>
      )}
    </div>
  );
}
