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

**What the tutor sees:** the student's **first name** and the **course
title** are added to the system prompt. The tutor never sees the last name,
email or IDs. Names are stripped to ordinary letters first, so a
display name can't sneak instructions into the prompt.

## Files

- `server.js`: Express server: LTI routes, chat API, safety classifier.
- `lti.js`: LTI 1.3 login, launch verification, key set, Canvas config.
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

## Settings

All settings are in `.env.example`. The important ones:

- `RETENTION_DAYS` (default 365 on Render): chats and flags older than
  this are deleted automatically. Set it to match your district agreements.
- `RESUME_HOURS` (12): a student returning within this window continues
  their last chat. **+ New chat** starts fresh.
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
