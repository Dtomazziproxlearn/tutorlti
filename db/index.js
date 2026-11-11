// Postgres access. Uses DATABASE_URL, which Render fills in from the
// database defined in render.yaml.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

// Render's *internal* URL (used between Render services) has a bare host
// like "dpg-abc123-a" and needs no SSL. The *external* URL, used when you
// run the app on your own computer, ends in ".render.com" and requires SSL.
function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  try {
    return new URL(url).hostname.endsWith('.render.com') ? { rejectUnauthorized: false } : false;
  } catch {
    return false;
  }
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL), max: 10 })
  : null;

function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set.');
  return pool.query(text, params);
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ---------- LTI login state ----------

async function saveLoginState(state, nonce) {
  await query('INSERT INTO lti_states (state, nonce) VALUES ($1, $2)', [state, nonce]);
}

// Returns the nonce for a state and deletes it (one-time use). Null if the
// state is unknown or older than 10 minutes.
async function consumeLoginState(state) {
  const { rows } = await query(
    `DELETE FROM lti_states WHERE state = $1
     RETURNING nonce, created_at > now() - interval '10 minutes' AS fresh`,
    [state]
  );
  return rows[0] && rows[0].fresh ? rows[0].nonce : null;
}

// Records a nonce as used. Returns false if it was already used (replay).
async function markNonceUsed(nonce) {
  const { rowCount } = await query(
    'INSERT INTO lti_used_nonces (nonce) VALUES ($1) ON CONFLICT DO NOTHING',
    [nonce]
  );
  return rowCount === 1;
}

// ---------- Users, courses, sessions ----------

async function upsertUser(u) {
  const { rows } = await query(
    `INSERT INTO users (issuer, lti_sub, canvas_user_id, name, given_name, family_name, email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (issuer, lti_sub) DO UPDATE SET
       canvas_user_id = COALESCE(EXCLUDED.canvas_user_id, users.canvas_user_id),
       name           = COALESCE(EXCLUDED.name, users.name),
       given_name     = COALESCE(EXCLUDED.given_name, users.given_name),
       family_name    = COALESCE(EXCLUDED.family_name, users.family_name),
       email          = COALESCE(EXCLUDED.email, users.email),
       last_seen_at   = now()
     RETURNING id, (xmax = 0) AS is_new`,
    [u.issuer, u.sub, u.canvasUserId, u.name, u.givenName, u.familyName, u.email]
  );
  return rows[0];
}

async function upsertCourse(c) {
  const { rows } = await query(
    `INSERT INTO courses (issuer, deployment_id, context_id, canvas_course_id, title, label, platform_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (issuer, deployment_id, context_id) DO UPDATE SET
       canvas_course_id = COALESCE(EXCLUDED.canvas_course_id, courses.canvas_course_id),
       title            = COALESCE(EXCLUDED.title, courses.title),
       label            = COALESCE(EXCLUDED.label, courses.label),
       platform_name    = COALESCE(EXCLUDED.platform_name, courses.platform_name),
       updated_at       = now()
     RETURNING id`,
    [c.issuer, c.deploymentId, c.contextId, c.canvasCourseId, c.title, c.label, c.platformName]
  );
  return rows[0].id;
}

async function recordEnrollment(userId, courseId, roles, isInstructor) {
  await query(
    `INSERT INTO enrollments (user_id, course_id, roles, is_instructor, launch_count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (user_id, course_id) DO UPDATE SET
       roles = EXCLUDED.roles,
       is_instructor = EXCLUDED.is_instructor,
       launch_count = enrollments.launch_count + 1,
       last_launch_at = now()`,
    [userId, courseId, roles, isInstructor]
  );
}

async function createSession(userId, courseId, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, course_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hashToken(token), userId, courseId, hours]
  );
  return token;
}

// Looks up a bearer token. Returns the student and course context, or null.
async function getSession(token) {
  const { rows } = await query(
    `SELECT s.user_id, s.course_id,
            u.given_name, u.name,
            c.title AS course_title,
            COALESCE(e.is_instructor, false) AS is_instructor
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN courses c ON c.id = s.course_id
       LEFT JOIN enrollments e ON e.user_id = s.user_id AND e.course_id = s.course_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

// ---------- Conversations ----------

// The student's most recent conversation in this course, if it was active
// within `hours`. Lets a student pick up where they left off.
async function getRecentConversation(userId, courseId, hours) {
  const { rows } = await query(
    `SELECT id FROM conversations
      WHERE user_id = $1 AND course_id IS NOT DISTINCT FROM $2
        AND updated_at > now() - make_interval(hours => $3)
      ORDER BY updated_at DESC LIMIT 1`,
    [userId, courseId, hours]
  );
  return rows[0] ? rows[0].id : null;
}

async function createConversation(userId, courseId) {
  const { rows } = await query(
    'INSERT INTO conversations (user_id, course_id) VALUES ($1, $2) RETURNING id',
    [userId, courseId]
  );
  return rows[0].id;
}

// Only returns the conversation if it belongs to this user.
async function getConversationMessages(conversationId, userId) {
  const { rows } = await query(
    `SELECT m.role, m.content
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.id = $1 AND c.user_id = $2
      ORDER BY m.id`,
    [conversationId, userId]
  );
  return rows;
}

async function conversationBelongsTo(conversationId, userId) {
  const { rowCount } = await query(
    'SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2',
    [conversationId, userId]
  );
  return rowCount === 1;
}

async function addMessage(conversationId, role, content, meta = {}) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [conversationId, role, content, meta.model || null, meta.inputTokens ?? null, meta.outputTokens ?? null]
  );
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0].id;
}

async function deleteMessage(messageId) {
  await query('DELETE FROM messages WHERE id = $1', [messageId]);
}

async function addFlag(f) {
  await query(
    `INSERT INTO flagged_messages (message_id, user_id, course_id, category, reason, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [f.messageId, f.userId, f.courseId, f.category, f.reason, f.content]
  );
}

// ---------- Housekeeping ----------

// Clears expired login state, nonces and sessions. If retentionDays is set,
// also deletes conversations (and their messages) older than that.
async function cleanup(retentionDays) {
  await query(`DELETE FROM lti_states WHERE created_at < now() - interval '1 hour'`);
  await query(`DELETE FROM lti_used_nonces WHERE used_at < now() - interval '2 days'`);
  await query(`DELETE FROM sessions WHERE expires_at < now()`);
  if (retentionDays > 0) {
    await query(
      `DELETE FROM conversations WHERE updated_at < now() - make_interval(days => $1)`,
      [retentionDays]
    );
    await query(
      `DELETE FROM flagged_messages WHERE created_at < now() - make_interval(days => $1)`,
      [retentionDays]
    );
  }
}

module.exports = {
  pool,
  query,
  migrate,
  saveLoginState,
  consumeLoginState,
  markNonceUsed,
  upsertUser,
  upsertCourse,
  recordEnrollment,
  createSession,
  getSession,
  getRecentConversation,
  createConversation,
  getConversationMessages,
  conversationBelongsTo,
  addMessage,
  deleteMessage,
  addFlag,
  cleanup,
};
