require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const lti = require('./lti');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const RATE_LIMIT_PER_15_MIN = Number(process.env.RATE_LIMIT_PER_15_MIN) || 60;
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 8;
// A student who comes back within this many hours continues their last chat.
const RESUME_HOURS = Number(process.env.RESUME_HOURS) || 12;
// Delete conversations older than this many days. 0 = keep forever.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 0;
// Which sites may show the tutor in an iframe. Add your districts' custom
// Canvas domains here (space-separated), e.g. "https://canvas.district.org".
const FRAME_ANCESTORS =
  process.env.FRAME_ANCESTORS || 'https://*.instructure.com https://*.canvaslms.com';
const CLAUDE_MD_PATH = path.join(__dirname, 'CLAUDE.md');
const APP_TEMPLATE = fs.readFileSync(path.join(__dirname, 'views', 'app.html'), 'utf8');

// Limits so the tool can't be used to run up huge API bills.
const MAX_MESSAGES = 40; // per conversation, counting both sides
const MAX_MESSAGE_CHARS = 4000;

const app = express();
// Render sits behind a reverse proxy; trust it so we see real client IPs.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' })); // Canvas form_post

// Every page may be framed by Canvas, and only by Canvas.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  next();
});

// `index: false` so visiting the bare URL doesn't load the app without a launch.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Browser builds of the Markdown renderer and sanitizer, served from
// node_modules so they don't depend on a CDN a school network might block.
app.get('/vendor/marked.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js'))
);
app.get('/vendor/purify.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js'))
);

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/', (req, res) =>
  lti.errorPage(res, 200, lti.config.toolTitle, 'Open the tutor from the "Tutor" link in your Canvas course.')
);

// ---------- LTI endpoints ----------

// Generous per-IP limit on the launch endpoints. A whole classroom often
// shares one school IP address, so this is deliberately high.
const ltiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false });

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/lti/config.json', (req, res) => res.json(lti.canvasConfig()));
app.get('/lti/jwks', asyncRoute(async (req, res) => res.json({ keys: [await lti.getToolKey()] })));
app.all('/lti/login', ltiLimiter, asyncRoute(lti.handleLogin));

app.post(
  '/lti/launch',
  ltiLimiter,
  asyncRoute(async (req, res) => {
    let launch;
    try {
      launch = await lti.verifyLaunch(req.body);
    } catch (err) {
      console.warn('LTI launch rejected:', err.message);
      return lti.errorPage(res, 401, "We couldn't start the tutor", err.userMessage || 'Please reload the page in Canvas.');
    }

    const { id: userId, is_new: isNewUser } = await db.upsertUser(launch.user);
    let courseId = null;
    if (launch.course) {
      courseId = await db.upsertCourse(launch.course);
      await db.recordEnrollment(userId, courseId, launch.roles, launch.isInstructor);
    }
    const token = await db.createSession(userId, courseId, SESSION_HOURS);
    console.log(`LTI launch ok: user=${userId}${isNewUser ? ' (new)' : ''} course=${courseId} instructor=${launch.isInstructor}`);

    // The session token goes in the page itself, not a cookie: browsers
    // block third-party cookies inside the Canvas iframe. `<` is escaped so
    // nothing in the JSON can close the script tag.
    const boot = JSON.stringify({ token }).replace(/</g, '\\u003c');
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(APP_TEMPLATE.replace('__BOOT_JSON__', boot));
  })
);

// ---------- Auth for the chat API ----------

async function requireSession(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = token ? await db.getSession(token) : null;
    if (!session) {
      return res.status(401).json({ error: 'Your session has ended. Please reload the page in Canvas.', sessionExpired: true });
    }
    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}

// Rate limit per student rather than per IP, since a classroom shares an IP.
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: RATE_LIMIT_PER_15_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session.user_id}`,
  message: { error: "You're sending messages really fast! Take a short break and try again in a few minutes." },
});

// ---------- System prompt ----------

// Names and course titles come from Canvas, where users can sometimes edit
// their own display name. Keep only ordinary name characters so a name
// can't smuggle instructions into the system prompt.
function cleanForPrompt(value, max) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^\p{L}\p{M}\p{N} '\-.&:,()]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned || null;
}

function firstNameOf(session) {
  return cleanForPrompt(session.given_name || (session.name || '').split(' ')[0], 40);
}

// Read CLAUDE.md fresh on every request, so edits take effect without a restart.
function getSystemPrompt(session) {
  let base;
  try {
    base = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  } catch (err) {
    console.error('Could not read CLAUDE.md:', err.message);
    base = 'You are a helpful assistant.';
  }

  const firstName = firstNameOf(session);
  const course = cleanForPrompt(session.course_title, 100);
  const lines = ['', '## Student context (provided by Canvas, not typed by the student)'];
  if (firstName) {
    lines.push(
      `- The student's first name is ${firstName}. Greet them by first name at the start of a conversation and use it now and then, naturally. Use only their first name. This doesn't change the rule about never asking for personal information.`
    );
  }
  if (course) {
    lines.push(`- They opened the tutor from the Canvas course "${course}". Treat it as a hint about the subject they may need help with.`);
  }
  if (session.is_instructor) {
    lines.push('- This user is a teacher previewing the tutor. Respond exactly as you would to a student.');
  }
  return lines.length > 2 ? `${base}\n${lines.join('\n')}\n` : base;
}

// ---------- Safety classification (unchanged logic) ----------

const CLASSIFIER_SYSTEM_PROMPT = `You are a safety classifier reviewing a single message from a student (grades 1-8, roughly ages 6-14) sent to a homework-help chatbot.

Decide whether the message raises concern about: self-harm or suicide, abuse, bullying, or otherwise being unsafe. Lean toward flagging when a message is ambiguous rather than dismissing it — it's better to flag a borderline message than miss a real one. Only skip flagging messages that are clearly ordinary schoolwork chat with nothing safety-relevant in them.

Respond with ONLY compact JSON and nothing else, in this exact shape:
{"concerning": true or false, "category": "self-harm" | "abuse" | "bullying" | "unsafe" | "none", "reason": "one short phrase"}`;

// Deterministic backstop: always flag these terms regardless of what the
// classifier decides, even in figurative use ("this homework is killing me").
const KEYWORD_PATTERN = /\b(kill|kills|killing|killed)\b/i;

function keywordFlag(text) {
  const match = text.match(KEYWORD_PATTERN);
  if (!match) return null;
  return { concerning: true, category: 'violent-language', reason: `Contains flagged keyword: "${match[0]}"` };
}

async function callClaude(body) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const textOf = (data) =>
  (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// Never throws, so it can't block the chat reply.
async function classifyMessage(text) {
  try {
    const { ok, data } = await callClaude({
      model: CLASSIFIER_MODEL,
      max_tokens: 150,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    if (!ok) {
      console.error('Classifier API error:', data);
      return null;
    }
    const jsonMatch = textOf(data).match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    console.error('Classifier error:', err.message);
    return null;
  }
}

async function saveFlag(session, messageId, content, flag) {
  // Log internal IDs only, never the student's name.
  console.warn(
    `⚠️  FLAGGED_MESSAGE ${JSON.stringify({ user_id: session.user_id, course_id: session.course_id, message_id: messageId, category: flag.category, reason: flag.reason })}`
  );
  try {
    await db.addFlag({
      messageId,
      userId: session.user_id,
      courseId: session.course_id,
      category: String(flag.category || 'unknown').slice(0, 50),
      reason: flag.reason ? String(flag.reason).slice(0, 300) : null,
      content,
    });
  } catch (err) {
    console.error('Could not save flag:', err.message);
  }
}

// ---------- Chat API ----------

// Who's here, plus their recent conversation so they can pick up where they left off.
app.get(
  '/api/session',
  requireSession,
  asyncRoute(async (req, res) => {
    const s = req.session;
    const conversationId = await db.getRecentConversation(s.user_id, s.course_id, RESUME_HOURS);
    const messages = conversationId ? await db.getConversationMessages(conversationId, s.user_id) : [];
    res.json({
      firstName: firstNameOf(s),
      courseTitle: s.course_title || null,
      isInstructor: s.is_instructor,
      conversationId,
      messages,
    });
  })
);

// "New chat" button.
app.post(
  '/api/conversations',
  requireSession,
  asyncRoute(async (req, res) => {
    const id = await db.createConversation(req.session.user_id, req.session.course_id);
    res.json({ conversationId: id });
  })
);

// Body: { conversationId?: number, message: string }. History lives in the
// database, so the browser can't edit what the tutor said earlier.
app.post(
  '/api/chat',
  requireSession,
  chatLimiter,
  asyncRoute(async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });

    const s = req.session;
    const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!text || text.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Messages must be between 1 and ${MAX_MESSAGE_CHARS} characters.` });
    }

    let conversationId = Number(req.body?.conversationId) || null;
    if (conversationId && !(await db.conversationBelongsTo(conversationId, s.user_id))) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
    if (!conversationId) conversationId = await db.createConversation(s.user_id, s.course_id);

    const history = await db.getConversationMessages(conversationId, s.user_id);
    if (history.length + 1 >= MAX_MESSAGES) {
      return res.status(400).json({ error: 'This conversation is getting long! Click "New chat" to start a fresh one.', conversationFull: true });
    }
    if (history.length && history[history.length - 1].role === 'user') {
      return res.status(409).json({ error: 'Still working on your last message. Please wait a moment.' });
    }

    const userMessageId = await db.addMessage(conversationId, 'user', text);
    const messages = [...history, { role: 'user', content: text }];

    try {
      const [reply, classifierFlag] = await Promise.all([
        callClaude({ model: MODEL, max_tokens: 1024, system: getSystemPrompt(s), messages }),
        classifyMessage(text),
      ]);

      const flag = keywordFlag(text) || classifierFlag;
      if (flag && flag.concerning) await saveFlag(s, userMessageId, text, flag);

      if (!reply.ok) {
        console.error('Anthropic API error:', reply.data);
        await db.deleteMessage(userMessageId); // keep user/assistant turns alternating
        return res.status(reply.status).json({ error: reply.data.error?.message || 'API request failed.' });
      }

      const replyText = textOf(reply.data);
      await db.addMessage(conversationId, 'assistant', replyText, {
        model: reply.data.model,
        inputTokens: reply.data.usage?.input_tokens,
        outputTokens: reply.data.usage?.output_tokens,
      });
      res.json({ text: replyText, conversationId });
    } catch (err) {
      console.error('Chat error:', err);
      await db.deleteMessage(userMessageId).catch(() => {});
      res.status(500).json({ error: 'Something went wrong talking to the Claude API.' });
    }
  })
);

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong on the server.' });
  lti.errorPage(res, 500, 'Something went wrong', 'Please reload the page in Canvas and try again.');
});

// ---------- Startup ----------

async function start() {
  if (!API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY is not set.');
  if (!lti.config.clientIds.length) console.warn('⚠️  LTI_CLIENT_ID is not set; Canvas launches will be rejected.');
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set. Add a Render Postgres database (see README).');
    process.exit(1);
  }

  await db.migrate();
  const runCleanup = () => db.cleanup(RETENTION_DAYS).catch((e) => console.error('Cleanup failed:', e.message));
  runCleanup();
  setInterval(runCleanup, 6 * 60 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`Tutor (LTI 1.3) running on port ${PORT}`);
    console.log(`Public URL: ${lti.config.baseUrl}`);
    console.log(`Canvas config: ${lti.config.baseUrl}/lti/config.json`);
    console.log(`Allowed client IDs: ${lti.config.clientIds.join(', ') || '(none)'}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
