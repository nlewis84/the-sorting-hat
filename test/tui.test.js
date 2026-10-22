const test = require('node:test');
const assert = require('node:assert/strict');
const tui = require('../tui');

const learn = (counts = {}) => ({
  important: { count: 0, filtered: false, ...counts.important },
  neutral: { count: 0, filtered: false, ...counts.neutral },
  spam: { count: 0, filtered: false, ...counts.spam },
});

function item(id, house, extra = {}) {
  return {
    id, house, orig: house, read: house === 'neutral', skip: {}, guard: null, learn: learn(),
    name: `Sender ${id}`, addr: `${id}@example.com`, subject: `Subject ${id}`, snippet: 'Preview text', reason: 'reason', labelIds: ['INBOX', 'UNREAD'],
    ...extra,
  };
}

function batch() {
  return tui.createView({
    batchNum: 1,
    items: [
      item('job', 'important', { guard: 'job' }),
      item('stmt', 'neutral', { learn: learn({ neutral: { count: 2 } }) }),
      item('news', 'neutral'),
      item('sale', 'junk', { learn: learn({ spam: { count: 2 } }) }),
      item('camp', 'junk'),
    ],
  });
}

const key = (name, shift = false) => ({ name, shift });
const press = (v, ...keys) => keys.map(k => tui.handleKey(v, typeof k === 'string' ? key(k) : k, { now: 10_000, canUndo: true })).at(-1);
const byId = (v, id) => v.items.find(e => e.id === id);
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('plan covers stars, reads, spam and due filters', () => {
  const p = tui.plan(batch().items);
  assert.deepEqual(p.star.map(e => e.id), ['job']);
  assert.deepEqual(p.read.map(e => e.id), ['stmt', 'news']);
  assert.deepEqual(p.spam.map(e => e.id), ['sale', 'camp']);
  assert.deepEqual(p.filters.map(e => e.id), ['stmt', 'sale']);
});

test('protected senders never get a filter', () => {
  const v = batch();
  const job = byId(v, 'job');
  job.house = 'junk';
  job.learn = learn({ spam: { count: 5 } });
  assert.equal(tui.filterDue(job), false);
  assert.equal(tui.learnKind(job), null);
});

test('a sender that already has a filter is not offered another', () => {
  const e = item('x', 'neutral', { learn: learn({ neutral: { count: 4, filtered: true } }) });
  assert.equal(tui.filterDue(e), false);
});

test('D moves the selected email one house toward junk and resets its defaults', () => {
  const v = batch();
  v.cur = 'stmt';
  press(v, 'd');
  const e = byId(v, 'stmt');
  assert.equal(e.house, 'junk');
  assert.equal(e.read, false);
  assert.equal(tui.action(e), 'spam');
});

test('number keys set the house directly and A moves toward important', () => {
  const v = batch();
  v.cur = 'camp';
  press(v, '1');
  assert.equal(byId(v, 'camp').house, 'important');
  v.cur = 'news';
  press(v, 'a');
  assert.equal(byId(v, 'news').house, 'important');
});

test('W/S move the cursor in display order and Shift jumps between houses', () => {
  const v = batch();
  assert.equal(v.cur, 'job');
  press(v, 's');
  assert.equal(v.cur, 'stmt');
  press(v, key('s', true));
  assert.equal(v.cur, 'sale');
  press(v, key('w', true));
  assert.equal(v.cur, 'stmt');
});

test('Space toggles read in the list but never on junk', () => {
  const v = batch();
  v.cur = 'job';
  press(v, 'space');
  assert.equal(tui.action(byId(v, 'job')), 'star + read');
  v.cur = 'sale';
  press(v, 'space');
  assert.equal(tui.action(byId(v, 'sale')), 'spam');
  assert.match(v.toast.text, /Junk goes to spam/);
});

test('E opens review on the first non-empty tile; E again applies', () => {
  const v = batch();
  assert.equal(press(v, 'e'), null);
  assert.equal(v.mode, 'review');
  assert.equal(tui.TILES[v.tile].key, 'star');
  assert.deepEqual(tui.handleKey(v, key('e'), { now: v.reviewAt + 1000 }), { type: 'apply', skipFilters: false });
});

test('a held E does not skip through review', () => {
  const v = batch();
  tui.handleKey(v, key('e'), { now: 1000 });
  assert.equal(tui.handleKey(v, key('e'), { now: 1100 }), null);
});

test('Shift+E applies without filters only when filters are planned', () => {
  const v = batch();
  tui.handleKey(v, key('e'), { now: 0 });
  assert.deepEqual(tui.handleKey(v, key('e', true), { now: 1000 }), { type: 'apply', skipFilters: true });
  const none = tui.createView({ batchNum: 1, items: [item('a', 'important')] });
  tui.handleKey(none, key('e'), { now: 0 });
  assert.equal(tui.handleKey(none, key('e', true), { now: 1000 }), null);
});

test('Space on a review tile reverts that change and Space again restores it', () => {
  const v = batch();
  press(v, 'e');
  v.tile = tui.TILES.findIndex(t => t.key === 'spam');
  v.row = 0;
  press(v, 'space');
  assert.equal(tui.action(byId(v, 'sale')), 'keep in inbox');
  assert.equal(tui.filterDue(byId(v, 'sale')), false, 'kept mail no longer feeds the spam filter');
  press(v, 'space');
  assert.equal(tui.action(byId(v, 'sale')), 'spam');
});

test('skipping a filter keeps the email change', () => {
  const v = batch();
  press(v, 'e');
  v.tile = tui.TILES.findIndex(t => t.key === 'filter');
  v.row = 0;
  press(v, 'space');
  const stmt = byId(v, 'stmt');
  assert.equal(tui.willFilter(stmt), false);
  assert.equal(tui.action(stmt), 'mark read');
});

test('undoing a move from review puts the email back where the hat had it', () => {
  const v = batch();
  v.cur = 'camp';
  press(v, '1', 'e');
  v.tile = tui.TILES.findIndex(t => t.key === 'move');
  v.row = 0;
  press(v, 'space');
  assert.equal(byId(v, 'camp').house, 'junk');
  press(v, 'space');
  assert.equal(byId(v, 'camp').house, 'important');
});

test('Q undoes only when there is something to undo; Shift+Q quits', () => {
  const v = batch();
  assert.deepEqual(tui.handleKey(v, key('q'), { canUndo: true }), { type: 'undo' });
  assert.equal(tui.handleKey(v, key('q'), { canUndo: false }), null);
  assert.deepEqual(tui.handleKey(v, key('q', true), {}), { type: 'quit' });
  press(v, 'e');
  press(v, 'q');
  assert.equal(v.mode, 'list', 'Q in review goes back instead of undoing');
});

test('the summary footer offers undo only when a batch can be undone', () => {
  const v = { mode: 'summary', batchNum: 1, items: [], summary: { emails: 1, star: 0, read: 1, spam: 0, filters: 0, moved: 0, unread: 0, batches: [], leftUnsorted: 0 } };
  const session = { account: { name: 'Personal', email: 'you@example.com' }, total: 1, totalBatches: 1, sorted: 1 };
  const footer = canUndo => strip(tui.render(v, { cols: 100, rows: 24, session, frame: 0, canUndo }).at(-1));
  assert.match(footer(true), /undo last batch/);
  assert.doesNotMatch(footer(false), /undo/);
});

test('strWidth counts emoji and CJK as two cells', () => {
  assert.equal(tui.strWidth('abc'), 3);
  assert.equal(tui.strWidth('🎉 sale'), 7);
  assert.equal(tui.strWidth('日本'), 4);
  assert.equal(tui.strWidth(tui.fit('🎉🎉🎉🎉', 5)), 5);
});

test('every rendered line fits the terminal in every mode', () => {
  const session = { account: { name: 'Personal', email: 'you@example.com' }, total: 20, totalBatches: 2, sorted: 5 };
  for (const [cols, rows] of [[80, 24], [100, 32], [140, 45]]) {
    const v = batch();
    byId(v, 'news').subject = '🎉 A very long newsletter subject line with emoji 日本語 that keeps going and going';
    const check = label => {
      const lines = tui.render(v, { cols, rows, session, frame: 0, inFlight: new Set([2]) });
      assert.equal(lines.length, rows, `${label} at ${cols}x${rows}: line count`);
      for (const l of lines) assert.ok(tui.strWidth(strip(l)) <= cols - 1, `${label} at ${cols}x${rows}: "${strip(l)}"`);
    };
    check('list');
    press(v, 'e');
    check('review');
    v.mode = 'summary';
    v.summary = { emails: 5, star: 1, read: 2, spam: 2, filters: 1, moved: 0, unread: 0, batches: [{ num: 1, star: 1, read: 2, spam: 2, filters: 1, moved: 0 }], leftUnsorted: 0 };
    check('summary');
  }
});
