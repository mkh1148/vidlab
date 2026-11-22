import type { AgentToolSchema } from '../../tool-schema';

/**
 * The D job tool group (D-job contract, H4 + H6): start, poll, apply.
 *
 * D1a shipped these against a SYNTHETIC engine so the shape was proven before a
 * real model existed. D1b adds the real feature — `background_removal`, RVM
 * matting — as the default `feature`, and keeps the synthetic engine reachable
 * for the contract verifies. D2 adds `voice_cleanup`, the second real engine and
 * the second real consumer of the D-job contract. The group's shape did not
 * change across either: same three tools, same sessionless start/poll, same
 * session-pinned apply.
 *
 * `voice_cleanup` is the one feature whose artifact is AUDIO, so apply_artifact
 * writes a different field for it: `denoisedSrc` (the clip's audio track) instead
 * of `derivedPictureSrc` (the clip's picture). Both are derived references — the
 * clip's own source is never replaced (I4) — but they are different slots in the
 * editor model, and a tool that guessed the slot from the item kind would put a
 * cleaned voice track into the picture field.
 *
 * D3a adds `transcription`, the third real engine and the third slot: its artifact
 * is a transcript, so apply_artifact reads the artifact back and writes the clip's
 * TRANSCRIPT through the command core (`setItemTranscript`). The slot is declared
 * for the same reason as the audio one: a transcript is not a picture and not an
 * audio file, and inferring it from the item kind would be a guess.
 *
 * start_job and poll_job are sessionless server-side media operations: they take
 * no edit session, claim no project ownership and never touch the timeline. Only
 * apply_artifact mutates the project, so only it is pinned to an edit session and
 * guarded by the revision contract.
 */
export const MEDIA_JOB_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'start_job',
    description:
      'Start a heavy on-device media job. feature "background_removal" (default) removes the '
      + 'background of a talking-head clip with the on-device RVM model and produces a cut-out '
      + 'picture with alpha; feature "voice_cleanup" cleans the clip\'s speech track with the '
      + 'on-device RNNoise model (rumble, denoise, sibilance, tone, level, loudness to -16 LUFS) '
      + 'and produces a WAV; feature "transcription" transcribes the clip\'s speech with the '
      + 'on-device whisper.cpp model and produces a word-timed transcript (voice activity '
      + 'detection first, so nothing is transcribed over silence); feature "voice_isolation" '
      + 'separates the speech from music and background sound with the on-device Spleeter '
      + '2stems model and then runs the same clean-up chain as voice_cleanup, producing a WAV '
      + 'that has the music removed; feature "synthetic" runs the '
      + 'contract test engine. Returns a jobId immediately; the job runs on the server, one heavy '
      + 'job at a time, and is cancelable. This is a sessionless media operation: it does not '
      + 'claim the project and does not change the timeline. Poll it with poll_job, then attach '
      + 'the result with apply_artifact. A job that cannot start yet because the machine is short '
      + 'of free memory reports status "deferred" with code "ram_below_gate" — that is a wait, '
      + 'not an error.',
    input_schema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          enum: ['background_removal', 'voice_cleanup', 'voice_isolation', 'transcription', 'synthetic'],
          description: 'Which engine to run. background_removal (default) = RVM matting; voice_cleanup = RNNoise speech clean-up; voice_isolation = Spleeter 2stems separation + the same clean-up; transcription = whisper.cpp speech-to-text; synthetic = the contract test engine.',
        },
        sourceName: {
          type: 'string',
          description: 'Upload name of the source clip, e.g. "clip.mov". The artifact is named from it.',
        },
        revision: {
          type: 'string',
          description: 'Optional source revision; a new revision produces a new artifact instead of reusing the old one.',
        },
        ratio: {
          type: 'number',
          minimum: 0.1,
          maximum: 1,
          description: 'background_removal only: RVM downsample ratio (default 0.375; lower is faster and coarser).',
        },
        model: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large-v3-turbo'],
          description: 'transcription only: whisper.cpp model tier (default base, multilingual). A different tier is a different cached transcript.',
        },
        language: {
          type: 'string',
          description: 'transcription only: ISO language code (e.g. "en") or "auto" (default). Part of the cache identity.',
        },
        engine: {
          type: 'string',
          enum: ['sleep', 'multi-step'],
          description: 'synthetic only: sleep = one spawned child; multi-step = staged, one artifact per stage. Default sleep.',
        },
        steps: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          description: 'synthetic only: how many progress steps the job runs (default 4).',
        },
        stepMs: {
          type: 'number',
          minimum: 0,
          maximum: 5000,
          description: 'synthetic only: milliseconds per step (default 150).',
        },
        crashAfter: {
          type: 'number',
          minimum: 0,
          maximum: 200,
          description: 'synthetic only: test hook — make the sleep engine exit non-zero at this step (0 = never crash).',
        },
      },
      required: ['sourceName'],
    },
  },
  {
    name: 'poll_job',
    description:
      'Read the state of a media job started by start_job: status, progress 0..1, phase, the artifact '
      + 'location once it completes, or {error, code}. Optionally waits up to 20 s for a terminal state '
      + '(a short call by construction; re-issue instead of waiting longer). Sessionless: no edit '
      + 'session, no project ownership.',
    input_schema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          enum: ['background_removal', 'voice_cleanup', 'voice_isolation', 'transcription', 'synthetic'],
          description: 'Which engine started the job (default background_removal).',
        },
        jobId: { type: 'string', description: 'The jobId returned by start_job.' },
        waitMs: {
          type: 'number',
          minimum: 0,
          maximum: 20000,
          description: 'Wait up to this long for a terminal status (default 0 = read now).',
        },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'apply_artifact',
    description:
      'Attach a completed job artifact to a clip. For background_removal (D1) it becomes the clip\'s '
      + 'derived PICTURE; for voice_cleanup (D2) and voice_isolation (D6) it becomes the clip\'s derived AUDIO track '
      + '(denoisedSrc at full strength); for transcription (D3a) its word-timed transcript becomes '
      + 'the clip\'s TRANSCRIPT, read back from the artifact and written through the command core. '
      + 'Either way the clip keeps its original source for every fallback (I4): the source is never '
      + 'replaced, and action "clear" restores the original (for transcription: the transcript the '
      + 'clip had before, or none). One undoable command: undo removes the derived reference or '
      + 'restores the previous transcript. Requires a completed job; a job that is still running is '
      + 'refused with code "job_not_complete".',
    input_schema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          enum: ['background_removal', 'voice_cleanup', 'voice_isolation', 'transcription', 'synthetic'],
          description: 'Which engine produced the artifact (default background_removal).',
        },
        itemId: { type: 'string', description: 'Target clip id (prefix ok). background_removal needs a video/image clip; voice_cleanup, voice_isolation and transcription need a video/audio clip.' },
        jobId: {
          type: 'string',
          description: 'The completed job whose artifact becomes the clip picture, audio or transcript.',
        },
        action: {
          type: 'string',
          enum: ['apply', 'clear'],
          description: 'apply (default) attaches the artifact; clear restores the original picture, audio or transcript.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'analyze_face',
    description:
      'Find the face across a whole source clip and store the two artifacts face retouching needs: a '
      + 'compact landmark track keyed by SOURCE frame (so every trim of the source lines up) and a '
      + 'skin-mask atlas (an image grid, one cell per sample, aligned to those landmarks). Both are '
      + 'effect assets: they live in the per-source derived area beside the media, they travel into an '
      + 'export, and media clean-up removes them with the source. Runs on this device with MediaPipe '
      + 'Face Landmarker + selfie segmentation (Apache-2.0); the model is downloaded once into the '
      + 'model cache and verified against pinned bytes and sha256. This is a sessionless analysis: it '
      + 'does not claim the project and does not change the timeline. It returns the two artifact URLs; '
      + 'attach them with apply_face_retouch. A cached analysis for the same source, revision and '
      + 'options is reused instead of re-run.',
    input_schema: {
      type: 'object',
      properties: {
        sourceName: {
          type: 'string',
          description: 'Upload name of the source clip, e.g. "talking-head.mp4". The artifacts are named from it.',
        },
        revision: {
          type: 'string',
          description: 'Optional source revision; a new revision produces a new analysis instead of reusing the old one.',
        },
      },
      required: ['sourceName'],
    },
  },
  {
    name: 'apply_face_retouch',
    description:
      'Attach an analyzed face to a clip: the landmark track and the skin-mask atlas become the clip\'s '
      + 'face references, and the "builtin:fx-face-retouch" effect is added when the clip has none, so '
      + 'its sliders (smoothness, even tone, reshape) appear in the inspector. The clip keeps its '
      + 'original source (I4); the effect only changes how it is drawn. Without a mask the shader falls '
      + 'back to the landmark box, so a clip with a track but no atlas still retouches. action "clear" '
      + 'removes the face references and restores the untouched picture. One undoable step: undo removes '
      + 'the references and the effect it added.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target clip id (prefix ok). Needs a video or image clip.' },
        trackUrl: {
          type: 'string',
          description: 'The landmark track URL returned by analyze_face (/media/derived/<sourceKey>/<name>).',
        },
        atlasUrl: {
          type: 'string',
          description: 'The skin-mask atlas URL returned by analyze_face (/media/derived/<sourceKey>/<name>).',
        },
        engine: {
          type: 'string',
          description: 'Optional engine identity returned by analyze_face, e.g. "mediapipe-face-landmarker-v1".',
        },
        action: {
          type: 'string',
          enum: ['apply', 'clear'],
          description: 'apply (default) attaches the analysis; clear restores the untouched picture.',
        },
      },
      required: ['itemId'],
    },
  },
];

export const MEDIA_JOB_TOOL_NAMES = new Set(MEDIA_JOB_TOOL_SCHEMAS.map((tool) => tool.name));
