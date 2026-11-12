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

// Returns the outline as plain text, or '' if the course has no published modules.
async function fetchCourseOutline(origin, canvasCourseId) {
  const id = encodeURIComponent(canvasCourseId);
  const base = `/api/v1/courses/${id}`;

  const [courseRes, modules, assignments, quizzes] = await Promise.all([
    canvasGet(origin, new URL(base, origin).toString()).then((r) => r.json()),
    getAll(origin, `${base}/modules`, [['include[]', 'items'], ['include[]', 'content_details']]),
    getAll(origin, `${base}/assignments`).catch(() => []),
    // Courses with Classic Quizzes turned off return 404 here; that's fine.
    getAll(origin, `${base}/quizzes`).catch(() => []),
  ]);
  const timeZone = courseRes.time_zone;
  const assignmentById = new Map(assignments.map((a) => [String(a.id), a]));
  const quizById = new Map(quizzes.map((q) => [String(q.id), q]));

  const lines = [];
  for (const mod of modules) {
    // The service account can see unpublished content; students can't.
    if (mod.published === false) continue;
    let items = mod.items;
    // Canvas leaves out `items` for very large modules; fetch them separately.
    if (!items && mod.items_url) {
      items = await getAll(origin, new URL(mod.items_url).pathname, [['include[]', 'content_details']]).catch(() => []);
    }

    // Teachers usually number modules in the name ("Module 3: Fractions"),
    // so use the name as-is rather than adding our own numbering.
    lines.push(`Module: ${oneLine(mod.name)}`);
    for (const item of items || []) {
      if (item.published === false) continue;
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

module.exports = { isConfigured, resolveApiBase, fetchCourseOutline, htmlToText };
