const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// index.js resolves learning.json from the working directory at load time, so move into a
// scratch directory first; these tests must never touch a real learning.json.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hat-test-'));
process.chdir(tmp);
const { toItems, applyBatch, revertBatch } = require('../index');
const tui = require('../tui');

function fakeGmail() {
  const calls = [];
  let n = 0;
  return {
    calls,
    users: {
      messages: { batchModify: async ({ requestBody }) => { calls.push(['modify', requestBody]); return { data: {} }; } },
      settings: {
        filters: {
          create: async ({ requestBody }) => { calls.push(['filter+', requestBody]); return { data: { id: `f${++n}` } }; },
          delete: async ({ id }) => { calls.push(['filter-', id]); return { data: {} }; },
        },
      },
    },
  };
}

const account = { id: 'personal', email: 'you@example.com' };
const email = (id, from, labelIds = ['INBOX', 'UNREAD']) => ({ id, from, subject: `Subject ${id}`, snippet: '', labelIds });

function fixture() {
  const learning = { personal: { neutral: { 'no-reply@chase.com': { count: 2, filterId: null } }, important: {}, spam: {} } };
  const batch = {
    emails: [
      email('a', 'Dana <dana@example.com>', ['INBOX', 'UNREAD', 'IMPORTANT']),
      email('b', 'Chase <no-reply@chase.com>'),
      email('c', "Kohl's <kohls@s.kohls.com>"),
      email('d', 'Greenhouse <no-reply@greenhouse-mail.io>'),
    ],
    result: { emails: [
      { index: 1, category: 'important', reason: 'personal' },
      { index: 2, category: 'neutral', reason: 'statement' },
      { index: 3, category: 'junk', reason: 'sale' },
      { index: 4, category: 'important', reason: 'job application' },
    ] },
  };
  const view = tui.createView({ batchNum: 1, items: toItems(batch, learning, 'personal') });
  return { learning, view };
}

test('toItems carries learning history and job protection', () => {
  const { view } = fixture();
  const byId = id => view.items.find(e => e.id === id);
  assert.equal(byId('b').learn.neutral.count, 2);
  assert.equal(byId('d').guard, 'job');
  assert.equal(byId('a').name, 'Dana');
});

test('apply batches label changes, records learning once, and creates due filters', async () => {
  const { learning, view } = fixture();
  const gmail = fakeGmail();
  const rec = await applyBatch(gmail, account, view, learning, false);

  const modifies = gmail.calls.filter(c => c[0] === 'modify').map(c => c[1]);
  assert.deepEqual(modifies[0], { ids: ['a', 'd'], addLabelIds: ['STARRED', 'IMPORTANT'], removeLabelIds: [] });
  assert.deepEqual(modifies[1], { ids: ['b'], addLabelIds: [], removeLabelIds: ['UNREAD'] });
  assert.deepEqual(modifies[2], { ids: ['c'], addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });

  assert.equal(learning.personal.neutral['no-reply@chase.com'].count, 3);
  assert.equal(learning.personal.neutral['no-reply@chase.com'].filterId, 'f1');
  assert.equal(learning.personal.spam['kohls@s.kohls.com'].count, 1);
  assert.equal(rec.counts.filters, 1);
});

test('skipping filters still records the decision', async () => {
  const { learning, view } = fixture();
  const gmail = fakeGmail();
  await applyBatch(gmail, account, view, learning, true);
  assert.equal(gmail.calls.some(c => c[0] === 'filter+'), false);
  assert.equal(learning.personal.neutral['no-reply@chase.com'].count, 3);
});

test('undo reverses labels, learning and filters, and keeps labels Gmail already had', async () => {
  const { learning, view } = fixture();
  const gmail = fakeGmail();
  const rec = await applyBatch(gmail, account, view, learning, false);
  gmail.calls.length = 0;
  await revertBatch(gmail, account, rec, learning);

  const modifies = gmail.calls.filter(c => c[0] === 'modify').map(c => c[1]);
  // 'a' already had IMPORTANT before the batch, so only STARRED comes off it.
  assert.deepEqual(modifies.find(m => m.ids.includes('a')).removeLabelIds, ['STARRED']);
  assert.deepEqual(modifies.find(m => m.ids.includes('d')).removeLabelIds, ['STARRED', 'IMPORTANT']);
  assert.ok(modifies.some(m => m.ids.includes('b') && m.addLabelIds.includes('UNREAD')));
  assert.ok(modifies.some(m => m.ids.includes('c') && m.addLabelIds.includes('INBOX') && m.removeLabelIds.includes('SPAM')));
  assert.deepEqual(gmail.calls.filter(c => c[0] === 'filter-'), [['filter-', 'f1']]);

  assert.deepEqual(learning.personal.neutral['no-reply@chase.com'], { count: 2, filterId: null });
  assert.equal(learning.personal.spam['kohls@s.kohls.com'], undefined);
});

test.after(() => {
  process.chdir(os.tmpdir());
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
