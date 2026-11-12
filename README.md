# PLI Student Tutor: Canvas LTI 1.3 version

The PLI Student Tutor as a Canvas tool. Students open **Tutor** in their
course menu. Canvas signs them in automatically, the tutor greets them by
first name, and their chats, courses and any safety flags are saved in a
Render Postgres database.

The assistant's behavior is still controlled entirely by `CLAUDE.md`. Edit
it and push, and the changes apply with no code changes.

## What changed from the standalone version

| | Standalone | LTI version |
|---|---|---|
| Sign-in | Shared class code | Canvas launch (LTI 1.3); no code to type |
| Student identity | None | Name, email, Canvas IDs, role, course |
| Conversation history | Browser tab only, lost on refresh | Saved in Postgres; resumes on return |
| Flagged messages | Log file, wiped on every deploy | `flagged_messages` table, linked to student and course |
| Rate limit | Per IP (a whole classroom shares one) | Per student |
| Direct URL | Opens the chat | Shows "open from Canvas"; chat only via launch |

**What the tutor sees:** the student's **first name**, the **course
title**, and the course's **published modules** (see below) are added to
the system prompt. When a student asks about something specific, the tutor
can also read that module, page or assignment from Canvas. The tutor never sees the last name,
email or IDs. Names are stripped to ordinary letters first, so a
display name can't sneak instructions into the prompt.

## Files

- `server.js`: Express server: LTI routes, chat API, safety classifier.
- `lti.js`: LTI 1.3 login, launch verification, key set, Canvas config.
- `canvas.js`: Reads the course's module outline and content from the Canvas API.
- `tutor-tools.js`: The tools the tutor uses to read course content mid-chat.
- `db/schema.sql`: Tables (created automatically on startup).
- `db/index.js`: Database queries.
- `views/app.html`: The chat page, filled in with a session token at launch.
- `public/`: CSS and frontend JavaScript.
- `CLAUDE.md`: The tutor's system prompt.
- `test/e2e.js`: End-to-end test with a mock Canvas and mock Claude API.

## Setup

### 1. Deploy to Render

1. Push this repo to GitHub. Never commit `.env`.
2. In Render: **New + → Blueprint**, then pick the repo. This creates the web
   service **and** a Postgres database, and connects them (`DATABASE_URL`).
3. When Render asks for secrets:
   - `ANTHROPIC_API_KEY`: your Claude API key.
   - `LTI_PRIVATE_KEY`: run `node scripts/generate-key.js` locally and paste
     the single line it prints.
   - `LTI_CLIENT_ID`: put `pending` for now. You'll get the real value in step 2.
4. After it deploys, open `https://<your-service>.onrender.com/lti/config.json`.
   You should see JSON. If you use a custom domain (for example
   `tutor.proxlearn.com`), set `PUBLIC_BASE_URL` to it **before** step 2.

### 2. Register the tool in Canvas (Canvas admin)

1. **Admin → Developer Keys → + Developer Key → + LTI Key**.
2. Set **Method** to **Enter URL** and paste
   `https://<your-service>.onrender.com/lti/config.json`.
   (Or choose **Paste JSON** and paste that page's contents.)
3. Set **Redirect URIs** to `https://<your-service>.onrender.com/lti/launch`.
4. Make sure **Privacy Level** is **Public**. Otherwise Canvas won't send names.
5. **Save**, then switch the key's State to **ON**.
6. Copy the key's **Client ID** (the long number in the Details column).
   In Render, set `LTI_CLIENT_ID` to that number. Render redeploys
   automatically.
7. **Admin → Settings → Apps → View App Configurations → + App →
   Configuration Type: By Client ID**. Paste the Client ID and click **Install**.
   (You can do this per course instead of account-wide.)

**Tutor** now appears in course navigation. Open it as a student (or with
**Student View**) to test it.

**More than one Canvas instance (districts):** each district creates its own
Developer Key. Put all the client IDs in `LTI_CLIENT_IDS`, comma-separated.
If a district uses a custom Canvas domain (for example
`canvas.district.org`), add it to `FRAME_ANCESTORS`, or the browser won't
show the tutor in their iframe.

### 3. Let the tutor see course modules (optional, recommended)

With this set up, the tutor already knows what's in each module, so a
student can say "I'm stuck on the Module 3 quiz" without explaining it.
For each course, the tutor reads module names, item titles and types,
due dates, and the first ~300 characters of each assignment and quiz
description. It only reads **published** content, and it saves the list
for an hour so a whole class launching at once makes one Canvas request.
No student data is read.

**Reading full content when needed.** When a student asks something like
"can you explain Module 3?" or "what does the essay assignment want?",
the tutor can read the actual content before answering. It has three tools:

| Tool | Reads |
|---|---|
| `get_module_content` | Every published item in one module: page text, assignment instructions and rubrics, quiz and discussion instructions |
| `get_page` | The full text of one page |
| `get_assignment` | One assignment, quiz or discussion: instructions, points, due date, rubric |

Nothing is fetched until a question needs it. The tutor only picks *which*
module or item to read; the course always comes from the student's
launch, so it can't reach other courses. It sees only published items
inside published modules, never quiz questions, and never files, PDFs or
external tools. It can make at most 3 lookups per student message.
Content is cached for an hour, so a class asking about the same module
makes one set of Canvas requests. Only the tutor's reply is saved in the
database, not the course content it read.

Render's **Logs** show each lookup as `Tutor tool: get_module_content
course=… chars=… ms=…`. Keep answer keys in **unpublished** pages: like
students, the tutor can read anything that's published.

LTI launches can't read the Canvas API on their own, so the tutor uses a
token from a dedicated Canvas account:

1. **Create the account.** In Canvas, **Admin → People → + People**, add a
   user such as "Tutor Service Account".
2. **Give it read-only access.** **Admin → Permissions → Account Roles →
   + Add Role**, for example "Tutor (read-only)". Turn on only what's needed
   to view courses and their content (for example **Courses - view list**
   and **Course Content - view**; names vary slightly between Canvas
   versions). Then **Admin → Settings → Admins → + Account Admins** and
   add the account with that role.
3. **Make the token.** Sign in **as that account** (not via "Act as").
   **Account → Settings → + New Access Token**, purpose "PLI Tutor".
   If you set an expiry date, put a reminder on the calendar to replace it.
4. **In Render**, set `CANVAS_API_BASE_URL` to your Canvas address (for
   example `https://district.instructure.com`) and `CANVAS_API_TOKEN` to
   the token.
5. **Update the Developer Key** so Canvas sends its API address with each
   launch: open the key, re-enter the config URL (or re-paste the JSON from
   `/lti/config.json`), and **Save**. If you only use one Canvas, this step
   is optional.

To check it's working, open the tutor in a course and look at Render's
**Logs** for `Canvas outline refreshed: course=… chars=…`. A
`Canvas outline fetch failed … 401/403` line means the token or the role
permissions are wrong. The chat keeps working either way.

**Canvas beta:** use the beta address
(`https://district.beta.instructure.com`) as `CANVAS_API_BASE_URL`. Beta is
copied from production every few weeks, and tokens created in beta are
erased each time, so create the token in **production** and wait for the
next beta refresh (or create one in beta and recreate it after each
refresh).

**Several Canvas instances:** use `CANVAS_API_TOKENS` instead, with
comma-separated `https://canvas-address=token` pairs. A token is only ever
sent to the Canvas address it's paired with.

## Settings

All settings are in `.env.example`. The important ones:

- `RETENTION_DAYS` (default 365 on Render): chats and flags older than
  this are deleted automatically. Set it to match your district agreements.
- `RESUME_HOURS` (12): a student returning within this window continues
  their last chat. **+ New chat** starts fresh.
- `CANVAS_OUTLINE_TTL_MINUTES` (60): how long a course's module list is
  saved before the tutor re-reads it from Canvas. After a teacher changes a
  module, it shows up in the tutor within this time.
- `LTI_DEPLOYMENT_IDS`: optional allowlist, if you want to lock the tool to
  specific installs.
- `LTI_ISSUER` / `LTI_AUTH_URL` / `LTI_JWKS_URL`: leave the defaults for
  Canvas Cloud production. Change them only for Canvas beta/test or a
  self-hosted Canvas (see `.env.example`).

## Reviewing flagged messages

Each flag is also printed to Render's **Logs** tab as `FLAGGED_MESSAGE`,
with IDs only and no names. To see the full details, open the database's
**Shell** (or connect with `psql`) in Render:

```sql
SELECT f.created_at, f.category, f.reason, f.content,
       u.name AS student, u.email, c.title AS course
  FROM flagged_messages f
  LEFT JOIN users u   ON u.id = f.user_id
  LEFT JOIN courses c ON c.id = f.course_id
 WHERE NOT f.reviewed
 ORDER BY f.created_at DESC;
```

Mark a flag as handled with `UPDATE flagged_messages SET reviewed = true WHERE id = ...;`.

## Running locally

Canvas can only launch tools at a public HTTPS URL, so real launches need
the Render deploy. To test locally against a mock Canvas:

```
npm install
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/tutor_test npm test
```

The test **wipes** the database you point it at, so use a throwaway one.

## Notes

- The session token lives in the page, not in a cookie. Safari and Chrome
  block third-party cookies inside the Canvas iframe, and cookies there would
  break randomly.
- Render's free web plan sleeps when idle and takes about a minute to wake,
  which looks like a blank Canvas frame. The blueprint uses `starter`.
- The free Render Postgres plan expires after 30 days. The blueprint uses
  `basic-256mb`.
