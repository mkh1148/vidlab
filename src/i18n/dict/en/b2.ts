// Milestone B2 — the dangerous-class closure.
//
// The independent triage at 443e8633 found 216 CJK units that reached the
// renderer at locale=en with no English coverage: app-authored error messages
// pushed into an `errors: string[]`, labels read through a variable, stored
// names rendered raw, helpers that return Chinese into JSX. Fixing them meant
// converting each one to a t() key at the place it originates, so this file
// carries the English half of that closure. It also carries the keys that were
// already rendered through t() but had no entry (the triage's "dictionary-only"
// list) and the full-width punctuation keys the joiner sites now ask for.
//
// Kept as one file rather than scattered into the per-field files: the closure
// is one reviewed unit of work, and a reviewer can read it against
// docs/i18n-allowlist.md without hunting through twenty modules.
export default {
  // ── full-width punctuation, asked for at the joiner sites ────────────────
  // The English form of a Chinese list separator, statement separator and
  // colon. `join(t('、'))` is the list joiner; the others are substituted into
  // a template that used to hard-code the full-width glyph.
  '、': ', ',
  '；': '; ',
  '：': ': ',

  // ── plugin pack validation (src/plugins/validate.ts) ─────────────────────
  '插件包必须是 JSON 对象': 'A plugin pack must be a JSON object',
  'format 必须是 "{format}"(当前仅支持该版本;未知 format 拒装)': 'format must be "{format}" (only this version is supported; an unknown format is refused)',
  '包 id 非法({pattern})': 'Invalid pack id ({pattern})',
  'version 必须是 x.y.z': 'version must be x.y.z',
  'author 超长': 'author is too long',
  'description 超长': 'description is too long',
  'items 必须是 1..{max} 条': 'items must contain 1 to {max} entries',
  'items[{i}]: id 重复 {id}': 'items[{i}]: duplicate id {id}',
  '{at}: 必须是对象': '{at}: must be an object',
  '{at}: id 非法({pattern})': '{at}: invalid id ({pattern})',
  '{at}: name 必须是 1..{max} 字符的字符串': '{at}: name must be a string of 1 to {max} characters',
  '{at}: desc 超长(≤{max})': '{at}: description is too long (≤{max})',
  '{at}: code 缺失': '{at}: code is missing',
  '{at}: code 超过 {kb}KB': '{at}: code exceeds {kb}KB',
  '{at}: {dim} 必须在 [16, 8192]': '{at}: {dim} must be within [16, 8192]',
  '{at}: durationInFrames 必须在 [1, 216000]': '{at}: durationInFrames must be within [1, 216000]',
  '{at}: props 必须是对象': '{at}: props must be an object',
  '{at}: props 必须是 ≤{max} 项的数组': '{at}: props must be an array of at most {max} entries',
  '{at}: propSchema 必须是 ≤32 项的数组': '{at}: propSchema must be an array of at most 32 entries',
  '{at}.propSchema[{i}]: 需要 key/type 字符串': '{at}.propSchema[{i}]: key and type must be strings',
  '{at}: label 缺失': '{at}: label is missing',
  '{at}: key 非法({pattern})': '{at}: invalid key ({pattern})',
  '{at}: key 重复 {key}': '{at}: duplicate key {key}',
  '{at}: default/min/max 必须是有限数且 min≤max': '{at}: default/min/max must be finite numbers with min ≤ max',
  '{at}: step 必须 >0': '{at}: step must be > 0',
  '{at}: defaultDurationFrames 必须在 [2, 300]': '{at}: defaultDurationFrames must be within [2, 300]',
  '{at}: passes 必须是 1..4 段的数组': '{at}: passes must be an array of 1 to 4 entries',
  '{at}: cube 与 frag 必须且只能提供一个': '{at}: provide exactly one of cube or frag',
  '{at}: cube 超过 {mb}MB': '{at}: cube exceeds {mb}MB',
  '{at}: cube 解析失败 — {detail}': '{at}: failed to parse the cube — {detail}',
  '{at}: frag 缺失': '{at}: frag is missing',
  '{at}: frag 必须引用 {token}': '{at}: frag must reference {token}',
  '{at}: frag 超过 {kb}KB': '{at}: frag exceeds {kb}KB',
  '{at}: envelope 与 shape 至少提供一个': '{at}: provide at least one of envelope or shape',
  '{at}: envelope 必须是 {min}..{max} 个点': '{at}: envelope must have {min} to {max} points',
  '{at}: envelope 值必须在 [0, {max}]': '{at}: envelope values must be within [0, {max}]',
  '{at}: shape 非法': '{at}: invalid shape',
  '{at}: magnification 必须在 [1, 16]': '{at}: magnification must be within [1, 16]',
  '{at}: {key} 必须在 [0, 1]': '{at}: {key} must be within [0, 1]',
  '{at}: {key} 必须在 [0, 300]': '{at}: {key} must be within [0, 300]',
  '{at}: thumb 必须是非空字符串': '{at}: thumb must be a non-empty string',
  '{at}: thumb 只允许 data:image/* 或 URL(/… | https://…)': '{at}: thumb must be data:image/* or a URL (/… or https://…)',
  '{at}: thumb 超过 {kb}KB': '{at}: thumb exceeds {kb}KB',
  '{at}: 未知 type {type}': '{at}: unknown type {type}',

  // ── plugin install (src/plugins/install.ts) ──────────────────────────────
  '不是合法 JSON': 'Not valid JSON',
  '不是合法的 JSON 文件': 'Not a valid JSON file',
  '文件内容不是对象': 'The file content is not an object',
  '下载失败:HTTP {status}': 'Download failed: HTTP {status}',
  '下载失败(可能被 CORS 拦):{detail}。可下载文件后用「选文件」安装': 'Download failed (possibly blocked by CORS): {detail}. Download the file and install it with "Choose file".',
  '写入本地失败:{detail}': 'Failed to write locally: {detail}',
  '注册失败:{detail}': 'Registration failed: {detail}',
  'SHA-256 不匹配(期望 {expected}…,实得 {actual}…)': 'SHA-256 mismatch (expected {expected}…, got {actual}…)',
  'WebGL 不可用,无法校验 shader:{detail}': 'WebGL is unavailable, so the shader cannot be validated: {detail}',
  '「{name}」.cube 上传失败:{detail}': 'Failed to upload "{name}".cube: {detail}',
  '「{name}」shader 编译失败:{detail}': 'Shader compilation failed for "{name}": {detail}',
  '「{name}」模板编译失败:{detail}': 'Template compilation failed for "{name}": {detail}',

  // ── plugin store (src/plugins/store.ts) ──────────────────────────────────
  '扩展存储请求失败 ({status})': 'Extension storage request failed ({status})',
  '{name} 插件特效': '{name} plugin effect',
  '{name} 插件 LUT': '{name} plugin LUT',
  'LUT「{name}」缺少 frag': 'LUT "{name}" is missing its frag',

  // ── project transfer (src/persist/projectTransfer*.ts) ───────────────────
  '格式不识别(需要 {format})': 'Unrecognised format (expected {format})',
  '缺工程名': 'Missing project name',
  '工程数据(doc)校验不通过': 'The project data (doc) failed validation',
  '工程包缺 manifest': 'The package is missing its manifest',
  '工程包 manifest 不是对象': 'The package manifest is not an object',
  '工程包缺媒体清单': 'The package is missing its media list',
  '工程包媒体条目校验不通过': 'The package media entries failed validation',
  '工程包媒体记录不是对象': 'A package media record is not an object',
  '工程包媒体记录未结束': 'A package media record is unterminated',
  '工程包媒体记录被截断': 'A package media record is truncated',
  '工程包媒体临时清单缺失': "The package's temporary media list is missing",
  '工程包媒体分片顺序错误': 'The package media chunks are out of order',
  '工程包媒体大小不匹配: {name}': 'Package media size mismatch: {name}',
  '工程包媒体大小超限: {name}': 'Package media exceeds the size limit: {name}',
  '工程包媒体安全名称冲突: {src}': 'Package media safe-name collision: {src}',
  '工程包媒体 src 重复: {src}': 'Duplicate package media src: {src}',
  '工程包媒体 base64 数据损坏': 'Corrupt base64 data in the package media',
  '工程包记录不是合法 JSON': 'A package record is not valid JSON',
  '工程包记录超过单行上限': 'A package record exceeds the single-line limit',
  '工程包解析失败，临时媒体清理也失败': 'The package failed to parse, and cleaning up the temporary media also failed',
  '工程发布失败，媒体回滚或临时清理也失败': 'Publishing the package failed, and rolling back the media or cleaning up also failed',
  '工程包提案记录校验不通过': 'The package proposal records failed validation',
  '工程包提案记录转换失败': 'The package proposal records failed to convert',
  '工程不存在或已损坏': 'The project does not exist or is corrupt',
  '此文件不是可读取的文档': 'This file is not a readable document',
  '一次最多读取 {max} 个文档': 'Read at most {max} documents at a time',
  '读取文档失败 ({status})': 'Failed to read the document ({status})',

  // ── design-style transfer (src/persist/designStyleTransfer.ts) ───────────
  '配方名称': 'Recipe name',
  '{label}无效': 'Invalid {label}',
  '字体名称': 'Font name',
  '字体角色': 'Font role',
  '颜色值': 'Colour value',
  '颜色角色': 'Colour role',
  '缩略图地址': 'Thumbnail URL',
  '适用场景': 'Use cases',
  '工程创作指引': 'Project brief',

  // ── review (src/review/reviewModel.ts) ───────────────────────────────────
  '评论内容不能为空': 'A comment cannot be empty',
  '评论不能超过 {max} 个字符': 'A comment cannot exceed {max} characters',

  // ── FCPXML export (src/export/fcpxml.ts) ─────────────────────────────────
  'timelineToFcpxml: state.items 必须是数组': 'timelineToFcpxml: state.items must be an array',
  'timelineToFcpxml: state.fps 必须是正数': 'timelineToFcpxml: state.fps must be a positive number',
  'timelineToFcpxml: state.width/height 必须是正整数': 'timelineToFcpxml: state.width/height must be positive integers',
  'timelineToFcpxml: item {id} 的 startFrame 非法': 'timelineToFcpxml: item {id} has an invalid startFrame',
  'timelineToFcpxml: item {id} 的 durationInFrames 非法': 'timelineToFcpxml: item {id} has an invalid durationInFrames',

  // ── template sandbox (src/template-host.ts) ──────────────────────────────
  'sandbox 拒绝：检测到「{reason}」': 'Sandbox refused: found "{reason}"',
  'template: 找不到 `const NAME = (...)` 声明': 'template: no `const NAME = (...)` declaration found',
  'template: babel 无输出': 'template: babel produced no output',
  'template: 尚未完成编译': 'template: compilation has not finished',

  // ── export pipeline ──────────────────────────────────────────────────────
  // Rendered through t(error.key) / t(failure.message), so the Chinese text is
  // the key even though the t() call lives in another module.
  '导出文件为空': 'The export file is empty',
  '读取导出文件失败（HTTP {status}）': 'Failed to read the export file (HTTP {status})',
  '导出恢复所有权已失效': 'The export recovery claim is no longer valid',
  '导出恢复所有权已失效，请重试': 'The export recovery claim is no longer valid. Try again.',
  '导出目标授权已失效，请重新选择导出位置后重试': 'The export destination authorisation expired. Choose the export location again and retry.',
  '本机渲染器无法将此画布精确缩放到所选分辨率': 'The local renderer cannot scale this canvas to the chosen resolution exactly',
  'ProRes 422 HQ · 本机母带': 'ProRes 422 HQ · local mezzanine',
  '本机渲染失败': 'Local render failed',
  '等待导出…': 'Waiting to export…',
  '{n} 个 MG · ProRes 4444': '{n} motion graphics · ProRes 4444',

  // ── selection references and transcript progress ─────────────────────────
  '{time} 时间点': '{time} timepoint',
  '画面区域': 'Canvas region',
  '画面区域（{n} 个片段）': 'Canvas region ({n} clips)',
  '“{label}”（{n} 词）': '"{label}" ({n} words)',
  '字幕：{text}': 'Subtitles: {text}',
  '聊天第 {n} 条': 'Chat message {n}',
  '模型下载 {n}%': 'Model download {n}%',
  '加载模型 {file}': 'Loading model {file}',
  '模型包下载失败，请到 设置 → 本地模型 重试': 'Model pack download failed. Retry in Settings → Local models.',

  // ── chat, dashboard and library copy ─────────────────────────────────────
  'Agent 修改记录（{n}）': 'Agent change log ({n})',
  '加载更早消息（{n}）': 'Load earlier messages ({n})',
  '{label}：{hint}': '{label}: {hint}',
  '{label}（{code}）': '{label} ({code})',
  'SRT 导入失败：{detail}': 'SRT import failed: {detail}',
  '微移所选片段': 'Nudge selected clips',
  '粘贴片段效果': 'Paste clip effects',
  '应用全部': 'Apply all',
  '当前工程保存失败，已阻止切换工程': 'Saving the current project failed, so switching projects was blocked',
  '未命名风格': 'Untitled style',
  '{name} 扩展模板': '{name} template',
  '自定义转场': 'Custom transition',
  '轨道': 'Track',
  '文字': 'Text',
  '无法将此属性应用到全部选中片段。': 'This property cannot be applied to every selected clip.',
  '切换 WebCodecs…': 'Switching to WebCodecs…',
  '素材「{name}」已存在。覆盖会同步替换已在时间线中使用的该素材。': '"{name}" already exists. Overwriting also replaces the copy already used on the timeline.',
  '竖屏': 'Portrait',
  'xAI (订阅登录)': 'xAI (subscription sign-in)',

  // ── stored-name display (src/i18n/storedNames.ts, projectNames.ts) ───────
  // These read as dictionary keys because storedName()/displayProjectName()
  // call t() with the stored value. The stored document keeps the Chinese.
  '[Copy] {name}': '[Copy] {name}',
  '版本 {name}': 'Version {name}',
  '{adjective}{noun}': '{adjective} {noun}',
  '流光': 'Lumen',
  '静默': 'Quiet',
  '暖阳': 'Sunlit',
  '深蓝': 'Indigo',
  '轻盈': 'Airy',
  '锋利': 'Keen',
  '柔和': 'Soft',
  '斑斓': 'Vivid',
  '清冽': 'Crisp',
  '灼热': 'Ember',
  '朦胧': 'Haze',
  '澄澈': 'Clear',
  '序曲': 'Overture',
  '航迹': 'Wake',
  '棱镜': 'Prism',
  '潮汐': 'Tide',
  '织机': 'Loom',
  '回响': 'Echo',
  '飞羽': 'Plume',
  '砂丘': 'Dune',
  '苔原': 'Tundra',
  '穹顶': 'Vault',
  '流域': 'Basin',
  '星图': 'Star Chart',

  // ── T1: keys a ternary hid from the dictionary check ─────────────────────
  // `t(cond ? 'a' : 'b')` renders its key when the key is missing, so these
  // reached the screen in Chinese while both checks passed. The enforcement now
  // evaluates every ternary arm (scripts/i18n-allowlist.verify.mjs A2), which is
  // what surfaced them.
  '已到达编辑词流边界': 'Reached the edited-stream boundary',
  '编辑词流区间': 'Edited-stream range',
  '源区间': 'Source range',
  '锁定轨道': 'Lock track',
  '查看内容': 'View contents',
  '工程包媒体结束记录不匹配': 'Project package media end record does not match',
  '工程包含未知记录': 'Project package contains an unknown record',

  // ── stored data that reaches the screen through a render, not a name ─────
  // The placeholder text a new title clip is stored with (editor/textDefaults.ts)
  // and the suffix duplicating a sequence or clip appends. Both live in the
  // document, so both are translated where they are drawn.
  '双击编辑文字': 'Double-click to edit text',
  '{name} 副本': '{name} copy',
} satisfies Record<string, string>;
