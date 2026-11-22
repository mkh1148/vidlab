// The D4 inspector control: analyze a face, watch it progress, cancel it, run it
// again, apply the result to the clip, and restore the original picture.
//
// Same division of responsibility as D1's BackgroundRemovalControl, with one
// difference that comes from the model rather than from taste: the pass runs HERE,
// in the renderer, because the MediaPipe runtime needs a DOM canvas (docs/
// d-job-implementation.md §D4). The server is still the owner of the artifact, so the
// control's last step is a POST, and only the mutation goes through the editor —
// `onApply`/`onClear` dispatch the undoable command, so the clip's face references
// are revision-guarded like every other edit.
//
// The sliders are not duplicated here: applying the analysis also adds the
// `builtin:fx-face-retouch` effect when the clip has none, and the effect stack above
// renders one slider per parameter through the existing undoable `setEffects`
// command. One slider definition, one command, no second copy to drift.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import type { TimelineItem } from '../../editor/types';
import {
  FaceAnalysisRunError,
  cachedFaceAnalysis,
  faceAnalysisIdentity,
  forgetFaceAnalysis,
  openAnalysisVideo,
  runFaceAnalysis,
  type FaceAnalysisArtifacts,
} from '../../face/faceAnalysisClient';
import type { FaceAnalysisProgress } from '../../face/analyzeFace';

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

type Phase = 'idle' | 'running' | 'ready' | 'failed';

export function FaceRetouchControl({ item, fps, onApply, onClear, onAddEffect }: {
  item: TimelineItem;
  /** Project frame rate — the clock the track's source frames are counted in. */
  fps: number;
  onApply: (trackUrl: string, atlasUrl: string, engine: string | null) => void;
  onClear: () => void;
  /** Add the retouch effect when the clip has none, so its sliders appear. */
  onAddEffect: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<FaceAnalysisProgress | null>(null);
  const [cached, setCached] = useState<FaceAnalysisArtifacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const appliedRef = useRef(false);
  const active = Boolean(item.faceTrackUrl && item.faceAtlasUrl);
  const sourceName = uploadNameOf(item.src);
  const sourceRevision = item.sourceRevision;
  const identity = sourceName ? faceAnalysisIdentity(sourceName, sourceRevision) : null;

  // Ask the server once whether this source already has a pair: an analysis outlives
  // the component (and the session), so the control is a viewer of it, not its owner.
  // The identity is rebuilt here from its primitives so the effect depends on the two
  // values that actually change, not on a fresh object every render.
  useEffect(() => {
    if (!sourceName) return;
    let cancelled = false;
    void cachedFaceAnalysis(faceAnalysisIdentity(sourceName, sourceRevision))
      .then((artifacts) => {
        if (cancelled) return;
        setCached(artifacts);
        if (artifacts) setPhase((current) => (current === 'idle' ? 'ready' : current));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sourceName, sourceRevision]);

  // Cancelling on unmount is not optional: the pass holds a video decoder and a
  // MediaPipe session, and a component that unmounts mid-run must not keep seeking.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const start = useCallback(() => {
    if (!identity || !item.src) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setError(null);
    setProgress({ progress: 0, phase: 'sampling', frame: 0, frames: 0 });
    setPhase('running');
    appliedRef.current = false;
    void (async () => {
      let video: HTMLVideoElement | null = null;
      try {
        video = await openAnalysisVideo(item.src!, controller.signal);
        const result = await runFaceAnalysis({
          identity,
          video,
          sourceFps: fps,
          signal: controller.signal,
          onProgress: (update) => setProgress(update),
        });
        if (controller.signal.aborted) return;
        setCached(result);
        setPhase('ready');
        onApply(result.trackUrl, result.atlasUrl, result.engine || null);
        onAddEffect();
        appliedRef.current = true;
        showAppToast(t('Face analysis applied'));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPhase('failed');
        setError(cause instanceof FaceAnalysisRunError
          ? `${cause.message} (${cause.code})`
          : cause instanceof Error ? cause.message : String(cause));
      } finally {
        // Release the decoder: a detached element that keeps its source keeps a
        // hardware decoder allocated for as long as the page lives.
        if (video) {
          video.removeAttribute('src');
          video.load();
        }
      }
    })();
  }, [identity, item.src, fps, onApply, onAddEffect, t]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(cached ? 'ready' : 'idle');
    setProgress(null);
  }, [cached]);

  const restore = useCallback(() => {
    onClear();
    setPhase(cached ? 'ready' : 'idle');
    const current = identity;
    if (current) void forgetFaceAnalysis(current).then(() => setCached(null)).catch(() => undefined);
    showAppToast(t('Original picture restored'));
  }, [onClear, identity, cached, t]);

  const apply = useCallback(() => {
    if (!cached) return;
    onApply(cached.trackUrl, cached.atlasUrl, cached.engine || null);
    onAddEffect();
    showAppToast(t('Face analysis applied'));
  }, [cached, onApply, onAddEffect, t]);

  const running = phase === 'running';
  const percent = Math.round((progress?.progress ?? 0) * 100);
  const frames = progress?.frames ?? 0;

  return (
    <div>
      {running && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ height: 4, background: 'var(--cc-border, #333)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${percent}%`, height: '100%', background: 'var(--cc-accent, #4c8dff)' }} />
          </div>
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>
            {progress?.phase === 'encoding'
              ? t('Packing the skin masks')
              : `${percent}%${frames ? ` · ${t('frame {n} of {total}', { n: progress?.frame ?? 0, total: frames })}` : ''}`}
          </div>
        </div>
      )}
      {phase === 'failed' && error && (
        <div style={{ fontSize: 11, color: '#ff6b6b', marginBottom: 6 }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {running ? (
          <button type="button" className="cc-insp-btn" style={{ flex: 1, fontSize: 11 }} onClick={cancel}>
            {t('Cancel')}
          </button>
        ) : (
          <button
            type="button"
            className="cc-insp-btn"
            style={{ flex: 1, fontSize: 11 }}
            disabled={!identity}
            title={identity
              ? t('Find the face on this device and build a skin mask')
              : t('Import the clip into the media pool first')}
            onClick={start}
          >
            {cached || active || phase === 'failed' ? t('Run again') : t('Analyze face')}
          </button>
        )}
        {!running && cached && !active && (
          <button type="button" className="cc-insp-btn" style={{ fontSize: 11 }} onClick={apply}>
            {t('Apply to clip')}
          </button>
        )}
        {active && !running && (
          <button type="button" className="cc-insp-btn" style={{ fontSize: 11 }} onClick={restore}>
            {t('Restore original')}
          </button>
        )}
      </div>
      {active && (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          {t('Smoothness, even tone and reshape are in the effect stack above; the mask follows every trim of this clip.')}
        </div>
      )}
      {!active && cached && !running && (
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
          {t('An analysis is already cached for this source.')}
        </div>
      )}
    </div>
  );
}
