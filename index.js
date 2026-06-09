const { google } = require('googleapis');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { Select, MultiSelect, Confirm } = require('enquirer');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const ACCOUNTS_PATH = path.join(process.cwd(), 'accounts.json');
const LEARNING_PATH = path.join(process.cwd(), 'learning.json');
const PORT = 3000;
const FILTER_THRESHOLD = 3;
const BATCH_SIZE = 15;
const LOOKAHEAD = 2;

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const QWEN_MODEL = 'qwen2.5-coder:14b';

// ─── Colors ────────────────────────────────────────────────────────────────

const A = {
  reset:   '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red:     '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  bGreen:  '\x1b[92m', bYellow: '\x1b[93m', bCyan:  '\x1b[96m',
};
const R = A.reset;
const clr = {
  imp:  s => `${A.bold}${A.bYellow}${s}${R}`,
  neu:  s => `${A.cyan}${s}${R}`,
  jnk:  s => `${A.dim}${A.red}${s}${R}`,
  ok:   s => `${A.bGreen}${s}${R}`,
  warn: s => `${A.yellow}${s}${R}`,
  err:  s => `${A.red}${s}${R}`,
  dim:  s => `${A.dim}${s}${R}`,
  bold: s => `${A.bold}${s}${R}`,
  sep:  s => `${A.dim}${A.cyan}${s}${R}`,
};
const trunc = (s, n) => s && s.length > n ? s.slice(0, n - 1) + '…' : (s || '');

// ─── UI helpers ────────────────────────────────────────────────────────────

function startSpinner(msg) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  process.stdout.write(`  ${A.dim}${frames[0]} ${msg}${R}`);
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${A.dim}${frames[++i % frames.length]} ${msg}${R}`);
  }, 80);
  return (finalMsg) => {
    clearInterval(timer);
    process.stdout.write(`\r${' '.repeat(msg.length + 24)}\r`);
    if (finalMsg) process.stdout.write(`  ${finalMsg}\n`);
  };
}

function banner() {
  const inner = 60;
  const hr = '─'.repeat(inner);
  const blank = ' '.repeat(inner);
  const title = '✉  Gmail Triage';
  const pad = inner - 2 - title.length;
  console.log(clr.sep(`╭${hr}╮`));
  console.log(`${clr.sep('│')}${blank}${clr.sep('│')}`);
  console.log(`${clr.sep('│')}  ${A.bold}${A.bCyan}${title}${R}${' '.repeat(pad)}${clr.sep('│')}`);
  console.log(`${clr.sep('│')}${blank}${clr.sep('│')}`);
  console.log(`${clr.sep(`╰${hr}╯`)}\n`);
}

function progressBar(done, total) {
  const pct = Math.floor(done / total * 100);
  const barW = 24;
  const filled = Math.round(done / total * barW);
  const bar = `${A.bGreen}${'█'.repeat(filled)}${R}${A.dim}${'░'.repeat(barW - filled)}${R}`;
  return `${bar}  ${A.bold}${done}${R}${A.dim}/${total}${R}  ${A.dim}${pct}%${R}`;
}

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

async function selectAccounts(accounts) {
  const ALL = 'All accounts';
  const map = new Map(accounts.map(a => [`${a.name} — ${a.email}`, a]));
  const choices = [...map.keys(), ALL];
  const answer = await new Select({ message: 'Select account', choices }).run().catch(() => process.exit(0));
  if (answer === ALL) return accounts;
  return [map.get(answer) ?? accounts[0]];
}

async function authorize(account) {
  const keys = await loadKeys(account.credentialsFile);
  const tokenPath = path.join(process.cwd(), account.tokenFile);
  const client = new google.auth.OAuth2(keys.client_id, keys.client_secret, `http://localhost:${PORT}`);

  try {
    client.setCredentials(JSON.parse(await fs.readFile(tokenPath, 'utf8')));
    await client.getAccessToken();
    return client;
  } catch { /* need new auth */ }

  console.log(`\nAuthorizing ${account.name} (${account.email})...`);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
        if (!code) { res.end('Missing code.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Authorization successful! You can close this tab.</h2>');
        server.close();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
        console.log(`Token saved for ${account.name}.\n`);
        resolve(client);
      } catch (err) { server.close(); reject(err); }
    });
    server.listen(PORT, () => {
      const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', login_hint: account.email });
      exec(`start "" "${url}"`);
    });
  });
}

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

async function markAsRead(gmail, id) {
  await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } });
}

async function markAsSpam(gmail, id) {
  await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } });
}

async function starAndMarkImportant(gmail, id) {
  await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: ['STARRED', 'IMPORTANT'] } });
}

async function createReadFilter(gmail, senderEmail) {
  const res = await gmail.users.settings.filters.create({
    userId: 'me',
    requestBody: { criteria: { from: senderEmail }, action: { removeLabelIds: ['UNREAD'] } },
  });
  return res.data.id;
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

async function recordAndMaybeFilter(gmail, accountId, emails, learning) {
  ensureAccount(learning, accountId);
  const senders = learning[accountId].neutral;
  for (const email of emails) {
    const sender = extractEmail(email.from);
    if (!senders[sender]) senders[sender] = { count: 0, filterId: null };
    senders[sender].count++;
    if (senders[sender].count >= FILTER_THRESHOLD && !senders[sender].filterId) {
      try {
        senders[sender].filterId = await createReadFilter(gmail, sender);
        console.log(`    ${clr.warn('⚡')} Filter created for ${A.dim}${sender}${R} — future emails marked read`);
      } catch (err) {
        console.log(`    ${clr.err('!')} Could not create filter for ${sender}: ${err.message}`);
      }
    }
  }
}

async function recordAndMaybeFilterImportant(gmail, accountId, emails, learning) {
  ensureAccount(learning, accountId);
  const senders = learning[accountId].important;
  for (const email of emails) {
    const sender = extractEmail(email.from);
    if (!senders[sender]) senders[sender] = { count: 0, filterId: null };
    senders[sender].count++;
    if (senders[sender].count >= FILTER_THRESHOLD && !senders[sender].filterId) {
      try {
        const res = await gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: { criteria: { from: sender }, action: { addLabelIds: ['IMPORTANT'] } },
        });
        senders[sender].filterId = res.data.id;
        console.log(`    ${clr.warn('⚡')} Filter created for ${A.dim}${sender}${R} — future emails marked important`);
      } catch (err) {
        console.log(`    ${clr.err('!')} Could not create important filter for ${sender}: ${err.message}`);
      }
    }
  }
}

async function recordAndMaybeFilterSpam(gmail, accountId, emails, learning) {
  ensureAccount(learning, accountId);
  const senders = learning[accountId].spam;
  for (const email of emails) {
    const sender = extractEmail(email.from);
    if (!senders[sender]) senders[sender] = { count: 0, filterId: null };
    senders[sender].count++;
    if (senders[sender].count >= FILTER_THRESHOLD && !senders[sender].filterId) {
      try {
        const res = await gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: { criteria: { from: sender }, action: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] } },
        });
        senders[sender].filterId = res.data.id;
        console.log(`    ${clr.warn('⚡')} Filter created for ${A.dim}${sender}${R} — future emails go to spam`);
      } catch (err) {
        console.log(`    ${clr.err('!')} Could not create spam filter for ${sender}: ${err.message}`);
      }
    }
  }
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

NEVER mark as important: financial offers ("pre-selected", "you've been chosen", "earn more"), credit card applications, promotional reminders from banks or retailers, routine monthly statements, or any email from a no-reply address unless it is a security alert or confirmed booking.

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
  const toAnalyze = emails.filter(e => !e.labelIds.includes('STARRED') && !e.labelIds.includes('IMPORTANT'));
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

// ─── Display & interaction per batch ───────────────────────────────────────

function renderHeader(account, batchNum, totalBatches, bgState, parseWarning) {
  console.clear();
  const hr = clr.sep('━'.repeat(60));
  console.log(hr);
  const nums = [...bgState.inFlight].sort((a, b) => a - b);
  const spinPart = nums.length > 0
    ? `  ${A.dim}⧗ analyzing ${nums.length === 1 ? nums[0] : `${nums[0]}–${nums[nums.length - 1]}`}${R}`
    : '';
  console.log(`  ${A.bold}${account.name}${R}  ${A.dim}·${R}  Batch ${A.cyan}${batchNum}${R}${A.dim}/${totalBatches}${R}${spinPart}`);
  if (parseWarning) console.log(`  ${clr.warn('! LLM parse failed — see llm-debug.log')}`);
  console.log(hr);
}

function startHeaderSpinner(account, batchNum, totalBatches, bgState) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let fi = 0;
  const timer = setInterval(() => {
    const nums = [...bgState.inFlight].sort((a, b) => a - b);
    if (nums.length === 0) return;
    const range = nums.length === 1 ? `${nums[0]}` : `${nums[0]}–${nums[nums.length - 1]}`;
    const line = `  ${A.bold}${account.name}${R}  ${A.dim}·${R}  Batch ${A.cyan}${batchNum}${R}${A.dim}/${totalBatches}${R}  ${A.dim}${frames[++fi % frames.length]} analyzing ${range}${R}`;
    process.stdout.write('\x1B7');
    process.stdout.write('\x1B[2;1H');
    process.stdout.write(line + ' '.repeat(10));
    process.stdout.write('\x1B8');
  }, 80);
  return () => clearInterval(timer);
}

async function handleBatch(gmail, batch, batchNum, totalBatches, account, learning, bgState) {
  const { emails, result } = batch;
  const by = { important: [], neutral: [], junk: [] };

  for (const item of result.emails) {
    const email = emails[item.index - 1];
    if (!email) continue;
    const cat = item.category in by ? item.category : 'neutral';
    by[cat].push({ ...email, reason: item.reason });
  }

  const hdr = () => renderHeader(account, batchNum, totalBatches, bgState, result.parseWarning);

  const showImportant = () => {
    if (by.important.length === 0) return;
    console.log(`\n  ${clr.imp('★ IMPORTANT')}  ${clr.dim(`(${by.important.length})`)}`);
    console.log(`  ${clr.sep('─'.repeat(56))}`);
    by.important.forEach((e, i) => {
      const subj = trunc(e.subject, 52);
      const from = trunc(e.from.replace(/<[^>]*>/g, '').trim(), 40);
      console.log(`    ${clr.dim(`[${i + 1}]`)} ${A.bold}${subj}${R}`);
      console.log(`        ${clr.dim(from)}${e.reason ? `  ${clr.dim('·')}  ${clr.dim(e.reason)}` : ''}`);
    });
  };

  const showNeutral = () => {
    if (by.neutral.length === 0) return;
    console.log(`\n  ${clr.neu('· NEUTRAL')}  ${clr.dim(`(${by.neutral.length})`)}`);
    console.log(`  ${clr.sep('─'.repeat(56))}`);
    by.neutral.forEach((e, i) => {
      const subj = trunc(e.subject, 40);
      const from = trunc(e.from.replace(/<[^>]*>/g, '').trim(), 25);
      console.log(`    ${clr.dim(`[${i + 1}]`)} ${subj}  ${clr.dim(from)}`);
    });
  };

  const showJunk = () => {
    if (by.junk.length === 0) return;
    console.log(`\n  ${clr.jnk('✗ JUNK')}  ${clr.dim(`(${by.junk.length})`)}`);
    console.log(`  ${clr.sep('─'.repeat(56))}`);
    by.junk.forEach((e, i) => {
      const subj = trunc(e.subject, 40);
      const from = trunc(e.from.replace(/<[^>]*>/g, '').trim(), 25);
      console.log(`    ${clr.dim(`[${i + 1}] ${subj}  ${from}`)}`);
    });
  };

  hdr();
  showImportant();
  showNeutral();
  showJunk();
  console.log('');

  const emailChoices = list => list.map((e, i) => {
    const subj = trunc(e.subject, 40);
    const from = trunc(e.from.replace(/<[^>]*>/g, '').trim(), 25);
    return `[${i + 1}] ${subj}  ·  ${from}`;
  });
  const choiceIdx = s => { const m = s.match(/^\[(\d+)\]/); return m ? parseInt(m[1]) - 1 : -1; };

  // ── Important: demote any to neutral, star+mark the rest ─────────────────
  if (by.important.length > 0) {
    const choices = emailChoices(by.important);
    let moved = [];
    const stop = startHeaderSpinner(account, batchNum, totalBatches, bgState);
    try { moved = await new MultiSelect({ message: 'Move any important → neutral?', choices, hint: '(space to toggle, enter to confirm)' }).run(); } catch {}
    stop();
    if (moved.length > 0) {
      const idx = new Set(moved.map(choiceIdx).filter(i => i >= 0));
      const demoted = by.important.filter((_, i) => idx.has(i));
      by.neutral.push(...demoted);
      by.important = by.important.filter((_, i) => !idx.has(i));
      await recordAndMaybeFilter(gmail, account.id, demoted, learning);
      await saveLearning(learning);
    }
    if (by.important.length > 0) {
      for (const e of by.important) await starAndMarkImportant(gmail, e.id);
      console.log(`  ${clr.ok('✓')} Starred ${clr.imp('★')} and marked ${by.important.length} as important`);
      const readChoices = emailChoices(by.important);
      let toRead = [];
      const stopR = startHeaderSpinner(account, batchNum, totalBatches, bgState);
      try { toRead = await new MultiSelect({ message: 'Mark any important as read?', choices: readChoices, hint: '(space to toggle, enter to confirm)' }).run(); } catch {}
      stopR();
      if (toRead.length > 0) {
        const idx = new Set(toRead.map(choiceIdx).filter(i => i >= 0));
        for (const e of by.important.filter((_, i) => idx.has(i))) await markAsRead(gmail, e.id);
        console.log(`  ${clr.ok('✓')} Marked ${toRead.length} important as read`);
      }
    }
  }

  // ── Neutral: promote any to important, mark rest as read ──────────────────
  if (by.neutral.length > 0) {
    hdr();
    showNeutral();
    console.log('');
    const nChoices = emailChoices(by.neutral);
    let promoted = [];
    const stop2 = startHeaderSpinner(account, batchNum, totalBatches, bgState);
    try { promoted = await new MultiSelect({ message: 'Move any neutral → important?', choices: nChoices, hint: '(space to toggle, enter to confirm)' }).run(); } catch {}
    stop2();
    if (promoted.length > 0) {
      const idx = new Set(promoted.map(choiceIdx).filter(i => i >= 0));
      const promoted_emails = by.neutral.filter((_, i) => idx.has(i));
      by.neutral = by.neutral.filter((_, i) => !idx.has(i));
      for (const e of promoted_emails) await starAndMarkImportant(gmail, e.id);
      await recordAndMaybeFilterImportant(gmail, account.id, promoted_emails, learning);
      await saveLearning(learning);
      console.log(`  ${clr.ok('✓')} Starred ${clr.imp('★')} and marked ${promoted_emails.length} as important`);
    }
    if (by.neutral.length > 0) {
      let doMark = false;
      const stop3 = startHeaderSpinner(account, batchNum, totalBatches, bgState);
      try { doMark = await new Confirm({ message: `Mark ${by.neutral.length} neutral as read?`, initial: true }).run(); } catch {}
      stop3();
      if (doMark) {
        for (const e of by.neutral) await markAsRead(gmail, e.id);
        await recordAndMaybeFilter(gmail, account.id, by.neutral, learning);
        await saveLearning(learning);
        console.log(`  ${clr.ok('✓')} Marked ${by.neutral.length} neutral as read`);
      }
    }
  }

  // ── Junk: rescue any (stays unread), spam the rest ────────────────────────
  if (by.junk.length > 0) {
    hdr();
    showJunk();
    console.log('');
    const jChoices = emailChoices(by.junk);
    let rescued = [];
    const stop4 = startHeaderSpinner(account, batchNum, totalBatches, bgState);
    try { rescued = await new MultiSelect({ message: 'Rescue any from junk?', choices: jChoices, hint: '(space to toggle, enter to confirm)' }).run(); } catch {}
    stop4();
    if (rescued.length > 0) {
      const idx = new Set(rescued.map(choiceIdx).filter(i => i >= 0));
      by.junk = by.junk.filter((_, i) => !idx.has(i));
      console.log(`  ${clr.dim('→')} Rescued ${rescued.length} (left unread in inbox)`);
    }
    if (by.junk.length > 0) {
      let doSpam = false;
      const stop5 = startHeaderSpinner(account, batchNum, totalBatches, bgState);
      try { doSpam = await new Confirm({ message: `Move ${by.junk.length} junk to spam?`, initial: true }).run(); } catch {}
      stop5();
      if (doSpam) {
        for (const e of by.junk) await markAsSpam(gmail, e.id);
        await recordAndMaybeFilterSpam(gmail, account.id, by.junk, learning);
        await saveLearning(learning);
        console.log(`  ${clr.ok('✓')} Moved ${by.junk.length} to spam`);
      }
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function processAccount(account) {
  const auth = await authorize(account);
  const gmail = google.gmail({ version: 'v1', auth });

  console.log(`\n${clr.sep('─'.repeat(60))}`);
  console.log(`  ${A.bold}${account.name}${R}  ${clr.dim(account.email)}`);

  let stopSpin = startSpinner('Loading message list...');
  const allRefs = await getAllMessageRefs(gmail);
  stopSpin();

  if (allRefs.length === 0) { console.log(`  ${clr.dim('No unread messages.')}`); return; }

  const totalBatches = Math.ceil(allRefs.length / BATCH_SIZE);
  console.log(`  ${A.cyan}${allRefs.length}${R} unread  ${clr.dim('·')}  ${totalBatches} batch${totalBatches > 1 ? 'es' : ''} of ${BATCH_SIZE}`);

  const MARK_ALL = 'Mark all as read';
  const SKIP = 'Skip';
  const action = await new Select({
    message: 'What would you like to do?',
    choices: ['Review by batch', MARK_ALL, SKIP],
  }).run().catch(() => SKIP);

  if (action === SKIP) return;

  if (action === MARK_ALL) {
    const markWithRetry = async (id) => {
      for (let attempt = 0; ; attempt++) {
        try { return await markAsRead(gmail, id); }
        catch (err) {
          if (err.status === 429 && attempt < 5) await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
          else throw err;
        }
      }
    };
    let done = 0;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let fi = 0;
    const printProgress = () => {
      const bar = progressBar(done, allRefs.length);
      process.stdout.write(`\r  ${A.dim}${frames[fi++ % frames.length]}${R} ${bar}   `);
    };
    printProgress();
    const timer = setInterval(printProgress, 80);
    for (let i = 0; i < allRefs.length; i += 5) {
      await Promise.all(allRefs.slice(i, i + 5).map(ref => markWithRetry(ref.id)));
      done = Math.min(i + 5, allRefs.length);
    }
    clearInterval(timer);
    process.stdout.write(`\r  ${clr.ok('✓')} Marked ${A.bold}${allRefs.length}${R} as read${' '.repeat(50)}\n`);
    return;
  }

  const learning = await loadLearning();
  const bgState = { inFlight: new Set() };
  const pipeline = batchPipeline(gmail, allRefs, bgState);

  let batchNum = 0;
  let next = pipeline.next();

  for (;;) {
    stopSpin = startSpinner(`Batch ${batchNum + 1}/${totalBatches} — fetching & analyzing...`);
    const { value: batch, done } = await next;
    stopSpin();
    if (done) break;

    batchNum++;
    next = pipeline.next();

    await handleBatch(gmail, batch, batchNum, totalBatches, account, learning, bgState);
  }
}

async function main() {
  console.clear();
  banner();
  const accounts = await loadAccounts();
  const selected = await selectAccounts(accounts);

  for (const account of selected) {
    await processAccount(account);
    if (selected.length > 1) console.log(`\n${clr.sep('═'.repeat(60))}`);
  }

  console.log(`\n  ${clr.ok('✓')} All done\n`);
}

main().catch(console.error).finally(() => process.exit(0));
