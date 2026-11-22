// EN dictionary for the propose→apply surface (field fragment, key = Chinese
// original text).
//
// Source: src/agent/proposal.ts (the tool→verb VERB table, the counted impact
// fragments and the title/summary/target fallbacks), src/agent/changeLog.ts and
// src/agent/useAgentRun.ts (change-log row summaries), the proposal error
// notices in src/agent/useAgentProposalActions.ts, the server-run notices in
// src/agent/serverRunSend.ts, and the pre-change version label.
//
// None of these strings is rendered raw: src/i18n/proposalText.ts translates
// them at display time for ProposalCard.tsx and AgentChangeLogMenu.tsx, and the
// notices are literal t() arguments. scripts/i18n-english.verify.mjs asserts
// every one of them has an entry here.
export default {
  // ── Tool verbs (proposal.ts VERB) ──
  '添加动画': 'Add motion graphic',
  '生成动画': 'Generate motion graphic',
  '添加音频': 'Add audio',
  '改属性': 'Change properties',
  '移动片段': 'Move clip',
  '改时长/位置': 'Change timing / position',
  '复制片段': 'Duplicate clip',
  '删除片段': 'Delete clip',
  '切分片段': 'Split clip',
  '清空时间线': 'Clear timeline',
  '改画面比例': 'Change aspect ratio',
  '挂转写': 'Attach transcript',
  '删文字=删视频': 'Delete text = delete video',
  '清理口播': 'Clean up speech',
  '编辑字幕': 'Edit captions',
  '管理序列': 'Manage sequences',
  '管理轨道': 'Manage tracks',
  '整理素材池': 'Tidy media pool',
  '改稿应用': 'Apply script',
  '编辑片段': 'Edit clip',
  '浏览资源库': 'Browse library',

  // ── Counted impact fragments (proposal.ts impactOf) ──
  '+{n} 序列': '+{n} sequences',
  '−{n} 序列': '−{n} sequences',
  '+{n} 片段': '+{n} clips',
  '−{n} 片段': '−{n} clips',
  '{n} 处改动': '{n} changes',
  '无变化': 'No change',

  // ── Title and summary fallbacks ──
  'Agent 编辑提案': 'Agent edit proposal',
  '{n} 项编辑': '{n} edits',

  // ── Change-log row summaries (changeLog.ts, useAgentRun.ts) ──
  'Agent 修改': 'Agent changes',
  'Agent 修改（进行中）': 'Agent changes (in progress)',
  // The version saved before a proposal is applied (useAgentProposalActions.ts
  // versionLabel), shown through i18n/storedNames.ts in the version history.
  'Agent 修改前': 'Before agent changes',

  // ── Proposal error notices (useAgentProposalActions.ts) ──
  '所选操作无法应用（可能取消勾选了前置步骤），提案未改动工程。':
    'The selected operations cannot be applied (a prerequisite step may have been unchecked). The proposal did not change the project.',
  '提案已保存到工程，但恢复记录尚未完成；请重新打开工程确认。':
    'The proposal was saved to the project, but the recovery record is incomplete. Reopen the project to confirm.',
  '无法取得提案运行权限、保存工程或创建修改前版本，提案未应用。请重试。':
    'Could not take the proposal run lease, save the project, or create the pre-change version, so the proposal was not applied. Try again.',
  '无法持久化过期提案状态；提案不会被应用。':
    'Could not persist the stale-proposal state; the proposal will not be applied.',
  '无法持久化提案替换状态，请重试。':
    'Could not persist the replaced-proposal state. Try again.',
  '无法持久化提案拒绝状态，提案未拒绝。请重试。':
    'Could not persist the rejected-proposal state, so the proposal was not rejected. Try again.',
  '提案已应用，但运行记录尚未完成；重新打开工程时会继续恢复。':
    'The proposal was applied, but the run record is incomplete; recovery continues when you reopen the project.',
  '提案已应用，但恢复记录暂未清理；它已标记为不可重放。':
    'The proposal was applied, but the recovery record could not be cleaned up; it is marked as not replayable.',

  // ── Server-run notices (serverRunSend.ts, serverRunControllerActions.ts,
  //    serverRunProposalLifecycle.ts, serverRunStreamLifecycle.ts) ──
  '服务端运行仅支持已配置的 API / Codex / Copilot / Claude Code 模型。':
    'Server runs only support a configured API / Codex / Copilot / Claude Code model.',
  '服务端任务已由另一个页面接管，本页不会重复执行。':
    'Another page has taken over this server run; this page will not run it again.',
  '服务端任务未能启动：{detail}': 'The server run could not start: {detail}',
  '服务端任务停止失败：{detail}': 'Could not stop the server run: {detail}',
  '服务端任务记录已不存在（编辑器服务可能已重启）':
    'The server run record no longer exists (the editor service may have restarted)',
  '之前的服务端任务已安全中断并清除恢复状态。{detail}{warning}':
    'The previous server run was safely interrupted and its recovery state cleared.{detail}{warning}',
  '传输清理警告：{detail}': 'Transport cleanup warning: {detail}',
  '服务端任务无法安全恢复，恢复凭据已保留：{detail}':
    'The server run could not be recovered safely; the recovery credentials were kept: {detail}',
  'Agent 已停止，但素材池改动提交失败：{detail}':
    'The agent stopped, but the media-pool changes could not be committed: {detail}',
  'Agent 已停止，但提案生成失败，编辑未应用：{detail}':
    'The agent stopped, but the proposal could not be generated, so the edits were not applied: {detail}',
  'Agent 已完成运行，但本次编辑未被记录为可应用的操作（提案为空），时间线未改动。请重试，或打开运行检查器查看详情。':
    'The agent finished, but its edits were not recorded as applicable operations (the proposal is empty), so the timeline is unchanged. Try again, or open the run inspector for details.',

  // ── Chat persistence notice (useAgentPersistence.ts) ──
  '聊天记录暂时无法读取，已停止加载以避免覆盖已保存的对话。请刷新页面重试。':
    'The chat history could not be read, so loading stopped to avoid overwriting the saved conversation. Refresh the page to try again.',
} as Record<string, string>;
