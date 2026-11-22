# Vidlab

Private, local-first AI video editor — single source snapshot, no project history.

Vidlab builds on [OpenChatCut](https://github.com/0xsline/OpenChatCut); the upstream
**AGPL-3.0** license is retained in full (see `LICENSE`). This repository is a private
snapshot for the owner's work; it is not a public distribution and has no releases.

## How this build differs from upstream OpenChatCut

This is a heavily modified private build. The main differences:

- **Six AI features that run fully locally** (no cloud calls, no account):
  - local transcription of clip audio (whisper.cpp CLI, GGML weights, cached on disk);
  - per-clip loudness normalization (an FFmpeg processing chain);
  - caption tracks generated from the local transcript;
  - local face retouch, applied on the renderer side;
  - 14 film looks rendered by procedural LUT/shader formulas;
  - voice isolation (Deezer Spleeter 2stems, ONNX weights executed via
    onnxruntime — no Python or bundled interpreter).
- **One export engine.** Preview and export render through the same Remotion
  composition. A faster FFmpeg-direct export path was deliberately not added,
  so there is exactly one code path that can drift.
- **A hardened job engine around every AI feature:** work runs in child processes
  with a hard kill policy (a cancelled job leaves no orphaned processes), a
  RAM admission gate defers heavy jobs instead of refusing them, job results are
  deduplicated and revision-aware, and model weights are hash-checked on every
  resolve before use.
- **Production hardening:** single-command production start (`npm run start:prod`),
  loopback-only serving with a Host-header guard on every route, a media/data
  directory kept outside the source tree, and render concurrency derived from
  free RAM.
- **An expanded verification battery** (`npm run verify:*`) with per-feature exit
  tests and rendered-screen scans.

## Minimal install and configuration

Requirements:

- Windows (the serving model is developed and verified on Windows), Node 24
  (see `.nvmrc`), and network access during install and build only.
- FFmpeg/FFprobe are bundled through npm dependencies — nothing to install or
  put on PATH.

Steps:

1. `npm ci`
2. `npm run build` — this also downloads the whisper.cpp CLI (v1.9.2) and the
   MediaPipe models used by the local AI features.
3. (recommended) create a `.env.local` file with one line:
   `UI_LOCALE=en` — this snapshot still defaults the interface locale to `zh`
   when no locale is configured.
4. `npm run start:prod` → open http://127.0.0.1:5199

Configuration notes:

- No configuration file is required to edit and export video: import media,
  cut, apply looks, export.
- All six AI features run locally on this machine. Voice isolation downloads
  the Spleeter ONNX weights once, on first use (hash-checked).
- AI chat keys are optional: copy `.env.example` to `.env.local` and fill any
  `LLM_*_API_KEY` provider you want for the agent chat. Local AI features do
  not use them.
- Serving is loopback-only (127.0.0.1). The media store lives in the repo's
  data directory by default; `OPENCHATCUT_DATA_DIR` in `.env.local` moves it
  (see `.env.example` for every key).

## What is in the snapshot

- `src/` — editor UI (React + Remotion)
- `server/` — local job server; the AI features (transcription, loudness
  normalization, captions, film looks, face retouch, voice isolation) all run
  locally on this machine
- `desktop/`, `cli/`, `scripts/`, `shared/`, `assets/`, `public/`, `remotion/`

Internal design docs and build-process notes are intentionally not part of this
snapshot. This repository stays private; making it public has license
consequences that must be resolved first.
