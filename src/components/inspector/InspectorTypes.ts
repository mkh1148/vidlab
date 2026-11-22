import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { Tpl } from '../../types';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import type { SlipPlan, SlipResult } from '../../editor/slip';
import type {
  ClipEffect,
  ClipFilters,
  ClipTransform,
  KeyframeEasing,
  KeyframeProp,
  TimelineItem,
  TransitionItem,
  TransitionType,
  ZoomEffect,
} from '../../editor/types';
import type { FlexCropEdge } from '../../editor/flexCrop';
import type { CaptionTrackResult } from '../../editor/storeCommands';
import type { CaptionTrackSummary } from '../../captions/captionTrack';
import type { SelectedCaptionInspector } from '../../captions/captionSelection';
import type { CaptionsData } from '../../captions/types';

export interface FadePatch {
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface AutoGradeControlProps {
  busy: boolean;
  targetCount: number;
  previewCount: number;
  failedCount: number;
  selectedPreview: {
    filters: Required<Pick<ClipFilters, 'brightness' | 'contrast' | 'saturate'>>;
    bitDepth: number;
    hdr: boolean;
  } | null;
  onAnalyze: () => void | Promise<void>;
  onApply: () => void;
  onCancel: () => void;
}

export interface InspectorPanelProps {
  templates: Tpl[];
  selectedItem: TimelineItem | null;
  selectedCaption?: SelectedCaptionInspector | null;
  onCaptionUpdate?: (patch: Partial<CaptionsData>) => void;
  selectedIds: readonly string[];
  selectedItems: readonly TimelineItem[];
  fps: number;
  canvasWidth: number;
  canvasHeight: number;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onItemPropChange: (key: string, value: unknown) => void;
  onItemVolumeChange: (volume: number) => void;
  onItemFadeChange: (fade: FadePatch) => void;
  onItemTransformChange: (patch: ClipTransform) => void;
  onItemCropChange: (edge: FlexCropEdge, value: number) => void;
  onItemFiltersChange: (patch: ClipFilters) => void;
  backgroundFillAvailable?: boolean;
  onItemBackgroundFillChange?: (enabled: boolean, strength?: number) => void;
  onApplyBackgroundFillToAll?: (strength: number) => void;
  autoGrade?: AutoGradeControlProps;
  onItemZoomChange: (patch: Partial<ZoomEffect> | null) => void;
  onItemEffectsChange: (effects: ClipEffect[]) => void;
  selectedPreviewStatuses?: readonly SelectedPreviewStatus[];
  onItemSpeedChange?: (rate: number) => void;
  slipPlan?: SlipPlan | null;
  onItemSlip?: (deltaInFrames: number) => SlipResult;
  onNormalizeLoudness?: () => void | Promise<void>;
  /**
   * D2/D6: attach a processed voice track to the selected clip (undoable).
   * `engine` names the engine that produced it; omitted keeps the tag the artifact
   * already carries, so the Original/Processed switch does not rewrite it.
   */
  onApplyDenoise?: (url: string, strength: number, engine?: string | null) => void;
  /**
   * The source revision a derived artifact's identity is built from. A control that
   * starts a job passes it, so a re-imported source produces a new artifact instead
   * of a stale cache hit on the old one.
   */
  sourceRevisionOf?: (item: TimelineItem) => string | null;
  /** D1: attach a derived cut-out picture to the selected clip (undoable). */
  onApplyDerivedPicture?: (url: string, engine: string | null) => void;
  /** D1: remove the derived reference so the clip shows its original picture. */
  onClearDerivedPicture?: () => void;
  /** D4: attach the face track + skin-mask atlas to the selected clip (undoable). */
  onApplyFaceRetouch?: (trackUrl: string, atlasUrl: string, engine: string | null) => void;
  /** D4: remove the face references so the clip renders without retouching. */
  onClearFaceRetouch?: () => void;
  /** D2/D6: remove the processed track so the clip plays its original audio. */
  onClearDenoise?: () => void;
  /** D3b: bind (or refresh) a caption track to the selected clip's stored transcript. */
  onCaptionTrackFromTranscript?: () => CaptionTrackResult;
  /** D3b: the caption track already bound to the selected clip, for the control's summary. */
  captionTrackSummary?: CaptionTrackSummary | null;
  getPlayhead: () => number;
  onSetReframeKeyframe: (frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  onRemoveReframeKeyframe: (frame: number) => void;
  onSetItemKeyframe: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (prop: KeyframeProp, frame: number) => void;
  onResetItemKeyframes: (props: readonly KeyframeProp[]) => void;
  onSeek: (frame: number) => void;
  transition: TransitionItem | null;
  onAddTransition: (type: TransitionType) => void;
  onSetTransition: (patch: Partial<TransitionItem>) => void;
  onRemoveTransition: () => void;
  playerRef: RefObject<PlayerRef | null>;
  historyGesture: { begin: () => void; end: () => void };
}
