import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, OffthreadVideo, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { Video as MediaVideo } from '@remotion/media';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { ensureFxImage, fxImageSettled } from './fx/imageCache';
import { ensureFaceTrack, faceTrackFor, faceTrackSettled } from '../face/faceTrackCache';
import { faceFrameRegion } from '../face/faceRegion';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import type { AspectFit, TimelineItem } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';
import { pictureSourceOf } from '../editor/derivedPicture';
import { offthreadTrimBefore, offthreadVideoTransparent, useRuntimeVideoDecoder } from '../editor/serverVideoDecoder';
import { glEffects } from './clipEffects';

// One video/image clip rendered through a builtin:fx-* single-input WebGL pass.
// Mounts a hidden, frame-synced media
// element (Remotion keeps it accurate in preview AND headless render),
// rasterizes it to a 2D staging canvas with the clip's contain/cover layout,
// then runs the effect's fragment shader to the visible canvas (with alpha, so
// luma-key etc. composite over lower tracks). Registered effects are flattened
// into one ordered pass graph, preserving the clip's effects[] order.

interface ClipFxProps {
  item: TimelineItem;
  fit: AspectFit;
  width: number;
  height: number;
  frameOffset?: number;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

// contain/cover placement matching MediaFill's objectFit, so GL frames align
// with the rest of the composition.
function drawFit(ctx: CanvasRenderingContext2D, source: CanvasImageSource, fit: AspectFit): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const dimensions = source as CanvasImageSource & {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number;
    height?: number;
  };
  const nw = dimensions.videoWidth
    ?? dimensions.naturalWidth
    ?? dimensions.displayWidth
    ?? dimensions.width
    ?? 0;
  const nh = dimensions.videoHeight
    ?? dimensions.naturalHeight
    ?? dimensions.displayHeight
    ?? dimensions.height
    ?? 0;
  ctx.clearRect(0, 0, W, H);
  if (!nw || !nh) return;
  const scale = fit === 'cover' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function ClipFx({ item, fit, width, height, frameOffset = 0, onPreviewStatus }: ClipFxProps) {
  const frame = useCurrentFrame() + frameOffset;
  const { fps } = useVideoConfig();
  const isRendering = getRemotionEnvironment().isRendering;
  // Same decoder as the plain layers (RuntimeVideo): a Windows export must not
  // reach the WebCodecs decode through an effect clip either (#162), and one
  // decoder per export keeps effect inputs in lockstep with their neighbours.
  const videoDecoder = useRuntimeVideoDecoder();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceLayerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const failedAdapterRef = useRef<{ definitionKey: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const stagedRenderKeyRef = useRef<string | null>(null);
  const hasRenderedRef = useRef(false);
  const [hasRendered, setHasRendered] = useState(false);
  const trimBefore = sourceFrameAt(item, frameOffset);

  const staging = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }, [width, height]);

  const active = useMemo(() => glEffects(item), [item]);
  // D4: the face region for THIS frame. The track is keyed by SOURCE frame, so the
  // lookup asks the same clock the decoder gets — `trimBefore` is the source frame
  // of the clip's first frame and the clip-local frame advances it, so a trim moves
  // the mask with the picture instead of leaving it on the trim's first frame.
  const faceTrackUrl = item.faceTrackUrl ?? null;
  const faceAtlasUrl = item.faceAtlasUrl ?? null;
  const sourceFrame = sourceFrameAt(item, frame - frameOffset);
  // The region is computed AT DRAW TIME, in tick(), after the track and the atlas
  // have settled — never in a memo keyed on the URLs. `faceTrackFor` is a
  // synchronous cache read that answers null until the fetch resolves, so a memo
  // would freeze the boxless region from the first render and the first frame
  // after a cold load would draw the clip unretouched until the playhead moved.
  const definitionKey = useMemo(
    () => active.map(({ def }) => `${def.id}:${def.frag}`).join('\u0000'),
    [active],
  );
  const renderKey = useMemo(
    () => JSON.stringify([frame, fit, width, height, faceTrackUrl, faceAtlasUrl, active.map(({ fx }) => [fx.id, fx.overrides])]),
    [frame, fit, width, height, faceTrackUrl, faceAtlasUrl, active],
  );
  // What the STAGING canvas holds, which is only the decoded picture and its
  // layout: parameters, the atlas and the track change what the shader does with
  // those pixels, not the pixels. Keying the staging on the full renderKey would
  // make a slider move while paused wait forever for a frame the paused media
  // element never delivers (kit D4 requirement 4: a slider moved while paused must
  // re-render the frame).
  const stagingKey = useMemo(
    () => JSON.stringify([frame, trimBefore, fit, width, height, pictureSourceOf(item)]),
    [frame, trimBefore, fit, width, height, item],
  );
  const onVideoFrame = useCallback(
    (source: CanvasImageSource) => {
      const ctx = staging.getContext('2d');
      if (!ctx) return;
      drawFit(ctx, source, fit);
      stagedRenderKeyRef.current = stagingKey;
    },
    [fit, stagingKey, staging],
  );
  // <OffthreadVideo> reloads its image element whenever onVideoFrame changes
  // identity, just as it revokes that frame's blob URL for the next frame —
  // one failed-load warning per rendered frame. A stable callback stages under
  // the latest key instead: a server render mounts the next frame's image only
  // after this frame's key is committed.
  const offthreadTargetRef = useRef({ fit, stagingKey });
  useLayoutEffect(() => {
    offthreadTargetRef.current = { fit, stagingKey };
  }, [fit, stagingKey]);
  const onOffthreadVideoFrame = useCallback(
    (source: CanvasImageSource) => {
      const ctx = staging.getContext('2d');
      if (!ctx) return;
      const target = offthreadTargetRef.current;
      drawFit(ctx, source, target.fit);
      stagedRenderKeyRef.current = target.stagingKey;
    },
    [staging],
  );

  useEffect(() => {
    if (!onPreviewStatus) return;
    const targetId = item.id;
    return () => {
      onPreviewStatus({
        kind: 'effect',
        targetId,
        adapter: 'gl-effect',
        phase: 'inactive',
      });
    };
  }, [item.id, onPreviewStatus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || active.length === 0) return;
    const handle = isRendering ? delayRender(`clip-fx ${active.map(({ def }) => def.id).join(',')}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      onPreviewStatus?.({
        kind: 'effect',
        targetId: item.id,
        adapter: 'gl-effect',
        phase,
        fallbackReason,
      });
    };
    const finish = () => {
      if (!done && handle != null) {
        done = true;
        continueRender(handle);
      }
    };
    const priorFailure = failedAdapterRef.current?.definitionKey === definitionKey
      ? failedAdapterRef.current.reason
      : null;
    if (priorFailure) {
      report('fallback', priorFailure);
      finish();
      return () => finish();
    }
    let waitingReported = false;
    const reportWaiting = () => {
      if (waitingReported) return;
      waitingReported = true;
      report('fallback', 'media-loading');
    };
    // .cube LUT is loaded first; tick waits until loading has settled. A failed
    // LUT is an intentional pass-through with intensity=0 in fxPasses().
    for (const { def } of active) if (def.cube) void ensureCube(def.cube);
    // D4: the atlas and the track are the effect's inputs, exactly like a .cube.
    // Rendering before they settle would draw the landmark fallback and then pop.
    if (faceAtlasUrl) void ensureFxImage(faceAtlasUrl);
    if (faceTrackUrl) void ensureFaceTrack(faceTrackUrl);
    const tick = () => {
      const decodedVideo = item.kind !== 'image';
      const mediaReady = decodedVideo
        ? stagedRenderKeyRef.current === stagingKey
        : !!imageRef.current?.complete;
      if (!mediaReady) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      if (active.some(({ def }) => def.cube && !cubeSettled(def.cube))) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      if (faceAtlasUrl && !fxImageSettled(faceAtlasUrl)) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      if (faceTrackUrl && !faceTrackSettled(faceTrackUrl)) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      // D4: read the region only now, with both inputs settled, so the frame drawn
      // on a cold load is the same frame a slider move redraws.
      const faceRegion = faceFrameRegion({
        track: faceTrackUrl ? faceTrackFor(faceTrackUrl) : null,
        atlasUrl: faceAtlasUrl,
        sourceFrame,
      });
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const ctx = staging.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        if (!decodedVideo && imageRef.current) drawFit(ctx, imageRef.current, fit);
        const shaderFrame = buildEffectShaderFrame(
          active.map(({ fx, def }) => ({ def, overrides: fx.overrides })),
          frame,
          fps,
          { uniforms: faceRegion.uniforms, images: faceRegion.images },
        );
        runtime.renderFxChain(shaderFrame.passes, staging);
        // Make the freshly drawn canvas authoritative before unblocking export;
        // React state then preserves the same choice for subsequent renders.
        canvas.style.opacity = '1';
        if (sourceLayerRef.current) sourceLayerRef.current.style.opacity = '0';
        if (!isRendering && !hasRenderedRef.current) {
          hasRenderedRef.current = true;
          setHasRendered(true);
        }
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { definitionKey, reason };
        disposeRuntimeSlot(runtimeRef);
        report('fallback', reason);
        console.error('[clip-fx]', error);
      }
      finish();
    };
    tick();
    return () => { cancelAnimationFrame(raf); finish(); };
  }, [active, definitionKey, fit, staging, item.id, item.kind, frame, sourceFrame, fps, isRendering, renderKey, stagingKey, faceAtlasUrl, faceTrackUrl, onPreviewStatus]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, definitionKey]);

  // Once any GL frame has been drawn, keep the canvas visible across seeks:
  // falling back to the raw source layer would flash the UNFILTERED frame for
  // the 1-2 frames until the new frame's shader pass is ready. The first
  // (never-drawn) load still falls back to the honest source while media loads.
  const showingShaderFrame = hasRendered;
  // D1: the effect samples the clip's PICTURE, which is the derived matte when one
  // is attached. The GL pipeline already carries source alpha (its shaders work in
  // premultiplied RGBA and the staging canvas is drawn with alpha), so a matte
  // composites over lower tracks through an effect the same way it does plainly.
  const picture = pictureSourceOf(item);
  if (active.length === 0) return null;
  return (
    <AbsoluteFill>
      {/* The source is the honest Player fallback while media/GL is unavailable.
          Once this exact frame+parameter key is drawn, only the GL canvas shows. */}
      <AbsoluteFill ref={sourceLayerRef} style={{ opacity: showingShaderFrame ? 0 : 1, pointerEvents: 'none' }}>
        {item.kind === 'image'
          // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
          ? <Img ref={imageRef} src={picture!} style={{ width: '100%', height: '100%', objectFit: fit }} />
          : videoDecoder === 'offthread'
            ? <OffthreadVideo src={picture!} trimBefore={offthreadTrimBefore(trimBefore, fps)} playbackRate={item.playbackRate ?? 1} muted
                transparent={offthreadVideoTransparent(picture!)} onVideoFrame={onOffthreadVideoFrame}
                style={{ width: '100%', height: '100%', objectFit: fit }} />
            : <MediaVideo src={picture!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} muted
                headless={isRendering} onVideoFrame={onVideoFrame} style={{ width: '100%', height: '100%' }} objectFit={fit} />}
      </AbsoluteFill>
      <canvas ref={canvasRef} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: showingShaderFrame ? 1 : 0 }} />
    </AbsoluteFill>
  );
}
