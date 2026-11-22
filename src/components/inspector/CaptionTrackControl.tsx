// The D3b inspector control: turn the selected clip's STORED transcript into a
// caption track, and refresh that binding later.
//
// The division of responsibility is the same one D2's control uses: the control is
// a VIEWER of editor state, and the only mutation is one undoable editor command
// (`captionTrackFromTranscript`). It never reads or writes the transcript itself —
// the transcript belongs to the clip (D3a), and the caption track stores only the
// BINDING, so a re-transcription re-times the captions without a refresh call.
//
// Copy is English-keyed on purpose (the D surface is English; the keys are
// registered in the EN dictionary), so nothing here renders a Chinese literal.
import { useState } from 'react';
import { useT } from '../../i18n/locale';
import { showAppToast } from '../../ui/appToast';
import type { CaptionTrackResult } from '../../editor/storeCommands';
import type { CaptionTrackSummary } from '../../captions/captionTrack';

export function CaptionTrackControl({ hasTranscript, transcriptStale, summary, onCreate }: {
  hasTranscript: boolean;
  transcriptStale: boolean;
  summary: CaptionTrackSummary | null;
  onCreate: () => CaptionTrackResult;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const run = () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = onCreate();
      if (!result.ok) {
        showAppToast(result.error, { error: true });
        return;
      }
      showAppToast(result.created
        ? t('Caption track created from this clip\'s transcript.')
        : result.changed
          ? t('Captions refreshed from this clip\'s transcript.')
          : t('Captions already follow this clip\'s transcript.'));
    } finally {
      setBusy(false);
    }
  };

  if (!hasTranscript) {
    return (
      <div className="cc-insp-caption-track">
        <p className="cc-insp-muted">
          {transcriptStale
            ? t('This clip\'s transcript is out of date. Transcribe it again before adding captions.')
            : t('This clip has no transcript yet. Transcribe it first, then add captions.')}
        </p>
        <button type="button" className="cc-insp-button" disabled>{t('Create caption track')}</button>
      </div>
    );
  }

  return (
    <div className="cc-insp-caption-track">
      {summary && (
        <p className="cc-insp-muted">
          {t('Caption track {alias} · {n} cues{off}', {
            alias: summary.alias,
            n: summary.cues,
            off: summary.enabled ? '' : t(' · hidden'),
          })}
        </p>
      )}
      {!summary && <p className="cc-insp-muted">{t('Captions follow this clip\'s transcript, so trimming the clip trims the captions.')}</p>}
      <button type="button" className="cc-insp-button" onClick={run} disabled={busy}>
        {summary ? t('Refresh captions') : t('Create caption track')}
      </button>
    </div>
  );
}
