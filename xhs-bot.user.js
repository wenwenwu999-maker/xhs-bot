// ==UserScript==
// @name         小红书自动浏览点赞收藏评论
// @namespace    xhs-bot
// @version      2.1.3
// @description  流式浏览：滑两下点开一篇，看完返回继续；按概率点赞/收藏/评论
// @match        https://www.xiaohongshu.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__xhsBotLoaded) return;
  window.__xhsBotLoaded = true;

  /* ------------------------------ 工具 ------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rnd(a, b + 1));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const todayKey = () =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

  const logUniform = (min, max) =>
    Math.exp(Math.log(min) + Math.random() * (Math.log(max) - Math.log(min)));
  const pauseSec = (min, max) => sleep(logUniform(min, max) * 1000);

  const CFG_KEY = 'xhsBot.config.v2';
  const STATE_KEY = 'xhsBot.state.v2';
  const RUN_KEY = 'xhsBot.run.v3';
  const START_PENDING = 'xhsBot.startPending';

  const NOTE_ID_RE = /\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i;
  const EXPLORE_URL = 'https://www.xiaohongshu.com/explore';

  const DEFAULT_CFG = {
    maxNotes: 10,
    maxCommentsPerNote: 3,
    maxDailyLikes: 100,
    maxDailyCollects: 50,
    maxDailyComments: 15,
    maxCommentsPerRun: 5,
    skipVisitedDays: 3,
    likeEnabled: true,
    collectEnabled: true,
    commentEnabled: true,
    commentLikeEnabled: true,
    likeChance: 0.65,
    collectChance: 0.22,
    commentChance: 0.3,
    commentsPerNoteMax: 5,
    commentPool: [],
    dryRun: true,
  };

  let cfg = loadCfg();
  let state = loadState();
  let run = loadRun();
  let running = false;
  let ui = null;
  let autoSaveTimer = null;
  let tickTimer = null;

  /* ------------------------------ 配置 / 状态 ------------------------------ */

  function loadCfg() {
    try {
      return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY) || '{}')) };
    } catch {
      return { ...DEFAULT_CFG };
    }
  }

  function saveCfg() {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }

  function loadState() {
    const s = {
      date: todayKey(),
      dailyLikes: 0,
      dailyCollects: 0,
      dailyComments: 0,
      likedNotes: {},
      collectedNotes: {},
      commentedNotes: {},
      visitedNotes: {},
      runs: 0,
    };
    try {
      Object.assign(s, JSON.parse(localStorage.getItem(STATE_KEY) || '{}'));
    } catch {
      // 忽略损坏数据
    }
    if (s.date !== todayKey()) {
      s.date = todayKey();
      s.dailyLikes = 0;
      s.dailyCollects = 0;
      s.dailyComments = 0;
    }
    return s;
  }

  function saveState() {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  }

  function recentlyVisited(id) {
    const ts = state.visitedNotes[id];
    if (!ts || cfg.skipVisitedDays <= 0) return false;
    return Date.now() - ts < cfg.skipVisitedDays * 24 * 60 * 60 * 1000;
  }

  function loadRun() {
    const base = {
      active: false,
      phase: 'browsing',
      processed: 0,
      maxNotes: 10,
      paused: false,
      pendingId: null,
      pendingTitle: '',
      commentsPosted: 0,
      usedComments: [],
      startedAt: 0,
    };
    try {
      return { ...base, ...(JSON.parse(sessionStorage.getItem(RUN_KEY) || '{}')) };
    } catch {
      return base;
    }
  }

  function saveRun() {
    sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
  }

  function getUrlNoteId() {
    const m = location.pathname.match(NOTE_ID_RE);
    return m ? m[1].toLowerCase() : null;
  }

  /* ------------------------------ 界面 ------------------------------ */

  function buildUI() {
    if (document.getElementById('xhs-bot-host')) return;

    const host = document.createElement('div');
    host.id = 'xhs-bot-host';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .panel{width:300px;background:#1e1e1e;color:#eee;border:1px solid #3a3a3a;border-radius:10px;
               font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden}
        .head{padding:8px 10px;background:#2a2a2a;display:flex;justify-content:space-between;align-items:center}
        .head b{font-size:13px;font-weight:600}
        .head span{font-size:11px;color:#9a9a9a}
        .body{padding:10px;max-height:82vh;overflow:auto}
        .row{display:flex;gap:6px;margin-bottom:8px}
        button{flex:1;padding:6px 0;border:0;border-radius:6px;cursor:pointer;font-size:12px;color:#fff;background:#3a3a3a}
        button.primary{background:#ff2442}
        button:disabled{opacity:.4;cursor:not-allowed}
        label{display:flex;align-items:center;justify-content:space-between;margin:5px 0;font-size:12px;color:#bdbdbd}
        label.block{display:block}
        input[type=number]{width:58px;background:#111;color:#eee;border:1px solid #3d3d3d;border-radius:4px;padding:2px 4px;font-size:12px}
        input[type=checkbox]{accent-color:#ff2442;margin:0}
        textarea{width:100%;box-sizing:border-box;height:62px;margin-top:4px;background:#111;color:#eee;border:1px solid #3d3d3d;
                 border-radius:4px;padding:4px;font-size:11px;resize:vertical}
        .count{margin-top:8px;font-size:12px;color:#ff8a9a}
        .status{margin-top:6px;padding:6px;background:#111;border-radius:6px;font-size:12px;color:#ddd;min-height:18px;word-break:break-all}
        .log{margin-top:6px;height:66px;overflow:hidden;font-size:11px;color:#8a8a8a}
        .log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:18px}
      </style>
      <div class="panel">
        <div class="head"><b>小红书自动浏览</b><span id="runState">空闲</span></div>
        <div class="body">
          <div class="row">
            <button id="start" class="primary">开始</button>
            <button id="pause" disabled>暂停</button>
            <button id="stop" disabled>停止</button>
          </div>
          <label>浏览篇数 <input id="notes" type="number" min="1" max="50"></label>
          <label>评论点赞/篇 <input id="comments" type="number" min="0" max="10"></label>
          <label>每日点赞上限 <input id="daily" type="number" min="0" max="500"></label>
          <label>点赞概率 % <input id="likeRate" type="number" min="0" max="100"></label>
          <label>收藏概率 % <input id="collectRate" type="number" min="0" max="100"></label>
          <label>评论概率 % <input id="cmtRate" type="number" min="0" max="100"></label>
          <label>每篇评论 0~ <input id="cmtPerNote" type="number" min="0" max="10"></label>
          <label>每日评论上限 <input id="cmtMax" type="number" min="0" max="100"></label>
          <label>单次评论上限 <input id="cmtRun" type="number" min="0" max="50"></label>
          <label>点赞 <input id="enLike" type="checkbox"></label>
          <label>收藏 <input id="enCollect" type="checkbox"></label>
          <label>评论 <input id="enComment" type="checkbox"></label>
          <label class="block">评论池（每行一条，随机使用；留空则不发评论）
            <textarea id="pool" placeholder="写得真好，学到了&#10;这个我也去过，同感"></textarea>
          </label>
          <label>试运行（不操作） <input id="dry" type="checkbox"></label>
          <div class="count" id="count"></div>
          <div class="status" id="status">空闲</div>
          <div class="log" id="log"></div>
        </div>
      </div>`;

    document.documentElement.appendChild(host);

    const $ = (id) => root.querySelector('#' + id);
    ui = {
      start: $('start'),
      pause: $('pause'),
      stop: $('stop'),
      notes: $('notes'),
      comments: $('comments'),
      daily: $('daily'),
      likeRate: $('likeRate'),
      collectRate: $('collectRate'),
      cmtRate: $('cmtRate'),
      cmtPerNote: $('cmtPerNote'),
      cmtMax: $('cmtMax'),
      cmtRun: $('cmtRun'),
      enLike: $('enLike'),
      enCollect: $('enCollect'),
      enComment: $('enComment'),
      pool: $('pool'),
      dry: $('dry'),
      count: $('count'),
      status: $('status'),
      runState: $('runState'),
      log: $('log'),
    };

    ui.notes.value = cfg.maxNotes;
    ui.comments.value = cfg.maxCommentsPerNote;
    ui.daily.value = cfg.maxDailyLikes;
    ui.likeRate.value = Math.round(cfg.likeChance * 100);
    ui.collectRate.value = Math.round(cfg.collectChance * 100);
    ui.cmtRate.value = Math.round(cfg.commentChance * 100);
    ui.cmtPerNote.value = cfg.commentsPerNoteMax;
    ui.cmtMax.value = cfg.maxDailyComments;
    ui.cmtRun.value = cfg.maxCommentsPerRun;
    ui.enLike.checked = !!cfg.likeEnabled;
    ui.enCollect.checked = !!cfg.collectEnabled;
    ui.enComment.checked = !!cfg.commentEnabled;
    ui.pool.value = (cfg.commentPool || []).join('\n');
    ui.dry.checked = !!cfg.dryRun;

    ui.start.addEventListener('click', onStart);
    ui.pause.addEventListener('click', onPause);
    ui.stop.addEventListener('click', onStop);

    const autoSave = () => {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        try {
          readConfigFromUI();
        } catch {
          // ignore
        }
      }, 500);
    };

    [
      ui.notes,
      ui.comments,
      ui.daily,
      ui.likeRate,
      ui.collectRate,
      ui.cmtRate,
      ui.cmtPerNote,
      ui.cmtMax,
      ui.cmtRun,
      ui.pool,
      ui.enLike,
      ui.enCollect,
      ui.enComment,
      ui.dry,
    ]
      .filter(Boolean)
      .forEach((el) => {
        el.addEventListener('input', autoSave);
        el.addEventListener('change', autoSave);
      });

    updateCount();
    setStatus('空闲');
    syncButtons();
  }

  function setStatus(text) {
    if (ui) ui.status.textContent = text;
    console.log('[xhs-bot]', text);
  }

  function syncButtons() {
    if (!ui) return;
    ui.start.disabled = run.active;
    ui.pause.disabled = !run.active;
    ui.stop.disabled = !run.active;
    ui.pause.textContent = run.paused ? '继续' : '暂停';
    ui.runState.textContent = run.active
      ? run.paused
        ? '已暂停'
        : `运行中 ${run.processed}/${run.maxNotes}`
      : '空闲';
  }

  function logLine(text) {
    console.log('[xhs-bot]', text);
    if (!ui) return;
    const div = document.createElement('div');
    div.textContent = text;
    ui.log.prepend(div);
    while (ui.log.children.length > 4) ui.log.lastElementChild.remove();
  }

  function updateCount() {
    if (!ui) return;
    ui.count.textContent =
      `今日 赞${state.dailyLikes}/${cfg.maxDailyLikes} · ` +
      `藏${state.dailyCollects}/${cfg.maxDailyCollects} · ` +
      `评${state.dailyComments}/${cfg.maxDailyComments}`;
  }

  /* ------------------------------ 控制 ------------------------------ */

  function readConfigFromUI() {
    cfg.maxNotes = clamp(parseInt(ui.notes.value, 10) || 10, 1, 50);
    cfg.maxCommentsPerNote = clamp(parseInt(ui.comments.value, 10) || 0, 0, 10);
    cfg.maxDailyLikes = clamp(parseInt(ui.daily.value, 10) || 0, 0, 500);
    cfg.likeChance = clamp((parseInt(ui.likeRate.value, 10) || 0) / 100, 0, 1);
    cfg.collectChance = clamp((parseInt(ui.collectRate.value, 10) || 0) / 100, 0, 1);
    cfg.commentChance = clamp((parseInt(ui.cmtRate.value, 10) || 0) / 100, 0, 1);
    cfg.commentsPerNoteMax = clamp(parseInt(ui.cmtPerNote.value, 10) || 0, 0, 10);
    cfg.maxDailyComments = clamp(parseInt(ui.cmtMax.value, 10) || 0, 0, 100);
    cfg.maxCommentsPerRun = clamp(parseInt(ui.cmtRun.value, 10) || 0, 0, 50);
    cfg.likeEnabled = !!ui.enLike.checked;
    cfg.collectEnabled = !!ui.enCollect.checked;
    cfg.commentEnabled = !!ui.enComment.checked;
    cfg.dryRun = !!ui.dry.checked;
    cfg.commentPool = ui.pool.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30);
    saveCfg();
    updateCount();
  }

  function onStart() {
    if (run.active) return;
    readConfigFromUI();

    if (getUrlNoteId()) {
      sessionStorage.setItem(START_PENDING, '1');
      location.href = EXPLORE_URL;
      return;
    }

    run = {
      active: true,
      phase: 'browsing',
      processed: 0,
      maxNotes: cfg.maxNotes,
      paused: false,
      pendingId: null,
      pendingTitle: '',
      commentsPosted: 0,
      usedComments: [],
      startedAt: Date.now(),
    };
    saveRun();
    state.runs = (state.runs || 0) + 1;
    running = true;
    syncButtons();
    logLine(cfg.dryRun ? '开始（试运行，不操作）' : '开始（会真的点赞/收藏/评论）');
    setStatus('边滑边看，准备点开第一篇...');
    scheduleTick(randInt(1200, 2500));
  }

  function onPause() {
    if (!run.active) return;
    run.paused = !run.paused;
    saveRun();
    syncButtons();
    setStatus(run.paused ? '已暂停' : '继续运行');
  }

  function onStop() {
    run.active = false;
    run.phase = 'done';
    saveRun();
    running = false;
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    syncButtons();
    logLine('已停止');

    if (getUrlNoteId()) {
      setStatus('已停止，返回发现页...');
      location.replace(EXPLORE_URL);
    }
  }

  async function waitIfPaused() {
    while (run.paused && run.active) await sleep(400);
  }

  /* ------------------------------ 页面工具 ------------------------------ */

  function isLiked(el) {
    if (!el) return false;
    const use = el.querySelector('use');
    return !!use && (use.getAttribute('href') || '').includes('liked');
  }

  function isCollected(el) {
    if (!el) return false;
    const use = el.querySelector('use');
    return !!use && /collected|collect_active/i.test(use.getAttribute('href') || '');
  }

  function isShown(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 8;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top > 0 && r.bottom <= window.innerHeight;
  }

  function findBlockMarker() {
    const text = (document.body && document.body.innerText) || '';
    return (
      ['请完成安全验证', '访问频繁', '操作频繁', '账号异常', '网络环境存在风险'].find((m) =>
        text.includes(m)
      ) || ''
    );
  }

  async function ensureNoBlock() {
    const marker = findBlockMarker();
    if (!marker) return run.active;

    logLine(`检测到安全验证（${marker}），请手动完成`);
    setStatus('需要手动验证：完成后自动继续');
    run.paused = true;
    saveRun();
    syncButtons();

    while (findBlockMarker() && run.active) await sleep(2000);

    run.paused = false;
    saveRun();
    syncButtons();
    if (run.active) logLine('验证已通过，继续');
    return run.active;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function findCommentEditor() {
    const candidates = [
      ...document.querySelectorAll('.comments-container [contenteditable="true"]'),
      ...document.querySelectorAll('[class*="comment"] [contenteditable="true"]'),
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('.comments-container textarea'),
      ...document.querySelectorAll('[class*="comment"] textarea'),
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[role="textbox"]'),
    ];

    for (const el of candidates) {
      if (!isShown(el)) continue;
      const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''}`;
      if (/搜索/.test(hint)) continue;
      return el;
    }
    return null;
  }

  function findCommentTrigger() {
    const re = /说点什么|写下你的评论|善语结善缘|发布你的评论|留下你的评论/;
    const nodes = [...document.querySelectorAll('div, span, p, button')];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i];
      const t = (el.innerText || '').trim();
      if (!t || t.length > 24 || !re.test(t)) continue;
      if (!isShown(el)) continue;
      if (el.getBoundingClientRect().width < 60) continue;
      return el;
    }
    return null;
  }

  async function ensureCommentEditor() {
    let editor = findCommentEditor();
    if (editor) return editor;

    const trigger = findCommentTrigger();
    if (trigger) {
      trigger.click();
      await pauseSec(0.7, 1.4);
      editor = findCommentEditor();
    }
    return editor || null;
  }

  function findSendButton(editor) {
    const nodes = [...document.querySelectorAll('button, span, div')];
    const matches = nodes.filter((el) => {
      if (!isShown(el)) return false;
      const t = (el.innerText || '').trim();
      if (!/^(发送|发布|评论)$/.test(t)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 24 && r.width <= 180 && r.height >= 12;
    });

    if (!matches.length) return null;

    if (editor) {
      const er = editor.getBoundingClientRect();
      const dist = (el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.top - er.top) + Math.abs(r.left - er.right);
      };
      matches.sort((a, b) => dist(a) - dist(b));
    }

    return matches[0];
  }

  function commentVisible(text) {
    const items = [...document.querySelectorAll('[class*="comment-item"]')].slice(0, 6);
    return items.some((el) => ((el.innerText || '').replace(/\s+/g, ' ')).includes(text));
  }

  function clearEditor(el) {
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    } catch {
      // 下面兜底
    }

    if ((el.innerText || '').trim()) {
      el.textContent = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }

  function typeInto(el, text) {
    el.focus();
    clearEditor(el);

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    try {
      document.execCommand('insertText', false, text);
    } catch {
      // 下面兜底
    }

    if (!((el.innerText || '').includes(text))) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  /* ------------------------------ 动作 ------------------------------ */

  async function likeNote(note) {
    const el = document.querySelector('.interact-container [class*="like-wrapper"]');
    if (!el) {
      logLine('没找到笔记赞按钮');
      return;
    }

    if (isLiked(el)) {
      logLine('笔记已赞过，跳过');
      state.likedNotes[note.id] = Date.now();
      saveState();
      return;
    }

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await pauseSec(0.3, 0.9);
    el.click();
    await pauseSec(0.9, 2.0);

    if (isLiked(el)) {
      state.dailyLikes++;
      state.likedNotes[note.id] = Date.now();
      saveState();
      updateCount();
      logLine('已点赞笔记');
    } else {
      logLine('笔记点赞没有生效');
    }
  }

  async function collectNote(note) {
    const el = document.querySelector('.interact-container [class*="collect-wrapper"]');
    if (!el) {
      logLine('没找到收藏按钮');
      return;
    }

    if (isCollected(el)) {
      logLine('笔记已收藏，跳过');
      state.collectedNotes[note.id] = Date.now();
      saveState();
      return;
    }

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await pauseSec(0.3, 0.9);
    el.click();
    await pauseSec(0.9, 2.0);

    if (isCollected(el)) {
      state.dailyCollects++;
      state.collectedNotes[note.id] = Date.now();
      saveState();
      updateCount();
      logLine('已收藏笔记');
    } else {
      logLine('收藏没有生效');
    }
  }

  async function postComment(note) {
    if (state.dailyComments >= cfg.maxDailyComments) {
      logLine('今日评论达到上限');
      return false;
    }
    if (run.commentsPosted >= cfg.maxCommentsPerRun) {
      logLine(`本次评论达到上限（${cfg.maxCommentsPerRun} 条）`);
      return false;
    }
    if (!cfg.commentPool.length) return false;

    if (!Array.isArray(run.usedComments)) run.usedComments = [];
    let candidates = cfg.commentPool
      .map((_, i) => i)
      .filter((i) => !run.usedComments.includes(i));
    if (!candidates.length) {
      run.usedComments = [];
      candidates = cfg.commentPool.map((_, i) => i);
    }
    const pickIndex = candidates[randInt(0, candidates.length - 1)];
    run.usedComments.push(pickIndex);
    saveRun();

    const text = cfg.commentPool[pickIndex];

    const editor = await ensureCommentEditor();
    if (!editor) {
      logLine('没找到评论输入框（可先手动点一下“说点什么”再试）');
      return false;
    }

    editor.scrollIntoView({ block: 'center', behavior: 'instant' });
    await pauseSec(0.4, 1.0);
    editor.click();
    await pauseSec(0.5, 1.2);
    typeInto(editor, text);
    await pauseSec(0.6, 1.6);

    const send = findSendButton(editor);
    if (!send) {
      logLine('没找到发送按钮，评论没发出去');
      return false;
    }

    send.click();
    await pauseSec(1.8, 3.2);

    if (commentVisible(text)) {
      run.commentsPosted++;
      saveRun();
      state.dailyComments++;
      state.commentedNotes[note.id] = Date.now();
      saveState();
      updateCount();
      logLine(`已发评论：${text.slice(0, 12)}`);
      return true;
    }

    logLine('评论可能没发出去（没在列表里看到）');
    return false;
  }

  async function likeComments(target) {
    let liked = 0;

    for (let round = 0; round <= 6; round++) {
      if (!run.active || liked >= target) break;
      if (state.dailyLikes >= cfg.maxDailyLikes) break;
      if (!(await ensureNoBlock())) break;

      const items = [...document.querySelectorAll('[class*="comment-item"] [class*="like-wrapper"]')];
      const pool = items.filter((el) => visible(el) && !isLiked(el));

      if (!pool.length) {
        await scrollComments();
        continue;
      }

      const before = items.filter(isLiked).length;
      const el = pool[randInt(0, pool.length - 1)];

      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await pauseSec(0.3, 0.8);
      el.click();
      await pauseSec(0.8, 1.6);

      const afterItems = [...document.querySelectorAll('[class*="comment-item"] [class*="like-wrapper"]')];
      const after = afterItems.filter(isLiked).length;

      if (after > before) {
        liked++;
        state.dailyLikes++;
        saveState();
        updateCount();
        logLine('已点赞评论');
      } else {
        logLine('评论点赞没有生效，停止本篇');
        break;
      }

      await pauseSec(1.2, 3.0);
    }
  }

  async function scrollComments() {
    const delta = randInt(300, 800);
    const item = document.querySelector('[class*="comment-item"]');
    let el = item ? item.parentElement : null;

    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 30) {
        el.scrollTop += delta;
        await pauseSec(0.6, 1.8);
        return;
      }
      el = el.parentElement;
    }

    window.scrollBy(0, delta);
    await pauseSec(0.6, 1.8);
  }

  async function loadComments(times) {
    const n = times === undefined ? randInt(1, 4) : times;
    for (let i = 0; i < n; i++) {
      await scrollComments();
      await waitIfPaused();
    }
  }

  /* ------------------------------ 计划 ------------------------------ */

  function dwellSeconds() {
    const r = Math.random();
    if (r < 0.3) return rnd(2, 6);
    if (r < 0.9) return rnd(8, 22);
    return rnd(25, 60);
  }

  function makePlan() {
    const plan = {
      like: cfg.likeEnabled && state.dailyLikes < cfg.maxDailyLikes && Math.random() < cfg.likeChance,
      collect:
        cfg.collectEnabled &&
        state.dailyCollects < cfg.maxDailyCollects &&
        Math.random() < cfg.collectChance,
      commentCount: 0,
      commentLikes: cfg.commentLikeEnabled ? randInt(0, cfg.maxCommentsPerNote) : 0,
    };

    if (
      cfg.commentEnabled &&
      cfg.commentsPerNoteMax > 0 &&
      cfg.commentPool.length > 0 &&
      state.dailyComments < cfg.maxDailyComments &&
      Math.random() < cfg.commentChance
    ) {
      plan.commentCount = randInt(1, cfg.commentsPerNoteMax);
    }

    if (Math.random() < 0.08) {
      plan.like = false;
      plan.collect = false;
      plan.commentCount = 0;
      plan.commentLikes = 0;
    }
    return plan;
  }

  function planText(plan) {
    const parts = [];
    if (plan.like) parts.push('赞');
    if (plan.collect) parts.push('收藏');
    if (plan.commentCount > 0) parts.push(`评论×${plan.commentCount}`);
    if (plan.commentLikes > 0) parts.push(`赞评论×${plan.commentLikes}`);
    return parts.length ? parts.join('、') : '只看';
  }

  function dailyAllReached() {
    return (
      state.dailyLikes >= cfg.maxDailyLikes &&
      state.dailyCollects >= cfg.maxDailyCollects &&
      state.dailyComments >= cfg.maxDailyComments
    );
  }

  async function waitForNotePage() {
    for (let i = 0; i < 60; i++) {
      if (!run.active) return false;
      if (document.querySelector('.interact-container')) {
        await sleep(600);
        return true;
      }
      const text = (document.body && document.body.innerText) || '';
      if (text.includes('当前笔记暂时无法浏览')) return 'blocked';
      if (text.includes('笔记不存在') || text.includes('内容已删除') || text.includes('该笔记无法浏览')) {
        return 'gone';
      }
      await sleep(250);
    }
    return false;
  }

  /* ------------------------------ 笔记页处理 ------------------------------ */

  async function doNoteActions(note) {
    if (!(await ensureNoBlock())) return false;

    const dwell = dwellSeconds();
    await sleep(dwell * 1000 * 0.4);
    await waitIfPaused();

    const plan = makePlan();
    if (run.commentsPosted >= cfg.maxCommentsPerRun) plan.commentCount = 0;
    logLine(`本篇计划：${planText(plan)}`);

    if (cfg.dryRun) {
      const noteLike = document.querySelector('.interact-container [class*="like-wrapper"]');
      const noteCollect = document.querySelector('.interact-container [class*="collect-wrapper"]');
      const commentLikes = [...document.querySelectorAll('[class*="comment-item"] [class*="like-wrapper"]')].filter(visible);
      logLine(
        `[试运行] 赞 ${isLiked(noteLike) ? '已点' : '未点'}，` +
          `藏 ${isCollected(noteCollect) ? '已藏' : '未藏'}，` +
          `可见评论赞按钮 ${commentLikes.length} 个，未赞 ${commentLikes.filter((el) => !isLiked(el)).length} 个`
      );
      return true;
    }

    if (plan.commentCount > 0 || plan.commentLikes > 0) {
      await loadComments(randInt(1, 4));
    }

    for (let c = 0; c < plan.commentCount; c++) {
      if (!run.active) break;
      if (run.commentsPosted >= cfg.maxCommentsPerRun) break;
      if (state.dailyComments >= cfg.maxDailyComments) break;
      const ok = await postComment(note);
      if (!ok) break;
      if (c < plan.commentCount - 1) await pauseSec(3, 8);
    }

    const actions = [];
    if (plan.like) actions.push(() => likeNote(note));
    if (plan.collect) actions.push(() => collectNote(note));
    shuffle(actions);

    for (const action of actions) {
      if (!run.active) break;
      await action();
      await pauseSec(1.2, 3.2);
    }

    if (plan.commentLikes > 0) {
      await likeComments(plan.commentLikes);
    }

    await sleep(dwell * 1000 * 0.6);
    await waitIfPaused();

    state.visitedNotes[note.id] = Date.now();
    saveState();
    updateCount();
    return true;
  }

  async function closeNoteOverlay() {
    const selectors = ['.close-circle', '[class*="close-circle"]', '[class*="note-close"]', '[class*="close-btn"]'];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isShown(el)) {
        el.click();
        await sleep(500);
        if (!document.querySelector('.interact-container')) return true;
      }
    }

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
    );
    await sleep(600);
    if (!document.querySelector('.interact-container')) return true;

    const mask = document.querySelector('[class*="mask"], [class*="overlay"]');
    if (mask && isShown(mask)) {
      mask.click();
      await sleep(600);
      if (!document.querySelector('.interact-container')) return true;
    }

    return false;
  }

  function goBackToFeed() {
    setStatus('返回信息流...');

    if (history.length > 1) {
      history.back();
      // 如果 1.6 秒后还停在笔记页，说明返回没生效，强制回发现页
      setTimeout(() => {
        if (getUrlNoteId()) location.replace(EXPLORE_URL);
      }, 1600);
    } else {
      location.replace(EXPLORE_URL);
    }

    running = false;
    syncButtons();
  }

  async function notePageStep() {
    running = true;
    syncButtons();

    const id = getUrlNoteId();
    const note = { id, title: run.pendingTitle || '', url: location.href };
    setStatus(`正在看：${note.title || id.slice(0, 8)}`);

    try {
      const pageState = await Promise.race([
        waitForNotePage(),
        sleep(20000).then(() => 'timeout'),
      ]);

      if (pageState === 'blocked') {
        logLine('这篇被限制（扫码页），返回');
      } else if (pageState === 'gone') {
        logLine('笔记不可浏览，返回');
      } else if (!pageState || pageState === 'timeout') {
        logLine('笔记没加载出来，返回');
      } else {
        await Promise.race([
          doNoteActions(note),
          sleep(180000).then(() => {
            throw new Error('处理超时（3 分钟）');
          }),
        ]);
      }
    } catch (err) {
      logLine('处理出错：' + err.message);
    } finally {
      run.processed++;
      run.phase = 'browsing';
      run.pendingId = null;
      saveRun();
      updateCount();
      syncButtons();

      await sleep(rnd(600, 1400));
      goBackToFeed();
    }
  }

  function finishRun() {
    run.active = false;
    run.phase = 'done';
    saveRun();
    running = false;
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    syncButtons();
    setStatus(`本次完成：共看 ${run.processed} 篇`);
    logLine(`本次完成：共看 ${run.processed} 篇`);
  }

  /* ------------------------------ 信息流浏览 ------------------------------ */

  function visibleCards() {
    const map = new Map();

    for (const a of document.querySelectorAll('a[href*="/explore/"]')) {
      const href = a.href;
      if (!href.includes('xsec_token=')) continue;

      const m = href.match(NOTE_ID_RE);
      if (!m) continue;

      const r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      if (r.top < 0 || r.bottom > window.innerHeight) continue;

      const id = m[1].toLowerCase();
      if (map.has(id)) continue;
      if (state.likedNotes[id] || recentlyVisited(id)) continue;

      const card = a.closest('section, [class*="note-item"]');
      const titleEl = card ? card.querySelector('[class*="title"]') : null;

      map.set(id, {
        id,
        href,
        title: titleEl ? (titleEl.innerText || '').trim().slice(0, 60) : '',
        anchor: a,
        card: card || a,
      });
    }

    return [...map.values()];
  }

  async function browseStep() {
    if (!run.active) return;
    if (run.paused) {
      scheduleTick(600);
      return;
    }
    if (run.processed >= run.maxNotes || dailyAllReached()) {
      finishRun();
      return;
    }

    if (findBlockMarker()) {
      await ensureNoBlock();
    }

    const steps = randInt(1, 3);
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, randInt(200, 650));
      await pauseSec(0.8, 3.5);
      await waitIfPaused();
      if (!run.active) return;
    }

    if (Math.random() < 0.25) {
      setStatus('继续往下滑...');
      scheduleTick(randInt(800, 3000));
      return;
    }

    const cards = visibleCards();
    if (!cards.length) {
      setStatus('当前屏没有可点的笔记，继续滑');
      scheduleTick(randInt(900, 2200));
      return;
    }

    const pick = cards[randInt(0, cards.length - 1)];

    run.phase = 'note';
    run.pendingId = pick.id;
    run.pendingTitle = pick.title;
    saveRun();

    logLine(`点开：${pick.title || pick.id.slice(0, 8)}`);
    setStatus(`点开：${pick.title || pick.id.slice(0, 8)}`);

    const oldTarget = pick.anchor.getAttribute('target');
    if (oldTarget) pick.anchor.setAttribute('target', '_self');

    // 防止页面用 window.open 新开标签页，导致当前页停在信息流、新标签页无人管理
    const origOpen = window.open;
    try {
      window.open = function (url) {
        if (typeof url === 'string' && url) {
          location.href = url;
          return null;
        }
        return origOpen.apply(window, arguments);
      };
    } catch {
      // ignore
    }

    pick.anchor.click();

    setTimeout(() => {
      try {
        window.open = origOpen;
      } catch {
        // ignore
      }
    }, 2500);

    if (oldTarget) setTimeout(() => pick.anchor.setAttribute('target', oldTarget), 1500);

    await sleep(1600);

    if (!run.active || run.phase !== 'note' || run.pendingId !== pick.id) return;

    if (document.querySelector('.interact-container')) {
      await doNoteActions({ id: pick.id, title: pick.title, url: pick.href });

      const closed = await closeNoteOverlay();
      if (!closed) {
        logLine('弹层关不掉，强制回发现页');
        location.replace(EXPLORE_URL);
        return;
      }
      await sleep(600);
    } else {
      logLine('点击没有打开笔记，跳过');
    }

    run.processed++;
    run.phase = 'browsing';
    run.pendingId = null;
    saveRun();
    updateCount();
    syncButtons();
    scheduleTick(randInt(1000, 2500));
  }

  function scheduleTick(ms) {
    if (!run.active) return;
    if (tickTimer) return;
    tickTimer = setTimeout(() => {
      tickTimer = null;
      tick();
    }, ms);
  }

  function tick() {
    if (!run.active) {
      running = false;
      syncButtons();
      return;
    }
    if (getUrlNoteId()) return;
    browseStep().catch((err) => {
      logLine('出错：' + err.message);
      scheduleTick(2000);
    });
  }

  function resumeBrowse() {
    if (!run.active) return;
    if (getUrlNoteId()) return;
    if (location.pathname !== '/explore') {
      location.href = EXPLORE_URL;
      return;
    }
    running = true;
    syncButtons();
    scheduleTick(randInt(700, 1800));
  }

  /* ------------------------------ 启动 ------------------------------ */

  buildUI();

  run = loadRun();

  if (sessionStorage.getItem(START_PENDING) === '1' && !getUrlNoteId()) {
    sessionStorage.removeItem(START_PENDING);
    setTimeout(() => onStart(), 1000);
  } else if (run.active) {
    if (getUrlNoteId()) {
      if (run.phase === 'note' && run.pendingId === getUrlNoteId()) {
        notePageStep().catch((err) => {
          logLine('出错：' + err.message);
          running = false;
          syncButtons();
        });
      } else {
        run.phase = 'browsing';
        run.pendingId = null;
        saveRun();
        setTimeout(() => history.back(), 500);
      }
    } else {
      resumeBrowse();
    }
  }

  window.addEventListener('pageshow', () => {
    const r = loadRun();
    if (!r.active) return;
    if (getUrlNoteId()) return;
    run = r;
    resumeBrowse();
  });

  window.xhsBot = {
    start: onStart,
    stop: onStop,
    pause: onPause,
    state: () => state,
    cfg: () => cfg,
    run: () => loadRun(),
  };
})();
