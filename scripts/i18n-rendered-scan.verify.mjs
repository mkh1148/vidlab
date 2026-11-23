// Milestone B · the rendered scan.
//
// The dictionary check (scripts/i18n-english.verify.mjs) can only see text that
// goes through t()/tData(). It cannot see a Chinese string baked into a label
// table, a stored data name rendered raw, or a server message the browser shows
// verbatim — and those are exactly where a half-translated interface leaks.
//
// So this opens the BUILT app (dist/, served by scripts/serve-prod.mjs, never the
// dev server — P9) in headless Chrome with a STALE non-English preference pinned in
// localStorage — the migration case D-11 has to survive — walks the visible text and
// the user-facing attributes of every screen it can reach without owner data, and
// fails on:
//
//   - any CJK ideograph, kana or CJK punctuation anywhere visible;
//   - any fullwidth form (U+FF00–FFEF): `＋`, `＝`, `（`, `：` read as Chinese
//     typography to an English eye even when no ideograph is present, and the
//     B2 closure replaced every one of them with the locale-appropriate glyph;
//   - any Cyrillic codepoint (Russian leaking into the English interface);
//   - any language-switcher control: one interface language means no control may
//     offer another one (D-11 removed the cycling pill from both top bars);
//   - any server-authored message that is not English, including the media-dir
//     probe note that used to reach the settings status line in Chinese.
//
// It creates its own throwaway project with the CLI, on its own port, with its
// own data directory and its own browser profile, and closes all three by PID.
//
// Run: npx tsx scripts/i18n-rendered-scan.verify.mjs   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { freePort, repoRoot, request, scratchDir, startProdServer } from './a1-harness.mjs';

/** The same class the page-side scan uses, for text the server hands back. */
const LEAK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u0400-\u04ff\u{20000}-\u{2EBEF}\u{30000}-\u{3134F}]/u;

const dist = join(repoRoot, 'dist');
assert.ok(
  existsSync(join(dist, 'index.html')),
  `no built editor at ${dist} — run "npm run build" first (a dev-server scan would hide exactly what this looks for, P9)`,
);

// ── is the bundle the code we are checking? ─────────────────────────────────
// dist/ is whatever the last build left behind, so a scan of a stale bundle
// passes on source that no longer exists — the quietest way for this check to
// lie. Assert the build is at least as new as the newest tracked source file
// instead of building here: a build inside the check would hide the same
// staleness behind a minute of vite output.
//
// `*.verify.ts` / `*.check.ts` are excluded because nothing imports them, so
// they never reach the bundle and cannot make it stale. `public/` is excluded
// because the browser dev build writes uploads into public/media/uploads, which
// would make every scan after a dev upload fail on a bundle that is fine.
const SOURCE_PATHS = [
  'src',
  'server',
  'shared',
  'cli',
  'desktop',
  'index.html',
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'config/vite.config.ts',
];
const isBundledSource = (file) => !/\.(verify|check)\.(tsx?|mts|mjs)$/.test(file);
const listed = spawnSync('git', ['ls-files', '-z', '--', ...SOURCE_PATHS], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(listed.status, 0, `git ls-files failed while checking dist freshness: ${listed.stderr}`);
const distMtime = statSync(join(dist, 'index.html')).mtimeMs;
let newest = { file: 'none', mtime: 0 };
let newestCount = 0;
for (const file of listed.stdout.split('\0').filter(Boolean)) {
  if (!isBundledSource(file)) continue;
  const full = join(repoRoot, file);
  if (!existsSync(full)) continue;
  newestCount += 1;
  const { mtimeMs } = statSync(full);
  if (mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
}
const lagMinutes = (newest.mtime - distMtime) / 60000;
assert.ok(
  distMtime >= newest.mtime,
  `dist/ is stale: ${newest.file} is ${lagMinutes.toFixed(1)} min newer than dist/index.html — `
    + `the scan would check the previous build. Run "npm run build" first.`,
);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
assert.ok(chromePath, `no Chromium-family browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── the scan that runs inside the page ──────────────────────────────────────
//
// CJK is ideographs + kana + CJK punctuation + the fullwidth block. The
// fullwidth marks (U+FF0B ＋, U+FF1D ＝) were excluded while the English copy
// still used them as glyphs; B2 replaced those with ASCII, so a fullwidth
// codepoint on screen is now a leak like any other.
const SCAN_SOURCE = `((rootSelector) => {
  const LEAK = /[\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u0400-\\u04ff\\u{20000}-\\u{2EBEF}\\u{30000}-\\u{3134F}]/u;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-tip'];

  const isVisible = (element) => {
    if (!element || SKIP.has(element.tagName)) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return element.getClientRects().length > 0;
  };

  const selectorOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      const classes = [...node.classList].slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { text: '', found: [], missingRoot: rootSelector };
  const found = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!text || !LEAK.test(text)) continue;
    const element = node.parentElement;
    if (!isVisible(element)) continue;
    found.push({ kind: 'text', text, selector: selectorOf(element) });
  }
  for (const element of root.querySelectorAll('*')) {
    if (SKIP.has(element.tagName)) continue;
    for (const attr of ATTRS) {
      const value = element.getAttribute(attr);
      if (!value || !LEAK.test(value)) continue;
      if (!isVisible(element)) continue;
      found.push({ kind: 'attribute ' + attr, text: value, selector: selectorOf(element) });
    }
  }
  if (LEAK.test(document.title)) {
    found.push({ kind: 'document.title', text: document.title, selector: 'title' });
  }
  return { text: root.innerText, found };
})`;

// ── CDP over the WebSocket that Node ships with ─────────────────────────────
async function connectCdp(port) {
  let socketUrl = null;
  for (let attempt = 0; attempt < 120 && !socketUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      socketUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* browser not listening yet */ }
    if (!socketUrl) await sleep(250);
  }
  assert.ok(socketUrl, 'headless Chrome never exposed a debuggable page');

  const socket = new WebSocket(socketUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page threw');
    return result.value;
  };

  return { send, evaluate, close: () => socket.close() };
}

/** Poll a page-side predicate until it is true, or fail with what was on screen. */
async function waitFor(cdp, expression, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(250);
  }
  const text = await cdp.evaluate('document.body.innerText.slice(0, 400)');
  throw new Error(`timed out waiting for ${label}; page showed:\n${text}`);
}

/** Click the first element whose text or attribute matches, the way a person would. */
async function click(cdp, { selector, text, attribute }, label) {
  const clicked = await cdp.evaluate(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector ?? '*')})];
    const match = candidates.find((element) => {
      ${text ? `if ((element.innerText || '').replace(/\\s+/g, ' ').trim() !== ${JSON.stringify(text)}) return false;` : ''}
      ${attribute ? `if (element.getAttribute(${JSON.stringify(attribute.name)}) !== ${JSON.stringify(attribute.value)}) return false;` : ''}
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return element.getClientRects().length > 0;
    });
    if (!match) return false;
    match.click();
    return true;
  })()`);
  assert.ok(clicked, `could not click ${label} — the built app did not render it`);
  await sleep(600);
}

const home = await scratchDir('i18n-home');
const dataDir = await scratchDir('i18n-data');
const profileDir = await scratchDir('i18n-chrome');
const port = await freePort();
const debugPort = await freePort();
const server = await startProdServer({ home, dataDir, port });
let chrome = null;
let cdp = null;

const findings = [];
const screens = [];
const record = (screen, found, text) => {
  screens.push({ screen, leaks: found.length, text });
  for (const item of found) findings.push({ screen, ...item });
};

try {
  // ── a synthetic project: never the owner's library ────────────────────────
  const projectId = await new Promise((resolveProject, rejectProject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', join(repoRoot, 'cli', 'occ.mjs'),
      '--data-dir', dataDir, 'project', 'new', 'Milestone B scan', '--json',
    ], { cwd: repoRoot, env: { ...process.env, USERPROFILE: home, HOME: home } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.once('exit', (code) => {
      const match = out.match(/\{[\s\S]*\}/);
      if (code !== 0 || !match) rejectProject(new Error(`occ project new failed (${code}):\n${out}\n${err}`));
      else resolveProject(JSON.parse(match[0]).id);
    });
  });

  // ── a synthetic clip in the pool, for the D surface screen ────────────────
  // Imported BEFORE Chrome opens the project: a pool import takes the edit
  // session, and the browser holds it once the editor is open. The clip is one
  // second of flat grey — enough to select on the timeline, nothing to matte.
  {
    const require = createRequire(import.meta.url);
    const ffmpeg = require('ffmpeg-static');
    const clipPath = join(home, 'scan-clip.mp4');
    spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x404040:size=320x240:rate=30',
      '-frames:v', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', clipPath], { stdio: 'ignore' });
    assert.ok(existsSync(clipPath), 'the synthetic scan clip must be created');
    const imported = spawnSync(process.execPath, [
      '--import', 'tsx', join(repoRoot, 'cli', 'occ.mjs'),
      '--data-dir', dataDir, 'tools', 'call', 'import_asset',
      '--args', JSON.stringify({ path: clipPath }), '--apply', '--json',
    ], { cwd: repoRoot, env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8' });
    assert.equal(imported.status, 0, `import_asset failed (${imported.status}):\n${imported.stdout}\n${imported.stderr}`);
  }

  // ── headless Chrome, its own profile, its own port ────────────────────────
  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1600,1000',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio: 'ignore' });
  cdp = await connectCdp(debugPort);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // A profile that stored a non-English preference in an older build must still
  // boot English: D-11 migrates the choice by ignoring it. Pinning 'zh' here makes
  // every screen below a migration test, not just an English-interface test.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('cc.locale', 'zh'); } catch (error) {}`,
  });

  const origin = `http://127.0.0.1:${port}`;
  const navigate = async (hash, readyExpression, label) => {
    await cdp.send('Page.navigate', { url: `${origin}/${hash}` });
    await waitFor(cdp, readyExpression, label);
    const lang = await cdp.evaluate('document.documentElement.lang');
    assert.equal(lang, 'en', `the interface language must be English before scanning ${label}, got "${lang}"`);
  };
  const scan = async (screen, rootSelector = null) => {
    const { found, text, missingRoot } = await cdp.evaluate(`${SCAN_SOURCE}(${JSON.stringify(rootSelector)})`);
    assert.equal(missingRoot, undefined, `${screen}: no element matched ${rootSelector}`);
    record(screen, found, text);
    if (process.env.I18N_SCAN_DEBUG) {
      console.log(`\n──── ${screen} ────\n${String(text).slice(0, 2500)}`);
    }
    return found;
  };

  // ── no language switcher on any top bar ───────────────────────────────────
  // D-11 ships one interface language, so the pill that cycled zh/en/it/ru must
  // not exist. The label is taken from the dictionary it used to render, so a
  // renamed string cannot hide a re-introduced toggle, and the old glyph is
  // checked by text as well.
  const SWITCHER_LABELS = JSON.stringify(['Switch UI language', '中']);
  const assertNoLanguageSwitcher = async (screen) => {
    const toggles = await cdp.evaluate(`(() => {
      const labels = ${SWITCHER_LABELS};
      return [...document.querySelectorAll('button')].filter((element) => {
        const text = (element.innerText || '').trim();
        const tips = ['aria-label', 'data-tip', 'title']
          .map((name) => element.getAttribute(name));
        return labels.includes(text) || tips.some((tip) => labels.includes(tip));
      }).length;
    })()`);
    assert.equal(toggles, 0, `${screen}: the interface has one language — no language-switcher button may exist`);
  };

  // ── screen 1: the project list ────────────────────────────────────────────
  await navigate('', `document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 'the project list');
  await waitFor(cdp, `(document.body.innerText || '').includes('Milestone B scan')`, 'the synthetic project card');
  await scan('project list');
  await assertNoLanguageSwitcher('project list');

  // The pinned 'zh' must be GONE from storage by now: D-11 reads the stored preference and
  // migrates it to English on load. A value still sitting there means the migration is
  // ignore-only, and the next build that reads the key would boot Chinese again.
  const migrated = await cdp.evaluate(`(() => { try { return localStorage.getItem('cc.locale'); } catch (error) { return String(error); } })()`);
  assert.equal(migrated, 'en',
    `a stored non-English preference must be migrated to English on load, storage holds ${JSON.stringify(migrated)}`);

  // ── screen 2: the settings dialog (opened from the project list) ──────────
  // The settings dialog carries no role and no class — it is an inline-styled
  // fixed overlay — so readiness is "a full-screen fixed layer with content".
  const DIALOG_READY = `[...document.querySelectorAll('div')].some((element) => {
    const style = getComputedStyle(element);
    return style.position === 'fixed' && Number(style.zIndex) >= 100
      && element.getClientRects().length > 0 && (element.innerText || '').length > 60;
  })`;
  await click(cdp, { selector: 'button', attribute: { name: 'aria-label', value: 'Settings · API Keys' } }, 'the settings button');
  await waitFor(cdp, DIALOG_READY, 'the settings dialog');
  await scan('settings dialog');

  // The connection test is the one place where a SERVER-authored sentence lands
  // in the interface verbatim: the button is translated, the answer is not.
  const tested = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => /^(Test connection|Test proxy connection|Test & load models)$/.test((element.innerText || '').trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (tested) {
    await sleep(2500);
    await scan('settings dialog · connection test');
  }

  // ── screen 3: the editor shell ────────────────────────────────────────────
  await navigate(`#/editor/${projectId}`, `document.querySelector('.cc-topbar')`, 'the editor shell');
  await waitFor(cdp, `(document.body.innerText || '').length > 200`, 'the editor to paint');
  await sleep(1500); // lazy panels (library, inspector) mount after the shell
  await scan('editor shell');
  await assertNoLanguageSwitcher('editor shell');

  // ── screen 4: every library panel tab (media, sequences, library, …) ──────
  const tabs = await cdp.evaluate(`[...document.querySelectorAll('.cc-main-tab')]
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => (element.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter((label) => label && label.length < 24)`);
  for (const tab of [...new Set(tabs)]) {
    const opened = await cdp.evaluate(`(() => {
      const target = [...document.querySelectorAll('.cc-main-tab')]
        .find((element) => (element.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(tab)});
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!opened) continue;
    await sleep(900);
    await scan(`editor · ${tab}`);
  }

  // ── screen 5: the background-removal inspector (D1) ───────────────────────
  // The D surface is new and English-only by decision (docs/d-job-implementation.md),
  // so it gets its own screen instead of riding on the editor shell: a video clip
  // selected on the timeline, the inspector's Video tab open, and the
  // background-removal control rendered in its idle state. The clip is a synthetic
  // one-second file imported into the throwaway project's pool before the browser
  // opens the project (the pool import takes the edit session, which the browser
  // holds once the editor is open) — the owner's library is never touched, and the
  // job is never started: this scan proves the COPY, not the engine.
  {
    await navigate(`#/editor/${projectId}`, `document.querySelector('.cc-topbar')`, 'the editor shell');
    await sleep(1800); // the media pool loads its assets after the shell
    // The panel remembers its last main tab, and screen 4 visits every one of
    // them, so the pool is only on screen after selecting "My Media" again.
    await click(cdp, { selector: '.cc-main-tab', text: 'My Media' }, 'the My Media tab');
    await waitFor(cdp, `document.querySelector('.cc-asset-card')`, 'the imported clip in the media pool');
    // Double-click adds to the timeline; the handler sits on the card, not the
    // thumbnail button inside it.
    const added = await cdp.evaluate(`(() => {
      const card = document.querySelector('.cc-asset-card');
      if (!card) return false;
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    assert.ok(added, 'the imported clip must appear in the media pool');
    await waitFor(cdp, `document.querySelectorAll('.cc-timeline-clip').length > 0`, 'the clip on the timeline');
    await sleep(600);
    await cdp.evaluate(`(() => {
      const clip = document.querySelector('.cc-timeline-clip');
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        clip.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    await sleep(600);
    const videoTab = await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.cc-insp-tabs button')]
        .find((element) => (element.innerText || '').trim() === 'Video');
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    assert.ok(videoTab, 'the inspector must offer a Video tab for a video clip');
    await waitFor(
      cdp,
      `(document.querySelector('.cc-inspector')?.innerText || '').includes('Background removal')`,
      'the background-removal control',
    );
    await scan('editor · inspector · background removal', '.cc-inspector');
  }

  // ── screen 5a-bis: the face-retouch inspector (D4) ────────────────────────
  // Same rule again: the D surface is English-only by decision. The control sits
  // on the Video tab directly under the background-removal one, so the clip and
  // the tab are already in place. The analysis is never started — it would need
  // the face model and a real face — so this screen proves the idle copy (the
  // sentence that explains what the pass does, and the button that starts it).
  {
    await waitFor(
      cdp,
      `(document.querySelector('.cc-inspector')?.innerText || '').includes('Face retouch')`,
      'the face-retouch control',
    );
    await scan('editor · inspector · face retouch', '.cc-inspector');
  }

  // ── screen 5b: the voice clean-up inspector (D2) ──────────────────────────
  // Same rule as D1's screen: the D surface is English-only by decision, so it
  // gets its own screen instead of riding on the editor shell. The clip selected
  // by the previous screen is still selected, so this only switches the
  // inspector to the Audio tab and waits for the control in its idle state. The
  // job is never started: this scan proves the COPY, not the engine.
  {
    const audioTab = await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.cc-insp-tabs button')]
        .find((element) => (element.innerText || '').trim() === 'Audio');
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    assert.ok(audioTab, 'the inspector must offer an Audio tab for a video clip');
    await waitFor(
      cdp,
      `(document.querySelector('.cc-inspector')?.innerText || '').includes('Voice clean-up')`,
      'the voice clean-up control',
    );
    await scan('editor · inspector · voice clean-up', '.cc-inspector');
  }

  // ── screen 5d: the voice-isolation inspector (D6) ─────────────────────────
  // Same rule as the other D screens: English-only by decision, so it gets its
  // own screen. The clip is still selected and the Audio tab is still open, so
  // this only waits for the D6 control in its idle state (no job started: this
  // scan proves the COPY, the engine is proven by the D6 verifies).
  {
    await waitFor(
      cdp,
      `(document.querySelector('.cc-inspector')?.innerText || '').includes('Voice isolation')`,
      'the voice-isolation control',
    );
    await scan('editor · inspector · voice isolation', '.cc-inspector');
  }

  // ── screen 5c: the caption-track inspector (D3b) ──────────────────────────
  // Same rule again: the D surface is English-only by decision. The synthetic
  // clip has no transcript, so the control renders its idle state (the sentence
  // that sends the user to transcription) — that is the copy this screen proves.
  // The caption track is never created here: this scan proves the COPY, not the
  // engine (captionTrack.verify.ts proves the engine).
  {
    await waitFor(
      cdp,
      `(document.querySelector('.cc-inspector')?.innerText || '').includes('This clip has no transcript yet')`,
      'the caption-track control',
    );
    await scan('editor · inspector · caption track', '.cc-inspector');
  }

  // ── screen 5: version history, and its save-name input ────────────────────
  // The panel's own copy is dictionary text, but the ROWS it lists are stored
  // names ("自动保存" for an autosave, "未命名版本" for an unnamed snapshot), which
  // is why they go through i18n/storedNames.ts. This scans the panel the way it
  // opens on a fresh project, then with the save input visible.
  await click(cdp, { selector: 'button', attribute: { name: 'aria-label', value: 'Version History' } }, 'the version history button');
  await waitFor(cdp, `(document.body.innerText || '').includes('Save Current Version')`, 'the version history panel');
  await sleep(600); // the panel is a lazy chunk
  await scan('version history');
  const savingVersion = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.innerText || '').trim() === 'Save Current Version');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (savingVersion) {
    await sleep(500);
    await scan('version history · save');
  }
  await click(cdp, { selector: 'button', attribute: { name: 'title', value: 'Close' } }, 'the version history close button');

  // ── screen 6: the export dialog ───────────────────────────────────────────
  await click(cdp, { selector: 'button', attribute: { name: 'aria-label', value: 'Export MP4' } }, 'the export button');
  await waitFor(cdp, `document.querySelector('.cc-export-panel')`, 'the export dialog');
  await sleep(800);
  await scan('export dialog', '.cc-export-panel');

  // ── the settings answers the SERVER authors ───────────────────────────────
  // The connection test is the one place where a sentence written on the server
  // reaches the screen. Clicking every vendor page would be fragile, so the same
  // endpoint the button calls is asked directly, with the interface language the
  // browser mirrored. Every answer must be English.
  // A write from this script has to look like the write the browser makes: the
  // request-shape gate (server/project-store-http-auth.ts) wants a loopback
  // socket, a loopback Host, an Origin matching Host and a browser-enforced
  // Sec-Fetch-Site. Without the last two it answers 403 before the handler runs.
  const writeHeaders = {
    'content-type': 'application/json',
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
  };
  const mirrored = await request(port, '/api/keys', {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ UI_LOCALE: 'en' }),
  });
  assert.equal(mirrored.status, 200, 'the browser-mirrored interface language must be accepted');
  for (const page of ['llm/anthropic', 'agent/proxy', 'storage/projects', 'storage/local']) {
    const answer = await request(port, '/api/keys/test', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ page, overrides: {} }),
    });
    assert.equal(answer.status, 200, `POST /api/keys/test for ${page} must answer`);
    const { message } = JSON.parse(answer.text());
    assert.equal(typeof message, 'string', `the probe for ${page} must answer with a message`);
    const screen = `server answer · ${page}`;
    if (process.env.I18N_SCAN_DEBUG) console.log(`\n──── ${screen} ────\n${message}`);
    screens.push({ screen, leaks: LEAK.test(message) ? 1 : 0, text: message });
    if (LEAK.test(message)) {
      findings.push({ screen, kind: 'server message', text: message, selector: 'POST /api/keys/test' });
    }
  }

  // The Italian-leak pass is gone with the Italian payload (D-11): there is no
  // second dictionary left whose values could reach the screen, so the CJK /
  // Cyrillic / fullwidth classes above are the whole leak surface.
} finally {
  if (cdp) cdp.close();
  if (chrome && chrome.exitCode === null) {
    // Chrome's crashpad handler and renderer children outlive the parent on
    // Windows and keep the profile directory locked, so kill the tree.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      chrome.kill('SIGTERM');
      await sleep(500);
      if (chrome.exitCode === null) chrome.kill('SIGKILL');
    }
  }
  await server.stop();
  // A helper process the app spawned can still hold a file open for a moment
  // (the Codex log store is one). The directories are throwaway; a leftover is
  // noise, not a failure — retry briefly, then let the OS clean up.
  for (const dir of [home, dataDir, profileDir]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 2 });
        break;
      } catch {
        await sleep(500);
      }
    }
  }
}

const summary = screens.map((screen) => `${screen.screen}: ${screen.leaks}`).join(' · ');
if (findings.length > 0) {
  console.error(`i18n rendered scan FAILED — ${findings.length} finding(s) across ${screens.length} screens`);
  console.error(`screens scanned: ${summary}`);
  for (const finding of findings) {
    console.error(`  [${finding.screen}] ${finding.kind}: ${JSON.stringify(finding.text)}  at ${finding.selector}`);
  }
  process.exit(1);
}

console.log(`i18n rendered scan: clean on the built app — ${screens.length} screens, no CJK, no Cyrillic, no language switcher`);
console.log(`screens scanned: ${summary}`);
console.log(`dist freshness: dist/index.html is newer than all ${newestCount} tracked source files (newest: ${newest.file})`);
