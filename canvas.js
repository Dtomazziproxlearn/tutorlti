// Reads a course's module outline from the Canvas REST API, so the tutor
// knows what's in "Module 1" vs "Module 3" without the student explaining.
//
// LTI launches can't call the Canvas REST API on their own, so this uses an
// API access token from a dedicated Canvas service account (see README).
// The token is only ever sent to the Canvas host it's configured for.
//
// Config (either form):
//   CANVAS_API_BASE_URL=https://district.instructure.com
//   CANVAS_API_TOKEN=...
// or, for several Canvas instances:
//   CANVAS_API_TOKENS=https://a.instructure.com=token1,https://b.instructure.com=token2

const MAX_DESCRIPTION_CHARS = 300;
const MAX_OUTLINE_CHARS = Number(process.env.CANVAS_OUTLINE_MAX_CHARS) || 15000;
const MAX_PAGES = 20; // per list endpoint, 100 items per page
const REQUEST_TIMEOUT_MS = 10000;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Map of Canvas origin -> API token.
const tokens = new Map();
for (const pair of String(process.env.CANVAS_API_TOKENS || '').split(',')) {
  const i = pair.lastIndexOf('=');
  if (i <= 0) continue;
  const origin = originOf(pair.slice(0, i).trim());
  const token = pair.slice(i + 1).trim();
  if (origin && token) tokens.set(origin, token);
}
if (process.env.CANVAS_API_TOKEN && originOf(process.env.CANVAS_API_BASE_URL)) {
  tokens.set(originOf(process.env.CANVAS_API_BASE_URL), process.env.CANVAS_API_TOKEN.trim());
}

const isConfigured = () => tokens.size > 0;

// Picks the Canvas origin to call for a launch. Uses the API URL Canvas sent
// in the launch when we have a token for it. If the launch didn't include one
// (Developer Key not updated yet) and only one Canvas is configured, use that.
function resolveApiBase(launchApiBase) {
  const origin = originOf(launchApiBase);
  if (origin) return tokens.has(origin) ? origin : null;
  return tokens.size === 1 ? [...tokens.keys()][0] : null;
}

async function canvasGet(origin, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.get(origin)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`Canvas API ${res.status} for ${new URL(url).pathname}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Follows Canvas's Link-header pagination. Never follows a link off-host.
async function getAll(origin, path, params = []) {
  const url = new URL(path, origin);
  url.searchParams.set('per_page', '100');
  for (const [k, v] of params) url.searchParams.append(k, v);
  const out = [];
  let next = url.toString();
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await canvasGet(origin, next);
    out.push(...(await res.json()));
    const m = (res.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
    next = m && originOf(m[1]) === origin ? m[1] : null;
  }
  return out;
}

// Assignment/quiz descriptions are HTML. Reduce to one line of plain text.
function htmlToText(html, max) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
}

const oneLine = (s, max = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function formatDue(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone: timeZone || 'UTC' });
  } catch {
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
  }
}

const TYPE_LABELS = {
  Page: 'Page',
  Assignment: 'Assignment',
  Quiz: 'Quiz',
  Discussion: 'Discussion',
  File: 'File',
  ExternalUrl: 'Link',
  ExternalTool: 'Activity',
};

// ---------- Shared, cached reads ----------
// Module structure and item content are cached in memory per course, so a
// class asking about the same module triggers one set of Canvas requests.

const CACHE_TTL_MS = (Number(process.env.CANVAS_OUTLINE_TTL_MINUTES) || 60) * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const cache = new Map(); // key -> { at, promise }

// Caches the promise, so simultaneous requests share one Canvas call.
function cached(key, load, { refresh = false } = {}) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return promise;
}

const coursePath = (canvasCourseId) => `/api/v1/courses/${encodeURIComponent(canvasCourseId)}`;

async function getJson(origin, path) {
  return (await canvasGet(origin, new URL(path, origin).toString())).json();
}

function getCourseInfo(origin, canvasCourseId, opts) {
  return cached(`${origin}|${canvasCourseId}|course`, () => getJson(origin, coursePath(canvasCourseId)), opts);
}

// Published modules with their published items, in course order.
function getPublishedModules(origin, canvasCourseId, opts) {
  return cached(
    `${origin}|${canvasCourseId}|modules`,
    async () => {
      const modules = await getAll(origin, `${coursePath(canvasCourseId)}/modules`, [
        ['include[]', 'items'],
        ['include[]', 'content_details'],
      ]);
      const out = [];
      for (const mod of modules) {
        // The service account can see unpublished content; students can't.
        if (mod.published === false) continue;
        let items = mod.items;
        // Canvas leaves out `items` for very large modules; fetch them separately.
        if (!items && mod.items_url) {
          items = await getAll(origin, new URL(mod.items_url).pathname, [['include[]', 'content_details']]).catch(() => []);
        }
        out.push({ name: mod.name, items: (items || []).filter((i) => i.published !== false) });
      }
      return out;
    },
    opts
  );
}

// ---------- Module outline (added to the system prompt) ----------

// Returns the outline as plain text, or '' if the course has no published modules.
async function fetchCourseOutline(origin, canvasCourseId) {
  const base = coursePath(canvasCourseId);
  const fresh = { refresh: true };
  const [course, modules, assignments, quizzes] = await Promise.all([
    getCourseInfo(origin, canvasCourseId, fresh),
    getPublishedModules(origin, canvasCourseId, fresh),
    getAll(origin, `${base}/assignments`).catch(() => []),
    // Courses with Classic Quizzes turned off return 404 here; that's fine.
    getAll(origin, `${base}/quizzes`).catch(() => []),
  ]);
  const timeZone = course.time_zone;
  const assignmentById = new Map(assignments.map((a) => [String(a.id), a]));
  const quizById = new Map(quizzes.map((q) => [String(q.id), q]));

  const lines = [];
  for (const mod of modules) {
    // Teachers usually number modules in the name ("Module 3: Fractions"),
    // so use the name as-is rather than adding our own numbering.
    lines.push(`Module: ${oneLine(mod.name)}`);
    for (const item of mod.items) {
      if (item.type === 'SubHeader') {
        lines.push(`  ${oneLine(item.title)}:`);
        continue;
      }
      const label = TYPE_LABELS[item.type] || item.type;
      let line = `  - [${label}] ${oneLine(item.title)}`;

      const details = item.content_details || {};
      const source =
        item.type === 'Assignment' ? assignmentById.get(String(item.content_id))
        : item.type === 'Quiz' ? quizById.get(String(item.content_id))
        : null;
      if (source && source.published === false) continue;

      const due = formatDue(details.due_at || source?.due_at, timeZone);
      if (due) line += ` (due ${due})`;
      const description = htmlToText(source?.description, MAX_DESCRIPTION_CHARS);
      if (description) line += ` — ${description}`;
      lines.push(line);
    }
  }

  let outline = lines.join('\n');
  if (outline.length > MAX_OUTLINE_CHARS) {
    outline = outline.slice(0, MAX_OUTLINE_CHARS).replace(/\n[^\n]*$/, '') + '\n(outline cut short: the course has more content)';
  }
  return outline;
}

// ---------- Full content, fetched only when the tutor asks (tools) ----------

const MAX_ITEM_CHARS = 4000; // per item inside a module
const MAX_SINGLE_ITEM_CHARS = 8000; // get_page / get_assignment
const MAX_RESULT_CHARS = 12000; // whole tool result

// HTML to plain text that keeps paragraphs, list items and headings readable.
function htmlToBlockText(html, max) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + ' …(cut short)' : text;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Finds the best match for what the tutor asked for: exact name, then
// prefix/substring, then "Module 3"-style numbers.
function bestMatch(list, query, nameOf) {
  const q = norm(query);
  if (!q) return null;
  const names = list.map((x) => norm(nameOf(x)));
  let i = names.indexOf(q);
  // Whole words only, so "module 1" doesn't match "Module 10".
  const has = (a, b) => b && ` ${a} `.includes(` ${b} `);
  if (i < 0) i = names.findIndex((n) => has(n, q));
  if (i < 0) i = names.findIndex((n) => has(q, n));
  if (i < 0) {
    const m = q.match(/\b(module|unit|week|chapter|lesson|topic)\s*(\d+)\b/);
    if (m) i = names.findIndex((n) => new RegExp(`\\b${m[1]}\\s*0*${Number(m[2])}\\b`).test(n));
  }
  return i < 0 ? null : list[i];
}

// The text of one module item, or null if it's unpublished.
async function itemBody(origin, canvasCourseId, item, max) {
  const base = coursePath(canvasCourseId);
  const id = encodeURIComponent(item.content_id);
  const key = `${origin}|${canvasCourseId}|item|${item.type}|${item.content_id || item.page_url}`;
  const lines = [];
  switch (item.type) {
    case 'Page': {
      const p = await cached(key, () => getJson(origin, `${base}/pages/${encodeURIComponent(item.page_url)}`));
      if (p.published === false) return null;
      lines.push(htmlToBlockText(p.body, max) || '(This page is empty.)');
      break;
    }
    case 'Assignment': {
      const a = await cached(key, () => getJson(origin, `${base}/assignments/${id}`));
      if (a.published === false) return null;
      if (a.points_possible != null) lines.push(`Points: ${a.points_possible}`);
      if (a.submission_types?.length && a.submission_types[0] !== 'none') {
        lines.push(`Turn in as: ${a.submission_types.join(', ').replace(/_/g, ' ')}`);
      }
      lines.push(htmlToBlockText(a.description, max) || '(No instructions written.)');
      if (Array.isArray(a.rubric) && a.rubric.length) {
        lines.push('Rubric:');
        for (const c of a.rubric) {
          const detail = c.long_description ? `: ${oneLine(c.long_description, 300)}` : '';
          lines.push(`- ${oneLine(c.description)} (${c.points} pts)${detail}`);
        }
      }
      break;
    }
    case 'Quiz': {
      const q = await cached(key, () => getJson(origin, `${base}/quizzes/${id}`));
      if (q.published === false) return null;
      const facts = [
        q.question_count != null && `${q.question_count} questions`,
        q.points_possible != null && `${q.points_possible} points`,
        q.time_limit && `${q.time_limit}-minute time limit`,
        q.allowed_attempts > 0 && `${q.allowed_attempts} attempt(s)`,
      ].filter(Boolean);
      if (facts.length) lines.push(facts.join(', '));
      lines.push(htmlToBlockText(q.description, max) || '(No quiz instructions written.)');
      lines.push('(The quiz questions themselves are not available to the tutor.)');
      break;
    }
    case 'Discussion': {
      const d = await cached(key, () => getJson(origin, `${base}/discussion_topics/${id}`));
      if (d.published === false) return null;
      lines.push(htmlToBlockText(d.message, max) || '(No discussion prompt written.)');
      break;
    }
    case 'ExternalUrl':
      lines.push(`A link to ${oneLine(item.external_url, 300)}. The tutor can't open it.`);
      break;
    default:
      lines.push(`The tutor can't open this kind of item (${TYPE_LABELS[item.type] || item.type}). Ask the student what it says.`);
  }
  return lines.join('\n');
}

async function describeItem(origin, canvasCourseId, item, timeZone, max) {
  const label = TYPE_LABELS[item.type] || item.type;
  const due = formatDue(item.content_details?.due_at, timeZone);
  let body;
  try {
    body = await itemBody(origin, canvasCourseId, item, max);
  } catch (err) {
    body = `(Couldn't load this item from Canvas: ${err.status || err.message}.)`;
  }
  if (body === null) return null;
  return `### [${label}] ${oneLine(item.title)}${due ? ` (due ${due})` : ''}\n${body}`;
}

// Runs fn over items with at most `limit` Canvas requests at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function capResult(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS).replace(/\n[^\n]*$/, '') +
    '\n\n(Cut short: this module has more content than fits. Ask about a specific page or assignment for the rest.)'
  );
}

const nameList = (names) => names.map((n) => `"${oneLine(n)}"`).slice(0, 60).join(', ') || '(none)';

async function getModuleContent(origin, canvasCourseId, moduleName) {
  const [course, modules] = await Promise.all([getCourseInfo(origin, canvasCourseId), getPublishedModules(origin, canvasCourseId)]);
  const mod = bestMatch(modules, moduleName, (m) => m.name);
  if (!mod) {
    return `No published module matches "${oneLine(moduleName)}". Modules in this course: ${nameList(modules.map((m) => m.name))}.`;
  }

  const blocks = await mapLimit(mod.items, 4, (item) =>
    item.type === 'SubHeader'
      ? `## ${oneLine(item.title)}`
      : describeItem(origin, canvasCourseId, item, course.time_zone, MAX_ITEM_CHARS)
  );
  const parts = [`## Module: ${oneLine(mod.name)}`, ...blocks.filter(Boolean)];
  if (parts.length === 1) parts.push('(This module has no published items.)');
  return capResult(parts.join('\n\n'));
}

const ITEM_KINDS = {
  page: ['Page'],
  assignment: ['Assignment', 'Quiz', 'Discussion'],
};

// get_page / get_assignment: one item, found by title across published modules.
async function getItemContent(origin, canvasCourseId, kind, title) {
  const types = ITEM_KINDS[kind];
  const [course, modules] = await Promise.all([getCourseInfo(origin, canvasCourseId), getPublishedModules(origin, canvasCourseId)]);
  const items = modules.flatMap((m) =>
    m.items.filter((i) => types.includes(i.type)).map((i) => ({ ...i, moduleName: m.name }))
  );
  const item = bestMatch(items, title, (i) => i.title);
  if (!item) {
    return `No published ${kind} matches "${oneLine(title)}". Available: ${nameList(items.map((i) => i.title))}.`;
  }
  const text = await describeItem(origin, canvasCourseId, item, course.time_zone, MAX_SINGLE_ITEM_CHARS);
  if (text === null) return `"${oneLine(item.title)}" isn't published yet, so it isn't available.`;
  return capResult(`(In module "${oneLine(item.moduleName)}")\n${text}`);
}

module.exports = {
  isConfigured,
  resolveApiBase,
  fetchCourseOutline,
  getModuleContent,
  getItemContent,
  htmlToText,
  htmlToBlockText,
  bestMatch,
};
