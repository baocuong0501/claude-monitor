#!/usr/bin/env node
// Claude Monitor: local, read-only viewer for Claude Code session transcripts.
// No dependencies. Binds to 127.0.0.1 only.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 7777;
const HOST = '127.0.0.1';
const ROOT = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 30_000;
const MAX_TEXT = 4000;

const clip = (s, n = MAX_TEXT) => {
  s = typeof s === 'string' ? s : JSON.stringify(s ?? '', null, 2);
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
};

// Turn one raw jsonl object into zero or more display events.
function normalize(o) {
  const ts = o.timestamp;
  const out = [];
  const base = { ts, side: !!o.isSidechain };
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (typeof c === 'string') {
      out.push({ ...base, kind: 'user', text: clip(c) });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') out.push({ ...base, kind: 'user', text: clip(b.text) });
        if (b.type === 'tool_result') {
          const body = Array.isArray(b.content)
            ? b.content.map((x) => x.text ?? '').join('\n')
            : b.content;
          out.push({ ...base, kind: 'result', id: b.tool_use_id, error: !!b.is_error, text: clip(body, 2500) });
        }
      }
    }
  } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b.type === 'text') out.push({ ...base, kind: 'assistant', text: clip(b.text) });
      else if (b.type === 'thinking') out.push({ ...base, kind: 'thinking', ms: o.thinkingDurationMs });
      else if (b.type === 'tool_use') out.push({ ...base, kind: 'tool', id: b.id, name: b.name, input: summarizeInput(b.name, b.input) });
    }
  }
  return out;
}

function summarizeInput(name, i = {}) {
  const pick = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.url ?? i.description ?? i.prompt ?? i.query;
  const detail = { ...i };
  for (const k of Object.keys(detail)) if (typeof detail[k] === 'string') detail[k] = clip(detail[k], 1500);
  return { summary: clip(String(pick ?? ''), 200), detail };
}

// Estimated input price ($/Mtok) per model family, fitted from Claude Code's own
// cost-state records (median error ~5-10%). Ratios: output 5x, cache read 0.1x, cache write 1.25x.
const PRICE = [
  [/haiku-4-5/, 1.06], [/opus-5-5/, 3.09], [/opus-5/, 5.37], [/sonnet-5/, 2.05],
];
const priceOf = (model = '') => (PRICE.find(([re]) => re.test(model)) || [])[1];

function collectUsage(o, reqs) {
  const u = o.type === 'assistant' && o.message?.usage;
  if (!u) return;
  const key = o.requestId || o.uuid;
  const cur = reqs.get(key) || { model: o.message.model, in: 0, out: 0, cr: 0, cc: 0 };
  // The same request repeats on every content block; keep the largest counts seen.
  cur.in = Math.max(cur.in, u.input_tokens || 0);
  cur.out = Math.max(cur.out, u.output_tokens || 0);
  cur.cr = Math.max(cur.cr, u.cache_read_input_tokens || 0);
  cur.cc = Math.max(cur.cc, u.cache_creation_input_tokens || 0);
  reqs.set(key, cur);
}

function usageOf(reqs) {
  const t = { in: 0, out: 0, cr: 0, cc: 0, est: 0, unpriced: 0 };
  for (const r of reqs.values()) {
    t.in += r.in; t.out += r.out; t.cr += r.cr; t.cc += r.cc;
    const p = priceOf(r.model);
    if (p == null) { t.unpriced++; continue; }
    t.est += (p * (r.in + 5 * r.out + 0.1 * r.cr + 1.25 * r.cc)) / 1e6;
  }
  return t;
}

function parseLines(text, reqs) {
  const events = [];
  const meta = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title') meta.title = o.aiTitle;
    else if (o.type === 'cost-state') meta.cost = o.totalCostUSD;
    else if (o.type === 'last-prompt') meta.lastPrompt = o.lastPrompt;
    if (reqs) collectUsage(o, reqs);
    if (o.cwd) meta.cwd = o.cwd;
    if (o.gitBranch) meta.branch = o.gitBranch;
    events.push(...normalize(o));
  }
  return { events, meta };
}

// --- session index -------------------------------------------------------
const files = new Map(); // id -> {file, project, size, mtime, meta}

function scan() {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return; }
  for (const d of dirs) {
    let list;
    try { list = fs.readdirSync(path.join(ROOT, d)); } catch { continue; }
    for (const f of list) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(ROOT, d, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const id = f.slice(0, -6);
      const prev = files.get(id);
      if (!prev) files.set(id, { id, file, project: d, size: 0, mtime: st.mtimeMs, meta: {}, reqs: new Map(), fresh: true });
      const cur = files.get(id);
      cur.mtime = st.mtimeMs;
      cur.statSize = st.size;
    }
  }
}

function readTail(entry) {
  // Title/cwd live anywhere in the file; read whole file once, cheap enough.
  const { meta } = parseLines(fs.readFileSync(entry.file, 'utf8'), entry.reqs);
  Object.assign(entry.meta, meta);
}

const clients = new Set();
const send = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (ev, data) => clients.forEach((r) => send(r, ev, data));

const view = (e) => ({
  id: e.id, project: e.project, mtime: e.mtime,
  active: Date.now() - e.mtime < ACTIVE_MS,
  title: e.meta.title || e.meta.lastPrompt || e.id.slice(0, 8),
  cwd: e.meta.cwd, branch: e.meta.branch, cost: e.meta.cost, usage: usageOf(e.reqs),
});

function tick() {
  scan();
  for (const e of files.values()) {
    if (e.fresh) {
      try { readTail(e); } catch {}
      e.size = e.statSize;
      e.fresh = false;
      continue;
    }
    if (e.statSize > e.size) {
      const fd = fs.openSync(e.file, 'r');
      const buf = Buffer.alloc(e.statSize - e.size);
      fs.readSync(fd, buf, 0, buf.length, e.size);
      fs.closeSync(fd);
      // Only advance to the last full line so partial writes are retried.
      const text = buf.toString('utf8');
      const cut = text.lastIndexOf('\n') + 1;
      if (!cut) continue;
      e.size += Buffer.byteLength(text.slice(0, cut));
      const { events, meta } = parseLines(text.slice(0, cut), e.reqs);
      Object.assign(e.meta, meta);
      if (events.length) broadcast('events', { id: e.id, events });
      broadcast('session', view(e));
    }
  }
}

// --- jira feed -----------------------------------------------------------
// Optional. Polls Jira Cloud for tickets you are assigned to / watching and pushes changes
// over SSE. Enabled only when JIRA_URL, JIRA_EMAIL and JIRA_TOKEN are all set.
const JIRA_URL = (process.env.JIRA_URL || '').replace(/\/+$/, '');
const JIRA_ON = !!(JIRA_URL && process.env.JIRA_EMAIL && process.env.JIRA_TOKEN);
const JIRA_POLL_MS = Number(process.env.JIRA_POLL_MS) || 60_000;
const JIRA_JQL = process.env.JIRA_JQL || '(assignee = currentUser() OR watcher = currentUser())';
const jira = { feed: [], seen: new Map(), primed: false, error: null, last: 0 }; // seen: key -> {updated,status}

async function jiraPoll() {
  // First pass looks back a day to fill the feed silently; later passes only need a short window.
  const window = jira.primed ? Math.max(5, Math.ceil((JIRA_POLL_MS * 3) / 60_000)) + 'm' : '1d';
  const qs = new URLSearchParams({
    jql: `${JIRA_JQL} AND updated >= -${window} ORDER BY updated ASC`,
    fields: 'summary,status,updated,assignee,issuetype',
    maxResults: '50',
  });
  try {
    const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql?${qs}`, {
      headers: {
        accept: 'application/json',
        authorization: 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`).toString('base64'),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { issues = [] } = await r.json();
    for (const it of issues) {
      const f = it.fields || {};
      const status = f.status?.name || '';
      const prev = jira.seen.get(it.key);
      if (prev && prev.updated === f.updated) continue;
      jira.seen.set(it.key, { updated: f.updated, status });
      const item = {
        key: it.key, url: `${JIRA_URL}/browse/${it.key}`, summary: f.summary || '', status,
        type: f.issuetype?.name, assignee: f.assignee?.displayName, updated: f.updated,
        kind: !prev ? 'new' : prev.status !== status ? 'status' : 'update', from: prev?.status,
        unread: jira.primed,
      };
      jira.feed.unshift(item);
      if (jira.primed) broadcast('jira', item);
    }
    jira.feed = jira.feed.slice(0, 50);
    jira.primed = true;
    jira.error = null;
  } catch (e) {
    jira.error = String(e.message || e);
  }
  jira.last = Date.now();
  broadcast('jira-state', { error: jira.error, last: jira.last });
}

// --- http ----------------------------------------------------------------
const hostOk = (h = '') => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);

http.createServer((req, res) => {
  if (!hostOk(req.headers.host)) { res.writeHead(403).end('forbidden'); return; }
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  } else if (url.pathname === '/api/sessions') {
    const list = [...files.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 100).map(view);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  } else if (url.pathname === '/api/jira') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ enabled: JIRA_ON, error: jira.error, last: jira.last, feed: jira.feed }));
  } else if (url.pathname.startsWith('/api/session/')) {
    const id = url.pathname.slice('/api/session/'.length);
    const e = /^[\w-]+$/.test(id) && files.get(id);
    if (!e) { res.writeHead(404).end('not found'); return; }
    // Cap to the last 1500 events so huge sessions stay responsive.
    const { events } = parseLines(fs.readFileSync(e.file, 'utf8'));
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ...view(e), total: events.length, events: events.slice(-1500) }));
  } else if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, HOST, () => {
  scan();
  console.log(`Claude Monitor → http://${HOST}:${PORT}  (reading ${ROOT})`);
});

if (JIRA_ON) {
  jiraPoll();
  setInterval(jiraPoll, JIRA_POLL_MS);
} else {
  console.log('Jira feed off (set JIRA_URL, JIRA_EMAIL, JIRA_TOKEN to enable)');
}
setInterval(tick, 1000);
setInterval(() => broadcast('ping', Date.now()), 15000);
