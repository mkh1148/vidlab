// The placeholder text a new title clip is stored with.
//
// It is DATA — the clip's text content lives in the project document and is never
// rewritten — so it is translated where it is drawn, not where it is stored. It
// needs its own module because the writer (editor/storeCommandBuilder.ts) is
// reachable from src/agent/** and the reader (editor/TimelineGraphicLayers.tsx) is
// a component: a shared constant keeps the two from drifting apart, and importing
// it from the renderer is what makes the allow-list check treat the literal as UI
// copy instead of agent-facing text.
export const DEFAULT_TEXT_CONTENT = '双击编辑文字';
