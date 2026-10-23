// ─── Batch review screen ───────────────────────────────────────────────────
// One full screen per batch: every email with the hat's pick, retagged from the keyboard, then a
// scoreboard of the exact Gmail changes before anything is sent. Drawn in the terminal's alternate
// screen buffer so the shell's scrollback survives the session.
//
// Rendering and key handling are pure functions of a view object; only `Screen` touches the
// terminal. That keeps the layout and the controls testable without a TTY.

const readline = require('readline');

const HOUSES = ['important', 'neutral', 'junk'];
const FILTER_THRESHOLD = 3;
const TOAST_MS = 3500;
// A held E or Q auto-repeats in a terminal; ignore it this soon after the screen changes so one
// long press can't skip straight through review or undo several batches.
const REPEAT_GUARD_MS = 350;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ─── Styles ────────────────────────────────────────────────────────────────

const CSI = '\x1b[';
const ST = {
  bold: '1', strike: '9',
  imp: '93', neu: '96', jnk: '91', ok: '92',
  warn: '38;5;215', dim: '38;5;244', line: '38;5;239',
  selBg: '48;5;236', chipBg: '48;5;237',
};
const HOUSE = {
  important: { glyph: '★', label: 'IMPORTANT', st: ST.imp },
  neutral:   { glyph: '•', label: 'NEUTRAL',   st: ST.neu },
  junk:      { glyph: '✗', label: 'JUNK',      st: ST.jnk },
};
const ACTION_ST = {
  'star': ST.imp, 'star + read': ST.imp, 'mark read': ST.neu, 'read only': ST.neu,
  'leave unread': ST.dim, 'no change': ST.dim, 'spam': ST.jnk, 'keep in inbox': ST.warn,
};
const GUARD_LABEL = { job: 'job sender', board: 'job board' };
const FILTER_VERB = { important: 'auto-important', neutral: 'auto-read', junk: 'auto-spam' };

// A line is an array of segments: { t: text, s: [SGR codes] }.
const seg = (t, ...s) => ({ t, s: s.filter(Boolean) });

// ─── Text width ────────────────────────────────────────────────────────────
// Subjects can hold emoji and CJK text, which take two terminal cells; combining marks take none.

function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

const clean = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

// Truncate to `n` cells (ending in "…" when cut) and pad with spaces to exactly `n`.
function fit(s, n) {
  s = clean(s);
  if (n <= 0) return '';
  if (strWidth(s) <= n) return s + ' '.repeat(n - strWidth(s));
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…' + ' '.repeat(n - 1 - w);
}

const segsWidth = segs => segs.reduce((w, x) => w + strWidth(x.t), 0);

// Cut or pad a line of segments to exactly `n` cells.
function fitSegs(segs, n) {
  const out = [];
  let w = 0;
  for (const x of segs) {
    const xw = strWidth(x.t);
    if (w + xw <= n) { out.push(x); w += xw; continue; }
    out.push({ t: fit(x.t, n - w).trimEnd(), s: x.s });
    w = segsWidth(out);
    break;
  }
  if (w < n) out.push(seg(' '.repeat(n - w)));
  return out;
}

const withBg = (segs, bg) => (bg ? segs.map(x => ({ t: x.t, s: [bg, ...x.s] })) : segs);
const toAnsi = segs => segs.map(x => `${CSI}0${x.s.length ? ';' + x.s.join(';') : ''}m${x.t}`).join('') + `${CSI}0m`;

function wrap(text, width, maxLines) {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const lines = [''];
  for (const word of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = word;
    else if (strWidth(cur) + 1 + strWidth(word) <= width) lines[lines.length - 1] = `${cur} ${word}`;
    else lines.push(word);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = fit(lines[maxLines - 1] + ' …', width).trimEnd();
  }
  return lines;
}

// ─── Batch model ───────────────────────────────────────────────────────────
// Each item: { id, from, name, addr, subject, snippet, labelIds, house, orig, reason, read,
//              skip: { star, read, spam, filter }, guard: 'job' | 'board' | null,
//              learn: { important|neutral|spam: { count, filtered } }, undoneMove? }
// `skip` holds changes reverted on the review screen; `orig` is the hat's pick.

const effRead = e => e.house !== 'junk' && e.read && !e.skip.read;

function action(e) {
  if (e.house === 'important') {
    if (e.skip.star) return effRead(e) ? 'read only' : 'no change';
    return effRead(e) ? 'star + read' : 'star';
  }
  if (e.house === 'neutral') return effRead(e) ? 'mark read' : 'leave unread';
  return e.skip.spam ? 'keep in inbox' : 'spam';
}

// Which learning bucket this email's final state feeds, if any. Mirrors what gets recorded on apply.
function learnKind(e) {
  if (e.house === 'neutral') return effRead(e) && !e.guard ? 'neutral' : null;
  if (e.house === 'junk') return !e.skip.spam && !e.guard ? 'spam' : null;
  return e.orig !== 'important' && !e.skip.star ? 'important' : null;
}

// True when applying this email takes its sender to the auto-filter threshold.
function filterDue(e) {
  const kind = learnKind(e);
  if (!kind) return false;
  const rec = e.learn?.[kind] ?? { count: 0, filtered: false };
  return !rec.filtered && rec.count + 1 >= FILTER_THRESHOLD;
}
const willFilter = e => filterDue(e) && !e.skip.filter;

function plan(items) {
  const imp = items.filter(e => e.house === 'important');
  return {
    star: imp.filter(e => !e.skip.star),
    read: items.filter(effRead),
    spam: items.filter(e => e.house === 'junk' && !e.skip.spam),
    filters: items.filter(willFilter),
    moved: items.filter(e => e.house !== e.orig),
  };
}

// Review tiles: one per kind of Gmail change. rows() lists every email the tile covers, reverted
// ones included so Space can restore them; on() says whether the change is still active.
const TILES = [
  { key: 'star', glyph: '★', st: ST.imp, label: 'star', revert: "don't star", reverted: "won't be starred",
    rows: v => v.items.filter(e => e.house === 'important'), on: e => !e.skip.star },
  { key: 'read', glyph: '●', st: ST.neu, label: 'mark read', revert: 'leave unread', reverted: 'stays unread',
    rows: v => v.items.filter(e => e.house !== 'junk' && e.read), on: e => !e.skip.read },
  { key: 'spam', glyph: '✗', st: ST.jnk, label: 'spam', revert: 'keep in inbox', reverted: 'kept in inbox',
    rows: v => v.items.filter(e => e.house === 'junk'), on: e => !e.skip.spam },
  { key: 'filter', glyph: '▽', st: ST.warn, label: 'filters', revert: 'skip filter', reverted: 'filter skipped',
    rows: v => v.items.filter(filterDue), on: e => !e.skip.filter },
  { key: 'move', glyph: '↺', st: ST.warn, label: 'your moves', revert: 'undo move', reverted: 'move undone',
    rows: v => v.items.filter(e => e.house !== e.orig || e.undoneMove), on: e => !e.undoneMove },
  { key: 'none', glyph: '○', st: ST.dim, label: 'untouched',
    rows: v => v.items.filter(e => action(e) === 'no change' || action(e) === 'leave unread' || action(e) === 'keep in inbox'),
    on: () => true },
];

function createView({ batchNum, items, warning = null }) {
  return {
    mode: 'list', batchNum, items, warning,
    cur: sorted(items)[0]?.id ?? null, tile: 0, row: 0, scroll: 0, reviewScroll: 0,
  };
}

const sorted = items => HOUSES.flatMap(h => items.filter(e => e.house === h));
const current = v => v.items.find(e => e.id === v.cur) ?? sorted(v.items)[0];
const selectedReviewItem = v => TILES[v.tile].rows(v)[v.row];

function setHouse(e, house) {
  if (!e || e.house === house) return;
  e.house = house;
  e.read = house === 'neutral';
  e.skip = {};
  delete e.undoneMove;
}

function toggleMove(e) {
  if (e.undoneMove) {
    const back = e.undoneMove;
    setHouse(e, back);
  } else {
    const was = e.house;
    setHouse(e, e.orig);
    e.undoneMove = was;
  }
}

const toast = (v, kind, text) => { v.toast = { kind, text }; };

// ─── Keys ──────────────────────────────────────────────────────────────────
// Returns an outcome for the caller ({ type: 'apply' | 'undo' | 'quit' | 'done' | 'open' }) or null
// when the key only changed the view. `ctx` carries { now, canUndo }.

function handleKey(v, key, ctx = {}) {
  const name = key?.name;
  const shift = !!key?.shift;
  const now = ctx.now ?? Date.now();

  if (v.mode === 'accounts') {
    const count = v.accounts.length + (v.accounts.length > 1 ? 1 : 0);
    switch (name) {
      case 'w': case 'up': v.cur = Math.max(0, v.cur - 1); return null;
      case 's': case 'down': v.cur = Math.min(count - 1, v.cur + 1); return null;
      case 'e': case 'return': return { type: 'pick', index: v.cur };
      case 'q': case 'escape': return { type: 'quit' };
      default:
        if (/^[1-9]$/.test(name ?? '') && Number(name) <= count) v.cur = Number(name) - 1;
        return null;
    }
  }

  if (v.mode === 'start') {
    if (v.confirm) {
      if (name === 'e' || name === 'return') return now - v.confirmAt < REPEAT_GUARD_MS ? null : { type: 'markAll' };
      if (name === 'q' || name === 'escape' || name === 'w' || name === 's' || name === 'up' || name === 'down') v.confirm = false;
      return null;
    }
    switch (name) {
      case 'w': case 'up': v.cur = Math.max(0, v.cur - 1); return null;
      case 's': case 'down': v.cur = Math.min(v.options.length - 1, v.cur + 1); return null;
      case 'e': case 'return': {
        const o = v.options[v.cur];
        if (o.disabled) { toast(v, 'warn', o.disabled); return null; }
        if (o.key === 'markAll') { v.confirm = true; v.confirmAt = now; return null; }
        return { type: o.key };
      }
      case 'q': return shift ? { type: 'quit' } : { type: 'skip' };
      case 'escape': return { type: 'skip' };
      default: return null;
    }
  }

  if (v.mode === 'steps') {
    if (v.continue && (name === 'e' || name === 'return')) return { type: 'continue' };
    if (v.url && name === 'e') return { type: 'reopen', url: v.url };
    return null;
  }

  if (v.mode === 'summary') {
    if (name === 'q' && !shift) {
      if (ctx.canUndo) return { type: 'undo' };
      toast(v, 'info', 'Nothing to undo.');
      return null;
    }
    if (name === 'e' || name === 'return' || (name === 'q' && shift)) return { type: 'done' };
    return null;
  }

  if (v.mode === 'review') {
    const tiles = TILES.length;
    switch (name) {
      case 'e':
        if (now - v.reviewAt < REPEAT_GUARD_MS) return null;
        if (shift && !plan(v.items).filters.length) return null;
        return { type: 'apply', skipFilters: shift };
      case 'q': case 'escape': v.mode = 'list'; return null;
      case 'a': case 'left': v.tile = Math.max(0, v.tile - 1); v.row = 0; return null;
      case 'd': case 'right': v.tile = Math.min(tiles - 1, v.tile + 1); v.row = 0; return null;
      case 'w': case 'up': v.row = Math.max(0, v.row - 1); return null;
      case 's': case 'down': v.row = Math.min(Math.max(0, TILES[v.tile].rows(v).length - 1), v.row + 1); return null;
      case 'space': {
        const t = TILES[v.tile];
        const e = selectedReviewItem(v);
        if (!e || t.key === 'none') { toast(v, 'info', 'Nothing to revert here. Press Q to change it in the list.'); return null; }
        if (t.key === 'move') toggleMove(e);
        else e.skip[t.key] = !e.skip[t.key];
        // A revert can empty the row the cursor was on (e.g. a filter that no longer applies).
        v.row = Math.min(v.row, Math.max(0, t.rows(v).length - 1));
        return null;
      }
      default: return null;
    }
  }

  // List mode
  const e = current(v);
  const order = sorted(v.items);
  const i = order.findIndex(x => x.id === v.cur);
  const shiftHouse = d => {
    const h = HOUSES.indexOf(e.house) + d;
    if (h >= 0 && h < HOUSES.length) setHouse(e, HOUSES[h]);
  };
  const jump = d => {
    for (let h = HOUSES.indexOf(e.house) + d; h >= 0 && h < HOUSES.length; h += d) {
      const first = order.find(x => x.house === HOUSES[h]);
      if (first) { v.cur = first.id; return; }
    }
  };
  switch (name) {
    case 'w': case 'up': if (shift) jump(-1); else v.cur = order[Math.max(0, i - 1)]?.id ?? v.cur; return null;
    case 's': case 'down': if (shift) jump(1); else v.cur = order[Math.min(order.length - 1, i + 1)]?.id ?? v.cur; return null;
    case 'a': case 'left': shiftHouse(-1); return null;
    case 'd': case 'right': shiftHouse(1); return null;
    case '1': setHouse(e, 'important'); return null;
    case '2': setHouse(e, 'neutral'); return null;
    case '3': setHouse(e, 'junk'); return null;
    case 'space':
      if (!e) return null;
      if (e.house === 'junk') toast(v, 'info', 'Junk goes to spam. Press A to move it out first.');
      else { e.read = !effRead(e); e.skip.read = false; }
      return null;
    case 'e': case 'return':
      if (shift && name === 'e') return e ? { type: 'open', id: e.id } : null;
      v.mode = 'review';
      v.reviewAt = now;
      v.tile = Math.max(0, TILES.findIndex(t => t.rows(v).length));
      v.row = 0;
      return null;
    case 'q':
      if (shift) return { type: 'quit' };
      if (ctx.canUndo) return { type: 'undo' };
      toast(v, 'info', 'Nothing to undo yet.');
      return null;
    default: return null;
  }
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function pane({ title, meta = [], footMeta = [], lines, width, height, accent = false }) {
  const b = accent ? ST.imp : ST.line;
  const inner = width - 4;
  const top = [seg('╭─ ', b), ...fitSegs(title, Math.min(segsWidth(title), inner - 2)), seg(' ', b)];
  const metaW = meta.length ? segsWidth(meta) + 2 : 0;
  top.push(seg('─'.repeat(Math.max(0, width - segsWidth(top) - metaW - 2)), b));
  if (meta.length) top.push(seg(' '), ...meta, seg(' '));
  top.push(seg('─╮', b));

  const body = [];
  for (let i = 0; i < height - 2; i++) {
    const l = lines[i] ?? { segs: [] };
    body.push([seg('│ ', b), ...withBg(fitSegs(l.segs, inner), l.bg), seg(' │', b)]);
  }

  const footW = footMeta.length ? segsWidth(footMeta) + 2 : 0;
  const bottom = [seg('╰' + '─'.repeat(Math.max(0, width - 3 - footW)), b)];
  if (footMeta.length) bottom.push(seg(' '), ...footMeta, seg(' '));
  bottom.push(seg('─╯', b));
  return [top, ...body, bottom];
}

// Keep the cursor line visible inside a window of `height` lines; remembers the offset on the view.
function windowed(v, scrollKey, lines, cursorLine, height) {
  let top = v[scrollKey] ?? 0;
  if (cursorLine - 1 < top) top = Math.max(0, cursorLine - 1);
  if (cursorLine >= top + height) top = cursorLine - height + 1;
  top = Math.max(0, Math.min(top, lines.length - height));
  v[scrollKey] = top;
  const below = Math.max(0, lines.length - top - height);
  const footMeta = below ? [seg(`↓ ${below} more`, ST.dim)] : top ? [seg('↑ more above', ST.dim)] : [];
  return { visible: lines.slice(top, top + height), footMeta };
}

function tagSegs(e) {
  if (e.guard) return [seg('◆ ', ST.ok), seg(GUARD_LABEL[e.guard], ST.dim)];
  const kind = learnKind(e);
  if (!kind) return [];
  if (willFilter(e)) return [seg(`▽ ${FILTER_THRESHOLD}/${FILTER_THRESHOLD} ${FILTER_VERB[e.house]}`, ST.warn)];
  const rec = e.learn?.[kind];
  if (!rec || rec.filtered || !rec.count) return [];
  return [seg(`${rec.count}/${FILTER_THRESHOLD} ${FILTER_VERB[e.house]}`, ST.dim)];
}

function listLines(v, inner) {
  const showTag = inner >= 92;
  const fixed = 2 + 2 + 2 + 18 + 1 + 13 + (showTag ? 21 : 0);
  const subjW = Math.max(10, inner - fixed);
  const lines = [];
  let cursorLine = 0;
  HOUSES.forEach((h, gi) => {
    const group = v.items.filter(e => e.house === h);
    if (gi) lines.push({ segs: [] });
    lines.push({ segs: [seg(`${HOUSE[h].glyph} ${HOUSE[h].label}`, ST.bold, HOUSE[h].st), seg(` ${group.length}`, ST.dim)] });
    for (const e of group) {
      const sel = e.id === v.cur;
      if (sel) cursorLine = lines.length;
      const subjSt = h === 'important' ? ST.bold : h === 'junk' ? ST.dim : null;
      const moved = e.house !== e.orig;
      const act = action(e);
      const segs = [
        seg(sel ? '▸ ' : '  ', ST.imp),
        seg(`${HOUSE[h].glyph} `, HOUSE[h].st),
        ...(moved ? [seg(fit(e.subject, subjW - 2), subjSt), seg(' ↺', ST.warn)] : [seg(fit(e.subject, subjW), subjSt)]),
        seg('  '),
        seg(fit(e.name, 18), ST.dim),
        seg(' '),
        seg(fit(act, 13), ACTION_ST[act]),
      ];
      if (showTag) segs.push(seg(' '), ...fitSegs(tagSegs(e), 20));
      lines.push({ segs, bg: sel ? ST.selBg : null });
    }
  });
  return { lines, cursorLine, showTag };
}

function detailLines(e, inner, mode, showTag) {
  if (!e) return [{ segs: [seg('Nothing in this tile.', ST.dim)] }];
  const label = t => seg(t.padEnd(6), ST.dim);
  const snippet = wrap(e.snippet, inner - 6, 2);
  const lines = [
    { segs: [label('From'), seg(clean(e.name)), seg(` <${clean(e.addr)}>`, ST.dim)] },
    { segs: [label('Subj'), seg(clean(e.subject), ST.bold)] },
    ...snippet.map(s => ({ segs: [label(''), seg(s)] })),
  ];
  while (lines.length < 4) lines.push({ segs: [] });
  if (mode === 'review') {
    const act = action(e);
    lines.push({ segs: [label('Gmail'), seg(act, ACTION_ST[act]), ...(willFilter(e) ? [seg('   ▽ plus a new filter', ST.warn)] : [])] });
  } else {
    const segs = [label('Hat'), seg(e.orig, HOUSE[e.orig].st), seg(` · ${clean(e.reason) || 'no reason given'}`, ST.dim)];
    if (e.house !== e.orig) segs.push(seg(`   ↺ you moved it to ${e.house}`, ST.warn));
    if (!showTag && tagSegs(e).length) segs.push(seg('   '), ...tagSegs(e));
    lines.push({ segs });
  }
  return lines;
}

// Tiles drawn with box characters, side by side. `items`: [{ glyph, st, n, label, selected }]
function tileLines(items, inner) {
  const tileW = Math.max(9, Math.min(16, Math.floor((inner - (items.length - 1)) / items.length)));
  const rows = [[], [], [], []];
  items.forEach((t, i) => {
    const zero = !t.n;
    const b = t.selected ? ST.imp : ST.line;
    const gap = i ? [seg(' ')] : [];
    const w = tileW - 4;
    rows[0].push(...gap, seg(`╭${'─'.repeat(tileW - 2)}╮`, b));
    rows[1].push(...gap, seg('│ ', b), ...fitSegs([seg(`${t.glyph} `, zero ? ST.dim : t.st), seg(String(t.n), zero ? ST.dim : ST.bold)], w), seg(' │', b));
    rows[2].push(...gap, seg('│ ', b), seg(fit(t.label, w), t.selected ? ST.bold : ST.dim), seg(' │', b));
    rows[3].push(...gap, seg(`╰${'─'.repeat(tileW - 2)}╯`, b));
  });
  return rows.map(segs => ({ segs }));
}

function reviewLines(v, inner) {
  const t = TILES[v.tile];
  const tiles = tileLines(TILES.map((x, i) => ({
    glyph: x.glyph, st: x.st, n: x.rows(v).filter(x.on).length, label: x.label, selected: i === v.tile,
  })), inner);
  const rows = t.rows(v);
  v.row = Math.max(0, Math.min(v.row, rows.length - 1));
  const off = rows.filter(e => !t.on(e)).length;
  const head = { segs: [seg(`${t.glyph} ${t.label.toUpperCase()}`, ST.bold, t.st), seg(` ${rows.length}${off ? ` · ${off} reverted` : ''}`, ST.dim)] };
  const mainW = Math.max(10, inner - (2 + 2 + 2 + 18 + 1 + 18));
  const body = rows.length ? rows.map((e, i) => {
    const on = t.on(e);
    const sel = i === v.row;
    const struck = on ? [] : [ST.strike, ST.dim];
    const main = t.key === 'filter'
      ? [seg(clean(e.addr), ...struck), seg(` → future mail ${e.house === 'junk' ? 'to spam' : e.house === 'important' ? 'marked important' : 'marked read'}`, ST.dim)]
      : [seg(clean(e.subject), ...struck)];
    let status = [];
    if (!on) status = [seg(t.reverted, ST.warn)];
    else if (t.key === 'move') status = [seg(e.orig, HOUSE[e.orig].st), seg(' → ', ST.dim), seg(e.house, HOUSE[e.house].st)];
    else if (t.key === 'none') status = [seg(action(e), ST.dim)];
    return {
      segs: [seg(sel ? '▸ ' : '  ', ST.imp), seg(`${t.glyph} `, t.st), ...fitSegs(main, mainW), seg('  '),
        seg(fit(e.name, 18), ST.dim), seg(' '), ...fitSegs(status, 18)],
      bg: sel ? ST.selBg : null,
    };
  }) : [{ segs: [seg('    Nothing in this tile.', ST.dim)] }];
  const lines = [...tiles, { segs: [] }, head, ...body];
  return { lines, cursorLine: tiles.length + 2 + v.row };
}

function summaryLines(v, inner) {
  const s = v.summary;
  const lines = [
    { segs: [seg('✓ Inbox sorted.', ST.bold, ST.ok), seg(" Here's everything that changed in Gmail.", ST.dim)] },
    { segs: [] },
    ...tileLines([
      { glyph: '★', st: ST.imp, n: s.star, label: 'starred' },
      { glyph: '●', st: ST.neu, n: s.read, label: 'marked read' },
      { glyph: '✗', st: ST.jnk, n: s.spam, label: 'to spam' },
      { glyph: '▽', st: ST.warn, n: s.filters, label: 'new filters' },
      { glyph: '↺', st: ST.warn, n: s.moved, label: 'corrections' },
      { glyph: '○', st: ST.dim, n: s.unread, label: 'left unread' },
    ], inner),
    { segs: [] },
  ];
  if (s.batches.length) {
    const col = (n, st) => seg(fit(String(n), 13), n ? st : ST.line);
    lines.push({ segs: [seg('BY BATCH', ST.bold)] });
    lines.push({ segs: [seg(' '.repeat(10)), ...['starred', 'read', 'spam', 'filters', 'corrections'].map(h => seg(fit(h, 13), ST.dim))] });
    for (const b of s.batches) {
      lines.push({ segs: [seg(fit(`batch ${b.num}`, 10), ST.dim), col(b.star, ST.imp), col(b.read, ST.neu), col(b.spam, ST.jnk), col(b.filters, ST.warn), col(b.moved, ST.warn)] });
    }
    lines.push({ segs: [] });
  }
  if (s.leftUnsorted) lines.push({ segs: [seg(`Stopped early. ${s.leftUnsorted} unread emails were left for next time.`, ST.warn)] });
  lines.push({ segs: [seg("Corrections are saved to learning.json and shape the hat's next run.", ST.dim)] });
  return lines;
}

function keyChips(groups, width) {
  const build = all => {
    const out = [];
    groups.forEach(g => {
      const keys = g.filter(k => all || !k.opt);
      if (!keys.length) return;
      if (out.length) out.push(seg('  │  ', ST.line));
      keys.forEach((k, i) => out.push(...(i ? [seg('  ')] : []), seg(` ${k.k} `, ST.chipBg), seg(` ${k.l}`, ST.dim)));
    });
    return out;
  };
  const full = build(true);
  return segsWidth(full) <= width ? full : build(false);
}

function footerLines(v, ctx, width) {
  const t = ctx.toast && (ctx.now ?? Date.now()) - ctx.toast.at < TOAST_MS ? ctx.toast : null;
  const TOAST_ST = { ok: ST.ok, warn: ST.warn, err: ST.jnk, info: ST.dim, undo: ST.warn };
  const TOAST_GLYPH = { ok: '✓', warn: '!', err: '!', info: '·', undo: '↺' };
  let status = [];
  if (v.busy) status = [seg(`${FRAMES[ctx.frame % FRAMES.length]} `, ST.dim), seg(v.busy)];
  else if (t) status = [seg(`${TOAST_GLYPH[t.kind]} `, TOAST_ST[t.kind]), seg(t.text, t.kind === 'info' ? ST.dim : null)];
  else if (v.warning) status = [seg('! ', ST.jnk), seg(v.warning, ST.dim)];
  else if (v.mode === 'review') status = [seg('? ', ST.ok), seg(`Apply batch ${v.batchNum} to Gmail?`, ST.bold)];
  else if (v.mode === 'start' && v.confirm) status = [seg('? ', ST.warn), seg(`Mark all ${v.unread} as read?`, ST.bold), seg(' Nothing gets sorted or learned.', ST.dim)];

  let groups;
  if (v.mode === 'accounts') {
    groups = [
      [{ k: 'W/S', l: 'move' }, { k: '1-9', l: 'pick', opt: true }],
      [{ k: 'E', l: 'open' }],
      [{ k: 'Q', l: 'quit' }],
    ];
  } else if (v.mode === 'start') {
    groups = v.confirm
      ? [[{ k: 'E', l: 'mark all read' }], [{ k: 'Q', l: 'cancel' }]]
      : [[{ k: 'W/S', l: 'choose' }], [{ k: 'E', l: 'go' }], [{ k: 'Q', l: v.unread ? 'skip inbox' : 'continue' }, { k: '⇧Q', l: 'quit', opt: true }]];
  } else if (v.mode === 'steps') {
    groups = v.url ? [[{ k: 'E', l: 'open the sign-in page again' }]] : v.continue ? [[{ k: 'E', l: 'continue' }]] : [];
  } else if (v.mode === 'review') {
    const tile = TILES[v.tile];
    const e = selectedReviewItem(v);
    groups = [
      [{ k: 'A/D', l: 'tile' }, { k: 'W/S', l: 'email' }],
      e && tile.key !== 'none' ? [{ k: 'Space', l: tile.on(e) ? tile.revert : 'restore' }] : [],
      [{ k: 'E', l: 'apply' }, ...(plan(v.items).filters.length ? [{ k: '⇧E', l: 'apply without filters', opt: true }] : [])],
      [{ k: 'Q', l: 'back' }],
    ];
  } else if (v.mode === 'summary') {
    groups = [[{ k: 'E', l: 'done' }], ctx.canUndo ? [{ k: 'Q', l: 'undo last batch' }] : []];
  } else if (v.mode === 'loading') {
    groups = [];
  } else {
    groups = [
      [{ k: 'W/S', l: 'move' }, { k: '⇧W/S', l: 'jump', opt: true }],
      [{ k: 'A/D', l: 'house' }, { k: '1 2 3', l: 'set', opt: true }],
      [{ k: 'Space', l: 'read' }],
      [{ k: 'E', l: 'review' }, { k: '⇧E', l: 'open', opt: true }],
      [{ k: 'Q', l: 'undo' }, { k: '⇧Q', l: 'quit', opt: true }],
    ];
  }
  return [status, keyChips(groups, width)];
}

// Whether the local model can sort right now: { name, state: 'ready' | 'missing' | 'offline' }.
function modelSegs(m) {
  if (!m) return [];
  if (m.state === 'ready') return [seg('● ', ST.ok), seg(`${m.name} ready`, ST.dim)];
  if (m.state === 'missing') return [seg('● ', ST.warn), seg(`${m.name} isn't pulled`, ST.dim)];
  return [seg('○ ', ST.jnk), seg("Ollama isn't running", ST.dim)];
}

const bar = (done, total, w, st = ST.ok) => {
  const f = Math.round(Math.min(1, done / Math.max(1, total)) * w);
  return [seg('━'.repeat(f), st), seg('─'.repeat(w - f), ST.line)];
};

function headerLine(ctx, width) {
  const s = ctx.session ?? {};
  const left = [seg('the-sorting-hat', ST.bold, ST.imp)];
  if (s.account) left.push(seg(' › ', ST.line), seg(clean(s.account.name), ST.bold), seg(`  ${clean(s.account.email)}`, ST.dim));
  // While sorting, the right side tracks progress; before that it says whether the model is ready.
  const right = s.total != null
    ? [...bar(s.sorted ?? 0, s.total, 24), seg(`  ${s.sorted ?? 0}`, ST.bold), seg(`/${s.total} sorted`, ST.dim)]
    : modelSegs(s.model);
  const gap = width - segsWidth(left) - segsWidth(right);
  return gap >= 2 ? [...left, seg(' '.repeat(gap)), ...right] : fitSegs(left, width);
}

// ─── Start screens: inbox picker, sign-in steps, inbox overview ───────────

// Three-row block digits for the unread count on the overview.
const DIGITS = {
  0: ['█▀█', '█ █', '▀▀▀'], 1: ['▀█ ', ' █ ', '▀▀▀'], 2: ['▀▀█', '█▀▀', '▀▀▀'], 3: ['▀▀█', ' ▀█', '▀▀▀'],
  4: ['█ █', '▀▀█', '  ▀'], 5: ['█▀▀', '▀▀█', '▀▀▀'], 6: ['█▀▀', '█▀█', '▀▀▀'], 7: ['▀▀█', '  █', '  ▀'],
  8: ['█▀█', '█▀█', '▀▀▀'], 9: ['█▀█', '▀▀█', '▀▀▀'],
};
const bigNumber = n => [0, 1, 2].map(r => [...String(n)].map(d => DIGITS[d][r]).join(' '));

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function accountsLines(v, inner) {
  const n = v.accounts.length;
  const emailW = Math.max(10, Math.min(34, inner - (2 + 2 + 2 + 18 + 2 + 2 + 26)));
  const row = (i, glyph, name, email, status) => ({
    segs: [seg(i === v.cur ? '▸ ' : '  ', ST.imp), seg(`${i + 1} `, ST.dim), ...glyph, seg(' '), seg(fit(name, 18), ST.bold),
      seg('  '), seg(fit(email, emailW), ST.dim), seg('  '), ...fitSegs(status, 26)],
    bg: i === v.cur ? ST.selBg : null,
  });
  const lines = v.accounts.map((a, i) => row(i,
    [seg(a.signedIn ? '●' : '○', a.signedIn ? ST.ok : ST.dim)], a.name, a.email,
    a.signedIn ? [seg('signed in', ST.dim)] : [seg('needs sign-in', ST.warn)]));
  if (n > 1) {
    lines.push({ segs: [] });
    lines.push(row(n, [seg('≡', ST.imp)], 'All inboxes', v.accounts.map(a => a.name).join(', '), [seg(`${n} in a row`, ST.dim)]));
  }
  return { lines, cursorLine: v.cur < n ? v.cur : lines.length - 1 };
}

function accountDetail(v) {
  const label = t => seg(t.padEnd(8), ST.dim);
  const learned = a => (a.senders
    ? [seg(plural(a.senders, 'sender')), seg(` · ${plural(a.filters, 'filter')} created by the hat`, ST.dim)]
    : [seg('Nothing yet. Corrections you make are remembered here.', ST.dim)]);
  if (v.cur >= v.accounts.length) {
    const missing = v.accounts.filter(a => !a.signedIn).length;
    return [
      { segs: [label('Order'), seg(v.accounts.map(a => a.name).join(' → '))] },
      { segs: [label('Sign-in'), missing ? seg(`${missing} of ${v.accounts.length} will open your browser to sign in`, ST.warn) : seg('all saved')] },
      { segs: [label('Learned'), seg(plural(v.accounts.reduce((s, a) => s + a.senders, 0), 'sender')),
        seg(` · ${plural(v.accounts.reduce((s, a) => s + a.filters, 0), 'filter')} across every inbox`, ST.dim)] },
    ];
  }
  const a = v.accounts[v.cur];
  return [
    { segs: [label('Email'), seg(clean(a.email))] },
    { segs: [label('Sign-in'), ...(a.signedIn ? [seg('saved'), seg(`  ${clean(a.tokenFile)}`, ST.dim)] : [seg('needs sign-in', ST.warn), seg('  your browser opens when you continue', ST.dim)])] },
    { segs: [label('Learned'), ...learned(a)] },
  ];
}

const STEP_GLYPH = { done: ['✓', ST.ok], todo: ['·', ST.dim], fail: ['!', ST.jnk] };

function stepsLines(v, frame, inner) {
  const lines = [{ segs: [] }];
  for (const s of v.steps) {
    const [g, st] = s.state === 'active' ? [FRAMES[frame % FRAMES.length], ST.imp] : STEP_GLYPH[s.state];
    lines.push({ segs: [seg('  '), seg(g, st), seg(' '), seg(clean(s.text), s.state === 'todo' ? ST.dim : null)] });
    if (s.detail) lines.push({ segs: [seg('    '), seg(clean(s.detail), ST.dim)] });
  }
  if (v.progress) {
    const { done, total } = v.progress;
    lines.push({ segs: [] });
    lines.push({ segs: [seg('    '), ...bar(done, total, Math.min(48, inner - 30)), seg(`  ${done}`, ST.bold), seg(`/${total}`, ST.dim), seg(`  ${Math.floor(done / Math.max(1, total) * 100)}%`, ST.dim)] });
  }
  return lines;
}

function startLines(v, ctx, inner) {
  const big = bigNumber(v.unread);
  const bigW = strWidth(big[0]);
  const side = v.unread
    ? [
      [seg(v.unread === 1 ? 'unread email' : 'unread emails', ST.bold)],
      [seg(`${plural(v.batches, 'batch', 'batches')} of ${v.batchSize}`, ST.dim)],
      modelSegs(ctx.session?.model),
    ]
    : [[seg('Inbox zero.', ST.bold, ST.ok)], [seg('Nothing unread here.', ST.dim)], []];
  const lines = [{ segs: [] }];
  big.forEach((b, i) => lines.push({ segs: [seg('  '), seg(b, ST.bold, v.unread ? ST.imp : ST.ok), seg(' '.repeat(Math.max(3, 8 - bigW + 3))), ...side[i]] }));
  lines.push({ segs: [] }, { segs: [] });
  const descW = Math.max(10, inner - (2 + 20));
  v.options.forEach((o, i) => {
    const sel = i === v.cur;
    let desc = [seg(fit(o.desc, descW), ST.dim)];
    if (o.disabled) desc = [seg(fit(o.disabled, descW), ST.warn)];
    if (sel && v.confirm) desc = [seg(fit(`Press E again to mark all ${v.unread} as read. Q cancels.`, descW), ST.warn)];
    lines.push({ segs: [seg(sel ? '▸ ' : '  ', ST.imp), seg(fit(o.label, 20), o.disabled ? ST.dim : ST.bold), ...desc], bg: sel ? ST.selBg : null });
  });
  return lines;
}

function nextBatchStatus(v, ctx) {
  const total = ctx.session.totalBatches ?? v.batchNum;
  if (v.batchNum >= total) return [seg('last batch', ST.dim)];
  const next = v.batchNum + 1;
  if (ctx.inFlight?.has(next)) return [seg(`${FRAMES[ctx.frame % FRAMES.length]} analyzing batch ${next}`, ST.dim)];
  return [seg('✓ ', ST.ok), seg(`batch ${next} ready`, ST.dim)];
}

// Returns exactly `rows` strings, each `cols - 1` cells wide (the last column is left free so no
// terminal auto-wraps a full line).
function render(v, ctx) {
  const width = Math.max(60, (ctx.cols ?? 100) - 1);
  const rows = Math.max(16, ctx.rows ?? 32);
  const inner = width - 4;
  const total = ctx.session.totalBatches ?? v.batchNum;
  const batchTitle = label => [seg(label, ST.bold), seg(` · batch ${v.batchNum} of ${total}`, ST.dim)];
  const footer = footerLines(v, ctx, width);
  const fixed = 2 + footer.length; // header + spacer, footer
  const out = [headerLine(ctx, width), []];

  if (v.mode === 'accounts') {
    // Start screens size their panes to the content; the key bar stays pinned to the bottom.
    const { lines, cursorLine } = accountsLines(v, inner);
    const detailH = rows >= 22 ? 5 : 0;
    const mainH = Math.min(rows - fixed - detailH, lines.length + 4);
    const { visible, footMeta } = windowed(v, 'scroll', [{ segs: [] }, ...lines], cursorLine + 1, mainH - 2);
    out.push(...pane({ title: [seg('Choose an inbox', ST.bold)], meta: [seg(plural(v.accounts.length, 'account'), ST.dim)], footMeta, lines: visible, width, height: mainH }));
    if (detailH) out.push(...pane({ title: [seg(v.cur < v.accounts.length ? v.accounts[v.cur].name : 'All inboxes', ST.bold)], lines: accountDetail(v), width, height: detailH }));
  } else if (v.mode === 'start' || v.mode === 'steps') {
    const lines = v.mode === 'start' ? startLines(v, ctx, inner) : stepsLines(v, ctx.frame, inner);
    const meta = v.mode === 'start' ? [seg(v.unread ? 'nothing changes until you choose' : 'all caught up', ST.dim)] : [];
    out.push(...pane({ title: [seg(v.title ?? 'Inbox', ST.bold)], meta, lines, width, height: Math.min(rows - fixed, lines.length + 3) }));
  } else if (v.mode === 'summary' || v.mode === 'loading') {
    const h = rows - fixed;
    let lines;
    let title;
    let meta = [];
    if (v.mode === 'summary') {
      lines = summaryLines(v, inner);
      title = [seg('Session complete', ST.bold)];
      meta = [seg(`${v.summary.emails} emails · ${v.summary.batches.length} batches`, ST.dim)];
    } else {
      lines = [{ segs: [] }, { segs: [seg(`${FRAMES[ctx.frame % FRAMES.length]} `, ST.imp), seg(v.loadingText ?? `Sorting batch ${v.batchNum} of ${total}…`)] }];
      title = batchTitle('Inbox');
    }
    out.push(...pane({ title, meta, lines, width, height: h }));
  } else {
    const previewH = rows >= 22 ? 7 : 0;
    const mainH = rows - fixed - previewH;
    if (v.mode === 'review') {
      const { lines, cursorLine } = reviewLines(v, inner);
      const { visible, footMeta } = windowed(v, 'reviewScroll', [{ segs: [] }, ...lines], cursorLine + 1, mainH - 2);
      out.push(...pane({ title: batchTitle('Review'), meta: [seg('nothing sent to Gmail yet', ST.dim)], footMeta, lines: visible, width, height: mainH }));
      if (previewH) out.push(...pane({ title: [seg('Selected email', ST.bold)], lines: detailLines(selectedReviewItem(v), inner, 'review'), width, height: previewH }));
    } else {
      const { lines, cursorLine, showTag } = listLines(v, inner);
      const { visible, footMeta } = windowed(v, 'scroll', [{ segs: [] }, ...lines], cursorLine + 1, mainH - 2);
      out.push(...pane({ title: batchTitle('Inbox'), meta: nextBatchStatus(v, ctx), footMeta, lines: visible, width, height: mainH }));
      if (previewH) out.push(...pane({ title: [seg('Preview', ST.bold)], lines: detailLines(current(v), inner, 'list', showTag), width, height: previewH }));
    }
  }
  while (out.length < rows - footer.length) out.push([]);
  out.push(...footer);
  return out.slice(0, rows).map(segs => toAnsi(fitSegs(segs, width)));
}

// ─── Terminal driver ───────────────────────────────────────────────────────

class Screen {
  // onAction handles outcomes that don't end the current screen: { type: 'open', id } opens an
  // email in Gmail, { type: 'reopen', url } reopens the Google sign-in page.
  constructor({ stdin = process.stdin, stdout = process.stdout, bgState = { inFlight: new Set() }, session = {}, onAction = () => {} } = {}) {
    Object.assign(this, { stdin, stdout, bgState, session, onAction });
    this.view = null;
    this.resolve = null;
    this.toastState = null;
    this.frame = 0;
    this.lastResolveAt = 0;
    this.onKey = this.onKey.bind(this);
    this.draw = this.draw.bind(this);
    this.restore = this.restore.bind(this);
  }

  open() {
    this.stdout.write(`${CSI}?1049h${CSI}?25l`);
    readline.emitKeypressEvents(this.stdin);
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.on('keypress', this.onKey);
    this.stdin.resume();
    this.stdout.on('resize', this.draw);
    process.once('exit', this.restore);
    this.timer = setInterval(() => this.tick(), 90);
  }

  restore() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.stdin.removeListener('keypress', this.onKey);
    this.stdout.removeListener('resize', this.draw);
    process.removeListener('exit', this.restore);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.stdout.write(`${CSI}0m${CSI}?25h${CSI}?1049l`);
  }

  close() { this.restore(); }

  // Show a view and wait for an outcome (apply, undo, quit, done).
  wait(view) {
    this.show(view);
    return new Promise(resolve => { this.resolve = resolve; });
  }

  show(view) {
    this.view = view;
    this.resolve = null;
    this.draw();
  }

  busy(text) {
    if (!this.view) return;
    this.view.busy = text;
    this.draw();
  }

  idle() {
    if (this.view) delete this.view.busy;
    this.draw();
  }

  toast(kind, text) {
    this.toastState = { kind, text, at: Date.now() };
    this.draw();
  }

  tick() {
    this.frame++;
    const v = this.view;
    if (!v) return;
    const toastLive = this.toastState && Date.now() - this.toastState.at < TOAST_MS + 200;
    const spinning = v.mode === 'steps' && v.steps.some(s => s.state === 'active');
    if (v.busy || v.mode === 'loading' || spinning || this.bgState.inFlight.size || toastLive) this.draw();
  }

  onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') {
      this.restore();
      process.exit(130);
    }
    const v = this.view;
    // Keys only count on a screen that's waiting for an answer, or on the sign-in step (E reopens
    // the browser while the app waits on Google).
    if (!v || v.busy || (!this.resolve && !v.url)) return;
    const k = { name: key.name ?? str, shift: !!key.shift };
    const now = Date.now();
    if ((k.name === 'e' || k.name === 'q') && now - this.lastResolveAt < REPEAT_GUARD_MS) return;
    const outcome = handleKey(v, k, { now, canUndo: !!this.session.canUndo });
    if (v.toast) { this.toastState = { ...v.toast, at: now }; delete v.toast; }
    if (outcome?.type === 'open' || outcome?.type === 'reopen') this.onAction(outcome);
    else if (outcome && this.resolve) {
      const resolve = this.resolve;
      this.resolve = null;
      this.lastResolveAt = now;
      resolve(outcome);
    }
    this.draw();
  }

  draw() {
    if (!this.view || this.closed) return;
    const lines = render(this.view, {
      cols: this.stdout.columns ?? 100, rows: this.stdout.rows ?? 32,
      session: this.session, canUndo: !!this.session.canUndo, inFlight: this.bgState.inFlight, frame: this.frame,
      toast: this.toastState, now: Date.now(),
    });
    this.stdout.write(`${CSI}H${lines.join(`${CSI}K\r\n`)}${CSI}K${CSI}J`);
  }
}

module.exports = {
  Screen, createView, handleKey, render, plan, action, effRead, filterDue, willFilter, learnKind,
  strWidth, fit, bigNumber, TILES, FILTER_THRESHOLD,
};
