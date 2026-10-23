const { google } = require('googleapis');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { existsSync } = require('fs');
const tui = require('./tui');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const ACCOUNTS_PATH = path.join(process.cwd(), 'accounts.json');
const LEARNING_PATH = path.join(process.cwd(), 'learning.json');
const PORT_START = 3000;
const PORT_TRIES = 20;
const FILTER_THRESHOLD = 3;
const BATCH_SIZE = 15;
const LOOKAHEAD = 2;

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen2.5-coder:14b';

// ─── Colors ────────────────────────────────────────────────────────────────

// Only used for the lines printed after the full-screen UI closes; the UI itself is drawn by tui.js.
const A = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', bGreen: '\x1b[92m', bYellow: '\x1b[93m' };
const R = A.reset;
const clr = {
  ok:  s => `${A.bGreen}${s}${R}`,
  err: s => `${A.red}${s}${R}`,
  dim: s => `${A.dim}${s}${R}`,
};

// ─── Auth & config ─────────────────────────────────────────────────────────

function extractEmail(from) {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

async function loadKeys(credentialsFile) {
  const file = credentialsFile ? path.join(process.cwd(), credentialsFile) : CREDENTIALS_PATH;
  const keys = JSON.parse(await fs.readFile(file));
  return keys.installed || keys.web;
}

async function loadAccounts() {
  return JSON.parse(await fs.readFile(ACCOUNTS_PATH));
}

async function loadLearning() {
  try { return JSON.parse(await fs.readFile(LEARNING_PATH, 'utf8')); }
  catch { return {}; }
}

async function saveLearning(data) {
  await fs.writeFile(LEARNING_PATH, JSON.stringify(data, null, 2));
}

// Bind to the first free port at or after PORT_START instead of dying on EADDRINUSE.
function listenOnFreePort(server, startPort = PORT_START, tries = PORT_TRIES) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const lastPort = startPort + tries - 1;
    const onError = (err) => {
      if (err.code !== 'EADDRINUSE' || port >= lastPort) {
        server.removeListener('error', onError);
        reject(err.code === 'EADDRINUSE' ? new Error(`No free port found in ${startPort}-${lastPort}.`) : err);
        return;
      }
      port += 1;
      server.listen(port);
    };
    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve(port);
    });
    server.listen(port);
  });
}

// `onBrowser(url, port)` is called when Google sign-in is needed and the browser is being opened.
async function authorize(account, { onBrowser = () => {} } = {}) {
  const keys = await loadKeys(account.credentialsFile);
  const tokenPath = path.join(process.cwd(), account.tokenFile);
  const client = new google.auth.OAuth2(keys.client_id, keys.client_secret);

  try {
    client.setCredentials(JSON.parse(await fs.readFile(tokenPath, 'utf8')));
    await client.getAccessToken();
    return client;
  } catch { /* need new auth */ }

  const server = http.createServer();
  const port = await listenOnFreePort(server);
  const redirectUri = `http://localhost:${port}`;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.on('request', async (req, res) => {
      try {
        const code = new URL(req.url, redirectUri).searchParams.get('code');
        if (!code) { res.end('Missing code.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization successful! You can close this tab.</h2>');
        server.close();
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        client.setCredentials(tokens);
        await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
        resolve(client);
      } catch (err) { server.close(); reject(err); }
    });
    const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', login_hint: account.email, redirect_uri: redirectUri });
    onBrowser(url, port);
    openUrl(url);
  });
}

function openUrl(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const gmailLink = (account, id) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${id}`;

// ─── Gmail API ─────────────────────────────────────────────────────────────

async function getAllMessageRefs(gmail) {
  const refs = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'is:unread', maxResults: 500, pageToken });
    refs.push(...(res.data.messages ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return refs;
}

async function fetchBatchMetadata(gmail, refs) {
  const emails = [];
  for (const ref of refs) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const get = (name) => (msg.data.payload.headers.find(h => h.name === name) ?? {}).value ?? '';
    emails.push({ id: ref.id, from: get('From'), date: get('Date'), subject: get('Subject'), snippet: msg.data.snippet, labelIds: msg.data.labelIds ?? [] });
  }
  return emails;
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (err.status === 429 && attempt < 5) await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
      else throw err;
    }
  }
}

// One request per label change for the whole batch instead of one per email.
async function batchModify(gmail, ids, { add = [], remove = [] }) {
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await withRetry(() => gmail.users.messages.batchModify({ userId: 'me', requestBody: { ids: chunk, addLabelIds: add, removeLabelIds: remove } }));
  }
}

function ensureAccount(learning, accountId) {
  if (!learning[accountId]) {
    learning[accountId] = { neutral: {}, important: {}, spam: {} };
    return;
  }
  const acc = learning[accountId];
  if (!acc.neutral && !acc.important) {
    learning[accountId] = { neutral: acc, important: {}, spam: {} };
  }
  if (!learning[accountId].neutral) learning[accountId].neutral = {};
  if (!learning[accountId].important) learning[accountId].important = {};
  if (!learning[accountId].spam) learning[accountId].spam = {};
}

const FILTER_ACTIONS = {
  neutral: { removeLabelIds: ['UNREAD'] },
  important: { addLabelIds: ['IMPORTANT'] },
  spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
};

// Count one decision for a sender. When `allowFilter` is set and the count reaches the threshold,
// create the Gmail filter for that bucket. Returns what changed so the batch can be undone.
async function recordSender(gmail, learning, accountId, kind, sender, allowFilter) {
  ensureAccount(learning, accountId);
  const senders = learning[accountId][kind];
  const rec = senders[sender] ?? (senders[sender] = { count: 0, filterId: null });
  rec.count++;
  const entry = { kind, sender, filterId: null };
  if (allowFilter && rec.count >= FILTER_THRESHOLD && !rec.filterId) {
    try {
      const res = await withRetry(() => gmail.users.settings.filters.create({
        userId: 'me', requestBody: { criteria: { from: sender }, action: FILTER_ACTIONS[kind] },
      }));
      rec.filterId = entry.filterId = res.data.id;
    } catch (err) {
      entry.error = err.message;
    }
  }
  return entry;
}

// Apply a reviewed batch: label changes first, then learning (one record per email, based on
// where it finally landed). Returns a record that revertBatch can undo.
async function applyBatch(gmail, account, view, learning, skipFilters) {
  const p = tui.plan(view.items);
  const ids = list => list.map(e => e.id);
  await batchModify(gmail, ids(p.star), { add: ['STARRED', 'IMPORTANT'] });
  await batchModify(gmail, ids(p.read), { remove: ['UNREAD'] });
  await batchModify(gmail, ids(p.spam), { add: ['SPAM'], remove: ['INBOX'] });

  const learned = [];
  for (const e of view.items) {
    const kind = tui.learnKind(e);
    if (kind) learned.push(await recordSender(gmail, learning, account.id, kind, e.addr, !skipFilters && tui.willFilter(e)));
  }
  await saveLearning(learning);

  return {
    view, skipFilters, learned,
    star: ids(p.star), read: ids(p.read), spam: ids(p.spam),
    counts: {
      star: p.star.length, read: p.read.length, spam: p.spam.length,
      filters: learned.filter(l => l.filterId).length,
      moved: p.moved.length,
      unread: view.items.filter(e => !tui.effRead(e) && !p.spam.includes(e)).length,
    },
    failures: learned.filter(l => l.error),
  };
}

async function revertBatch(gmail, account, rec, learning) {
  // Only remove the labels this batch added; Gmail may have marked some of them IMPORTANT already.
  const byId = new Map(rec.view.items.map(e => [e.id, e]));
  const groups = new Map();
  for (const id of rec.star) {
    const remove = ['STARRED', 'IMPORTANT'].filter(l => !byId.get(id).labelIds.includes(l));
    const key = remove.join(',');
    if (!groups.has(key)) groups.set(key, { remove, ids: [] });
    groups.get(key).ids.push(id);
  }
  for (const g of groups.values()) if (g.remove.length) await batchModify(gmail, g.ids, { remove: g.remove });
  await batchModify(gmail, rec.read, { add: ['UNREAD'] });
  await batchModify(gmail, rec.spam, { add: ['INBOX'], remove: ['SPAM'] });

  ensureAccount(learning, account.id);
  for (const l of rec.learned) {
    const senders = learning[account.id][l.kind];
    const s = senders[l.sender];
    if (!s) continue;
    if (l.filterId) {
      await withRetry(() => gmail.users.settings.filters.delete({ userId: 'me', id: l.filterId }));
      s.filterId = null;
    }
    s.count = Math.max(0, s.count - 1);
    if (!s.count && !s.filterId) delete senders[l.sender];
  }
  await saveLearning(learning);
}

// ─── Job-search guard ──────────────────────────────────────────────────────
// Job application emails must never be missed: they skip the LLM (always important)
// and their senders never get auto-created read/spam filters.

// Applicant-tracking systems that send candidate mail (confirmations, interviews, decisions).
const ATS_DOMAIN = /(^|\.)(greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|myworkdayjobs\.com|icims\.com|smartrecruiters\.com|jobvite\.com|taleo\.net|successfactors\.(com|eu)|workablemail\.com|workable\.com|bamboohr\.com|breezy\.hr|applytojob\.com|recruitee\.com|teamtailor\.com|dover\.com)$/i;
// Job boards: not always important, but never auto-filtered (recruiter messages and application notices come from here).
const JOB_BOARD_DOMAIN = /(^|\.)(linkedin\.com|indeed\.com|ziprecruiter\.com|glassdoor\.com|wellfound\.com|dice\.com|hired\.com|theladders\.com)$/i;

// Bare "your application" is too broad: dev tools say it about software ("latency across your application").
const APPLICATION = 'your application (for|to|with|at|status|update|has been (received|reviewed|submitted)|was (received|reviewed|submitted|sent|viewed))|(received|reviewing) your application|regarding your application|thank(s| you) for (applying|your application)|application (received|status|update)|your candidacy';
const JOB_PHRASE = new RegExp(`\\b(${APPLICATION}|interview|other candidates|offer letter|recruiter|hiring (manager|team))\\b`, 'i');
// Unambiguous enough to trust in the preview text, not just the subject.
const JOB_PHRASE_STRONG = new RegExp(`\\b(${APPLICATION}|schedul(e|ing) (an|your) interview)\\b`, 'i');
const JOB_DIGEST = /\b(jobs? (you may|for you|alerts?|similar)|new jobs|recommended jobs|dream job|top job picks|is hiring|are hiring)\b/i;

const senderDomain = from => extractEmail(from).split('@')[1] ?? '';

function isJobEmail(e) {
  if (ATS_DOMAIN.test(senderDomain(e.from))) return true;
  if (JOB_DIGEST.test(e.subject)) return false;
  return JOB_PHRASE.test(e.subject) || JOB_PHRASE_STRONG.test(e.snippet ?? '');
}

function isProtectedJobSender(e) {
  const domain = senderDomain(e.from);
  return isJobEmail(e) || ATS_DOMAIN.test(domain) || JOB_BOARD_DOMAIN.test(domain);
}

// ─── LLM ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an inbox organizer. Sort each email into a category and return ONLY valid JSON in this exact shape:
{
  "emails": [
    { "index": 1, "category": "important", "reason": "brief reason" },
    { "index": 2, "category": "neutral", "reason": "brief reason" },
    { "index": 3, "category": "junk", "reason": "brief reason" }
  ]
}

Use "important" ONLY for these:
- Job/career: recruiter outreach, interview invites, application status updates, hiring decisions, HR or talent team messages
- Direct personal replies: subject starts with "Re:" AND sender is a named real person with a non-automated address
- School, church, or youth org: emails from a named teacher, pastor, coach, administrator, or youth group coordinator
- Child safety alerts: Bark or similar monitoring notifications about a child's device activity
- Security alerts: account login notices, password changes, suspicious activity warnings
- Confirmed reservations or bookings that require action or contain trip details (e.g. Recreation.gov, airline, hotel)
- Direct personal messages from a known individual (not a company or mailing list)

Use "neutral" for: mortgage/financial statements, HOA meeting notices, investment account statements, payment receipts, order confirmations, automated bank alerts, newsletters, app notifications, neighborhood social posts, church bulletins, local news digests, store hours/updates.

Use "junk" for: promotional offers, discount codes, sales emails, pre-selected credit card offers, cruise/travel upsells, unsolicited marketing, bulk advertising.

NEVER mark as important: financial offers ("pre-selected", "you've been chosen", "earn more"), credit card applications, promotional reminders from banks or retailers, routine monthly statements, or any email from a no-reply address unless it is a security alert, confirmed booking, or an update about a job application.

When in doubt between "important" and "neutral", choose "neutral". Return valid JSON only, no explanation.`;

function robustParse(raw) {
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function extractItems(parsed) {
  const arr = parsed?.emails ?? parsed?.email_list ?? parsed?.items ?? parsed?.results ?? parsed?.categorized;
  if (Array.isArray(arr)) return arr;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const first = Object.values(parsed).find(v => Array.isArray(v));
    if (first) return first;
  }
  return null;
}

function isValidCategorization(items) {
  return items.length > 0 && items[0].index !== undefined && items[0].category !== undefined;
}

async function callOllama(messages) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: QWEN_MODEL, stream: false, format: 'json', messages }),
  });
  if (!response.ok) throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  return (await response.json()).message.content;
}

async function writeDebugLog(label, raw, parsed, items) {
  const entry = [
    `\n${'='.repeat(60)}`,
    `${label}  (${new Date().toISOString()})`,
    '--- raw response ---',
    raw,
    '--- robustParse result ---',
    JSON.stringify(parsed, null, 2),
    '--- extractItems result ---',
    JSON.stringify(items, null, 2),
  ].join('\n');
  await fs.appendFile(path.join(process.cwd(), 'llm-debug.log'), entry).catch(() => {});
}

async function analyzeWithQwen(emails) {
  const jobIds = new Set(emails.filter(isJobEmail).map(e => e.id));
  const toAnalyze = emails.filter(e => !jobIds.has(e.id) && !e.labelIds.includes('STARRED') && !e.labelIds.includes('IMPORTANT'));
  const preImportant = new Set(emails.filter(e => e.labelIds.includes('STARRED') || e.labelIds.includes('IMPORTANT')).map(e => e.id));

  const merge = (llmItems, parseWarning) => {
    const llmById = new Map();
    if (llmItems) {
      for (const item of llmItems) {
        const e = toAnalyze[item.index - 1];
        if (e) llmById.set(e.id, { category: item.category, reason: item.reason });
      }
    }
    return {
      emails: emails.map((e, i) => {
        if (jobIds.has(e.id)) return { index: i + 1, category: 'important', reason: 'job application' };
        if (preImportant.has(e.id)) return { index: i + 1, category: 'important', reason: 'already starred in Gmail' };
        const r = llmById.get(e.id) ?? { category: 'neutral', reason: '' };
        return { index: i + 1, ...r };
      }),
      parseWarning,
    };
  };

  if (toAnalyze.length === 0) return merge(null, false);

  const emailList = toAnalyze
    .map((e, i) => `[${i + 1}] From: ${e.from}\n    Subject: ${e.subject}\n    Preview: ${e.snippet}`)
    .join('\n\n');

  const raw1 = await callOllama([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Categorize these ${toAnalyze.length} unread emails:\n\n${emailList}` },
  ]);
  const parsed1 = robustParse(raw1);
  const items1 = extractItems(parsed1);
  if (items1 && isValidCategorization(items1)) return merge(items1, false);

  await writeDebugLog(`ATTEMPT 1 FAILED (${toAnalyze.length} emails)`, raw1, parsed1, items1);

  const STRICT_PROMPT = `Return ONLY this JSON, nothing else:
{"emails":[{"index":1,"category":"neutral","reason":"why"}]}
Valid categories: "important", "neutral", "junk"
index = the number in brackets from the list.
CRITICAL: job application / recruiter emails MUST be "important".`;

  const raw2 = await callOllama([
    { role: 'system', content: STRICT_PROMPT },
    { role: 'user', content: `Categorize (index + category + reason only):\n\n${emailList}` },
  ]);
  const parsed2 = robustParse(raw2);
  const items2 = extractItems(parsed2);
  if (items2 && isValidCategorization(items2)) return merge(items2, false);

  await writeDebugLog('ATTEMPT 2 (strict) FAILED', raw2, parsed2, items2);
  return merge(null, true);
}

// ─── Pipeline ──────────────────────────────────────────────────────────────

async function* batchPipeline(gmail, allRefs, bgState) {
  const chunks = [];
  for (let i = 0; i < allRefs.length; i += BATCH_SIZE) chunks.push(allRefs.slice(i, i + BATCH_SIZE));

  const pending = [];
  let nextToLaunch = 0;

  function launchNext() {
    if (nextToLaunch < chunks.length) {
      const batchNum = nextToLaunch + 1;
      const chunk = chunks[nextToLaunch++];
      bgState.inFlight.add(batchNum);
      pending.push(
        fetchBatchMetadata(gmail, chunk).then(emails =>
          analyzeWithQwen(emails).then(result => {
            bgState.inFlight.delete(batchNum);
            return { emails, result };
          })
        )
      );
    }
  }

  for (let i = 0; i < Math.min(LOOKAHEAD, chunks.length); i++) launchNext();

  while (pending.length > 0) {
    const batch = await pending.shift();
    launchNext();
    yield batch;
  }
}

// ─── Batch review ──────────────────────────────────────────────────────────

const PARSE_WARNING = "The model's reply couldn't be parsed, so this batch defaulted to neutral. Details in llm-debug.log.";
const HOUSES = ['important', 'neutral', 'junk'];

// Turn a fetched, classified batch into review items: the hat's pick, the sender's learning
// history (so the screen can show how close each sender is to an auto-filter), and job protection.
function toItems(batch, learning, accountId) {
  ensureAccount(learning, accountId);
  const acc = learning[accountId];
  return batch.result.emails.map(r => {
    const e = batch.emails[r.index - 1];
    if (!e) return null;
    const house = HOUSES.includes(r.category) ? r.category : 'neutral';
    const addr = extractEmail(e.from);
    const learn = {};
    for (const kind of ['important', 'neutral', 'spam']) {
      const rec = acc[kind][addr];
      learn[kind] = { count: rec?.count ?? 0, filtered: !!rec?.filterId };
    }
    const guard = isJobEmail(e) ? 'job' : JOB_BOARD_DOMAIN.test(senderDomain(e.from)) ? 'board' : null;
    return {
      ...e,
      addr,
      name: e.from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim() || addr,
      house, orig: house, reason: r.reason ?? '',
      read: house === 'neutral', skip: {}, guard, learn,
    };
  }).filter(Boolean);
}

function applyMessage(rec) {
  const c = rec.counts;
  let msg = `Batch ${rec.view.batchNum} applied: ${c.star} starred, ${c.read} read, ${c.spam} to spam`;
  if (c.filters) msg += `, ▽ ${c.filters} new filter${c.filters > 1 ? 's' : ''}`;
  if (rec.skipFilters && tui.plan(rec.view.items).filters.length) msg += ', filters skipped';
  if (rec.failures.length) msg += `. Couldn't create a filter for ${rec.failures.map(f => f.sender).join(', ')}`;
  return `${msg}. Q to undo.`;
}

async function reviewBatches(screen, gmail, account, allRefs, totalBatches) {
  const learning = await loadLearning();
  const bgState = { inFlight: new Set() };
  const pipeline = batchPipeline(gmail, allRefs, bgState);
  const session = { account, model: screen.session.model, total: allRefs.length, totalBatches, sorted: 0, canUndo: false };
  screen.session = session;
  screen.bgState = bgState;
  const applied = [];
  const redo = []; // views to show again before pulling a new batch (after an undo or a failed apply)
  let pulled = 0;
  let quit = false;

  const syncSession = () => {
    session.sorted = applied.reduce((n, a) => n + a.view.items.length, 0);
    session.canUndo = applied.length > 0;
  };

  async function undoLast() {
    const last = applied.pop();
    screen.busy(`Undoing batch ${last.view.batchNum}…`);
    try {
      await revertBatch(gmail, account, last, learning);
    } catch (err) {
      applied.push(last);
      screen.toast('err', `Couldn't undo batch ${last.view.batchNum}: ${err.message}`);
      return;
    } finally {
      screen.idle();
    }
    syncSession();
    const c = last.counts;
    screen.toast('undo', `Undid batch ${last.view.batchNum}: unstarred ${c.star}, ${c.read} back to unread, ${c.spam} out of spam${c.filters ? `, ${c.filters} filter${c.filters > 1 ? 's' : ''} deleted` : ''}`);
    last.view.mode = 'list';
    redo.push(last.view);
  }

  const summaryView = () => {
    const sum = k => applied.reduce((n, a) => n + a.counts[k], 0);
    return {
      mode: 'summary', batchNum: pulled, items: [],
      summary: {
        emails: session.sorted,
        star: sum('star'), read: sum('read'), spam: sum('spam'), filters: sum('filters'), moved: sum('moved'), unread: sum('unread'),
        batches: applied.map(a => ({ num: a.view.batchNum, ...a.counts })).sort((a, b) => a.num - b.num),
        leftUnsorted: quit ? allRefs.length - session.sorted : 0,
      },
    };
  };

  for (;;) {
    let view = redo.pop();
    if (!view && !quit) {
      screen.show({ mode: 'loading', batchNum: pulled + 1, items: [] });
      const next = await pipeline.next();
      if (!next.done) {
        pulled++;
        view = tui.createView({
          batchNum: pulled,
          items: toItems(next.value, learning, account.id),
          warning: next.value.result.parseWarning ? PARSE_WARNING : null,
        });
      }
    }

    if (!view) {
      const outcome = await screen.wait(summaryView());
      if (outcome.type === 'undo') { await undoLast(); continue; }
      break;
    }

    const outcome = await screen.wait(view);
    if (outcome.type === 'quit') {
      quit = true;
      redo.length = 0;
    } else if (outcome.type === 'undo') {
      redo.push(view);
      await undoLast();
    } else if (outcome.type === 'apply') {
      screen.busy(`Applying batch ${view.batchNum} to Gmail…`);
      try {
        const rec = await applyBatch(gmail, account, view, learning, outcome.skipFilters);
        applied.push(rec);
        syncSession();
        screen.toast(rec.failures.length ? 'warn' : 'ok', applyMessage(rec));
      } catch (err) {
        screen.toast('err', `Couldn't apply batch ${view.batchNum}: ${err.message}`);
        redo.push(view);
      } finally {
        screen.idle();
      }
    }
  }

  return summaryView().summary;
}

// ─── Main ──────────────────────────────────────────────────────────────────

// Is the local model reachable and pulled? Checked up front so the overview can say so before
// you pick "Review by batch", instead of failing a batch later.
async function checkOllama() {
  const model = { name: QWEN_MODEL, state: 'offline' };
  try {
    const res = await fetch(OLLAMA_URL.replace('/api/chat', '/api/tags'), { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return model;
    const { models = [] } = await res.json();
    const names = new Set(models.flatMap(m => [m.name, m.model]));
    model.state = names.has(QWEN_MODEL) || names.has(`${QWEN_MODEL}:latest`) ? 'ready' : 'missing';
  } catch { /* not running */ }
  return model;
}

function accountsView(accounts, learning) {
  return {
    mode: 'accounts', cur: 0,
    accounts: accounts.map(a => {
      const acc = learning[a.id] ?? {};
      const senders = ['neutral', 'important', 'spam'].flatMap(k => Object.values(acc[k] ?? {}));
      return {
        name: a.name, email: a.email, tokenFile: a.tokenFile,
        signedIn: existsSync(path.join(process.cwd(), a.tokenFile)),
        senders: senders.length,
        filters: senders.filter(s => s.filterId).length,
      };
    }),
  };
}

function overviewView(account, unread, model) {
  const batches = Math.ceil(unread / BATCH_SIZE);
  const notReady = model.state === 'offline'
    ? 'Needs Ollama. Run `ollama serve`, then come back to this inbox.'
    : model.state === 'missing' ? `Needs the model. Run \`ollama pull ${model.name}\`.` : null;
  const options = unread
    ? [
      { key: 'review', label: 'Review by batch', desc: 'The hat sorts each batch. You confirm every change before it reaches Gmail.', disabled: notReady },
      { key: 'markAll', label: 'Mark all as read', desc: `Marks all ${unread} read without sorting. This can't be undone from here.` },
      { key: 'skip', label: 'Skip this inbox', desc: 'Leave everything as it is.' },
    ]
    : [{ key: 'skip', label: 'Continue', desc: 'Nothing to sort in this inbox.' }];
  return { mode: 'start', title: 'Inbox overview', unread, batches, batchSize: BATCH_SIZE, options, cur: notReady && unread ? 1 : 0 };
}

async function markAllRead(screen, gmail, account, refs) {
  const view = {
    mode: 'steps', title: 'Mark all as read',
    steps: [{ state: 'active', text: `Marking ${refs.length} emails as read…` }],
    progress: { done: 0, total: refs.length },
  };
  screen.show(view);
  const ids = refs.map(r => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    await batchModify(gmail, ids.slice(i, i + 500), { remove: ['UNREAD'] });
    view.progress.done = Math.min(i + 500, ids.length);
    screen.draw();
  }
  view.steps[0] = { state: 'done', text: `Marked ${ids.length} emails as read` };
  view.continue = true;
  await screen.wait(view);
}

async function runAccount(screen, account) {
  screen.bgState = { inFlight: new Set() };
  screen.session = { account, model: screen.session.model };
  const steps = [
    { state: 'active', text: `Signing in to ${account.email}…` },
    { state: 'todo', text: 'Count unread mail' },
  ];
  const view = { mode: 'steps', title: 'Opening inbox', steps };
  screen.show(view);

  const auth = await authorize(account, {
    onBrowser(url, port) {
      steps[0].text = 'Waiting for you to sign in to Google in your browser…';
      steps[0].detail = `Listening on localhost:${port}. Press E if the page didn't open.`;
      view.url = url;
      screen.draw();
    },
  });
  delete view.url;
  steps[0] = { state: 'done', text: `Signed in as ${account.email}` };
  steps[1] = { state: 'active', text: 'Counting unread mail…' };
  screen.draw();

  const gmail = google.gmail({ version: 'v1', auth });
  const [refs, model] = await Promise.all([getAllMessageRefs(gmail), checkOllama()]);
  screen.session.model = model;

  const choice = await screen.wait(overviewView(account, refs.length, model));
  if (choice.type === 'quit') return { account, kind: 'skipped', unread: refs.length, quit: true };
  if (choice.type === 'skip') return { account, kind: refs.length ? 'skipped' : 'empty', unread: refs.length };
  if (choice.type === 'markAll') {
    await markAllRead(screen, gmail, account, refs);
    return { account, kind: 'markAll', count: refs.length };
  }
  const summary = await reviewBatches(screen, gmail, account, refs, Math.ceil(refs.length / BATCH_SIZE));
  return { account, kind: 'review', summary, unread: refs.length };
}

// One line per inbox, printed after the full-screen UI closes so the run stays in scrollback.
function printResults(results) {
  if (!results.length) return;
  console.log(`\n  ${A.bold}${A.bYellow}the-sorting-hat${R}`);
  const nameW = Math.max(...results.map(r => r.account.name.length));
  for (const r of results) {
    const name = r.account.name.padEnd(nameW);
    if (r.kind === 'review') {
      const s = r.summary;
      const left = r.unread - s.emails;
      console.log(`  ${clr.ok('✓')} ${A.bold}${name}${R}  sorted ${s.emails}: ${s.star} starred, ${s.read} read, ${s.spam} to spam, ${s.filters} new filter${s.filters === 1 ? '' : 's'}${left ? clr.dim(` · ${left} left unread`) : ''}`);
    } else if (r.kind === 'markAll') {
      console.log(`  ${clr.ok('✓')} ${A.bold}${name}${R}  marked ${r.count} as read`);
    } else if (r.kind === 'empty') {
      console.log(`  ${clr.ok('✓')} ${A.bold}${name}${R}  ${clr.dim('nothing unread')}`);
    } else {
      console.log(`  ${clr.dim('·')} ${A.bold}${name}${R}  ${clr.dim(`skipped, ${r.unread} unread left`)}`);
    }
  }
  console.log('');
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`${clr.err('!')} the-sorting-hat needs an interactive terminal.`);
    return;
  }
  const accounts = await loadAccounts();
  const [learning, model] = await Promise.all([loadLearning(), checkOllama()]);
  const screen = new tui.Screen({
    session: { model },
    onAction(outcome) {
      if (outcome.type === 'reopen') openUrl(outcome.url);
      if (outcome.type === 'open') {
        openUrl(gmailLink(screen.session.account, outcome.id));
        screen.toast('ok', 'Opened in Gmail.');
      }
    },
  });

  const results = [];
  screen.open();
  try {
    const picked = await screen.wait(accountsView(accounts, learning));
    if (picked.type === 'pick') {
      const selected = picked.index >= accounts.length ? accounts : [accounts[picked.index]];
      for (const account of selected) {
        const result = await runAccount(screen, account);
        results.push(result);
        if (result.quit) break;
      }
    }
  } finally {
    screen.close();
  }
  printResults(results);
}

if (require.main === module) {
  main().then(() => process.exit(0), err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { authorize, loadAccounts, loadLearning, analyzeWithQwen, isJobEmail, isProtectedJobSender, toItems, applyBatch, revertBatch, QWEN_MODEL };
