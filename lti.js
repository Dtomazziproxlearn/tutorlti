// LTI 1.3 support for Canvas: OIDC login initiation, id_token launch
// verification, the tool's public key set, and the Canvas Developer Key
// configuration JSON.
//
// Flow (all of this happens inside the Canvas iframe in a second or two):
//   1. Canvas -> GET/POST /lti/login         (we save state+nonce, redirect to Canvas)
//   2. Canvas  -> POST /lti/launch            (signed id_token with the student's info)
//   3. We verify the token, save the user/course, create a session and
//      return the chat page with a session token embedded in it.

const crypto = require('crypto');
const db = require('./db');

const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';

// Defaults are Canvas Cloud production (any school on *.instructure.com).
// For a Canvas beta/test environment, or a self-hosted Canvas, override these.
const config = {
  issuer: process.env.LTI_ISSUER || 'https://canvas.beta.instructure.com',
  authUrl: process.env.LTI_AUTH_URL || 'https://sso.beta.canvaslms.com/api/lti/authorize_redirect',
  jwksUrl: process.env.LTI_JWKS_URL || 'https://sso.beta.canvaslms.com/api/lti/security/jwks',
  // Each Canvas instance that installs the tool creates its own Developer
  // Key, so allow a comma-separated list of client IDs.
  clientIds: splitList(process.env.LTI_CLIENT_IDS || process.env.LTI_CLIENT_ID),
  // Optional allowlist of deployment IDs. Empty = accept any deployment for
  // an allowed client ID.
  deploymentIds: splitList(process.env.LTI_DEPLOYMENT_IDS),
  baseUrl: (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  toolTitle: process.env.LTI_TOOL_TITLE || 'PLI Student Tutor',
};

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// jose is ESM-only; load it once and cache.
let josePromise;
const jose = () => (josePromise ||= import('jose'));

let platformJwks;
async function getPlatformJwks() {
  if (!platformJwks) {
    const { createRemoteJWKSet } = await jose();
    platformJwks = createRemoteJWKSet(new URL(config.jwksUrl), { cacheMaxAge: 60 * 60 * 1000 });
  }
  return platformJwks;
}

// ---------- The tool's own key pair ----------
// Canvas requires every LTI 1.3 tool to publish a public key. It's only used
// when the tool calls back into Canvas (grades, rosters), which this app
// doesn't do yet, but set LTI_PRIVATE_KEY so the key is stable across
// restarts. Generate one with: npm run generate-key

let toolKeyPromise;
function getToolKey() {
  return (toolKeyPromise ||= (async () => {
    const { importPKCS8, exportJWK, generateKeyPair, calculateJwkThumbprint } = await jose();
    let publicJwk;
    const pem = (process.env.LTI_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
    if (pem) {
      const privateKey = await importPKCS8(pem, 'RS256', { extractable: true });
      const { d, p, q, dp, dq, qi, ...pub } = await exportJWK(privateKey);
      publicJwk = pub;
    } else {
      console.warn('⚠️  LTI_PRIVATE_KEY is not set; using a temporary key that changes on every restart.');
      const { publicKey } = await generateKeyPair('RS256', { extractable: true });
      publicJwk = await exportJWK(publicKey);
    }
    publicJwk.kid = await calculateJwkThumbprint(publicJwk);
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    return publicJwk;
  })());
}

// ---------- Helpers ----------

function isInstructorRole(roles) {
  return roles.some((r) =>
    /membership#(Instructor|ContentDeveloper|Administrator|Mentor)$/.test(r) ||
    /membership\/Instructor#TeachingAssistant$/.test(r) ||
    /institution\/person#Administrator$/.test(r) ||
    /system\/person#(SysAdmin|Administrator)$/.test(r)
  );
}

function trimOrNull(value, max = 255) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v ? v.slice(0, max) : null;
}

function errorPage(res, status, title, detail) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>body{font-family:Nunito,Segoe UI,Arial,sans-serif;color:#16305c;background:#f4f6fb;display:grid;place-items:center;min-height:90vh;margin:0}
.box{max-width:460px;background:#fff;padding:28px 32px;border-radius:20px;box-shadow:0 10px 40px rgba(22,48,92,.12);text-align:center}
h1{font-size:1.25rem;color:#f68833;margin:0 0 10px}p{color:#6b7a94;line-height:1.5;margin:0}</style></head>
<body><div class="box"><h1>${esc(title)}</h1><p>${esc(detail)}</p></div></body></html>`);
}

// ---------- Step 1: OIDC login initiation ----------

async function handleLogin(req, res) {
  const p = { ...req.query, ...req.body };

  if (p.iss !== config.issuer) {
    console.warn('LTI login rejected: unexpected issuer', p.iss);
    return errorPage(res, 400, "This tool isn't set up for this Canvas", 'Unexpected LTI issuer. Ask your Canvas administrator to check the tool settings.');
  }
  if (!p.login_hint) {
    return errorPage(res, 400, 'Missing launch details', 'Please open the tutor from inside Canvas.');
  }
  // Canvas always sends client_id. Reject unknown keys early.
  if (p.client_id && !config.clientIds.includes(String(p.client_id))) {
    console.warn('LTI login rejected: unknown client_id', p.client_id);
    return errorPage(res, 400, "This tool isn't set up for this Canvas", 'Unknown Developer Key. Ask your Canvas administrator to add its client ID to LTI_CLIENT_IDS.');
  }
  const clientId = String(p.client_id || config.clientIds[0] || '');
  if (!clientId) {
    return errorPage(res, 500, 'Tool not configured', 'LTI_CLIENT_ID is not set on the server.');
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  await db.saveLoginState(state, nonce);

  const auth = new URL(config.authUrl);
  auth.search = new URLSearchParams({
    scope: 'openid',
    response_type: 'id_token',
    response_mode: 'form_post',
    prompt: 'none',
    client_id: clientId,
    redirect_uri: `${config.baseUrl}/lti/launch`,
    login_hint: String(p.login_hint),
    state,
    nonce,
    ...(p.lti_message_hint ? { lti_message_hint: String(p.lti_message_hint) } : {}),
  }).toString();

  res.redirect(302, auth.toString());
}

// ---------- Step 2: launch ----------

// Verifies the launch and returns { user, course, roles, isInstructor }, or
// throws an Error with a `userMessage` for the student-facing error page.
async function verifyLaunch(body) {
  const fail = (msg, userMessage = 'Please reload the page in Canvas and try again.') => {
    const err = new Error(msg);
    err.userMessage = userMessage;
    return err;
  };

  if (body.error) throw fail(`Platform returned error: ${body.error} ${body.error_description || ''}`);
  if (!body.id_token || !body.state) throw fail('Missing id_token or state');

  const expectedNonce = await db.consumeLoginState(String(body.state));
  if (!expectedNonce) throw fail('Unknown or expired state', 'Your launch link expired. Please reload the page in Canvas.');

  const { jwtVerify } = await jose();
  let payload;
  try {
    ({ payload } = await jwtVerify(String(body.id_token), await getPlatformJwks(), {
      issuer: config.issuer,
      audience: config.clientIds,
      algorithms: ['RS256'],
      clockTolerance: 60,
    }));
  } catch (err) {
    throw fail(`id_token verification failed: ${err.code || err.message}`);
  }

  if (payload.nonce !== expectedNonce) throw fail('Nonce mismatch');
  if (!(await db.markNonceUsed(payload.nonce))) throw fail('Nonce already used (replay)');

  // If the token is meant for several audiences, azp must name our client.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && !config.clientIds.includes(payload.azp)) {
    throw fail('azp does not match an allowed client_id');
  }

  if (payload[CLAIM + 'version'] !== '1.3.0') throw fail('Unsupported LTI version');
  if (payload[CLAIM + 'message_type'] !== 'LtiResourceLinkRequest') {
    throw fail(`Unsupported message type ${payload[CLAIM + 'message_type']}`, 'This kind of Canvas link is not supported by the tutor.');
  }

  const deploymentId = payload[CLAIM + 'deployment_id'];
  if (!deploymentId) throw fail('Missing deployment_id');
  if (config.deploymentIds.length && !config.deploymentIds.includes(deploymentId)) {
    throw fail(`Deployment ${deploymentId} not allowed`, "This tool isn't enabled for your school yet.");
  }
  if (!payload.sub) throw fail('Missing sub (anonymous launch)', 'The tutor needs to know who you are. Please sign in to Canvas and try again.');

  const roles = Array.isArray(payload[CLAIM + 'roles']) ? payload[CLAIM + 'roles'] : [];
  const context = payload[CLAIM + 'context'] || {};
  const custom = payload[CLAIM + 'custom'] || {};
  const platform = payload[CLAIM + 'tool_platform'] || {};

  // Canvas leaves unresolved substitution variables as literal "$Canvas..."
  // strings, so ignore those.
  const customValue = (k) => (typeof custom[k] === 'string' && !custom[k].startsWith('$') ? custom[k] : null);

  return {
    user: {
      issuer: payload.iss,
      sub: String(payload.sub),
      canvasUserId: customValue('canvas_user_id'),
      name: trimOrNull(payload.name),
      givenName: trimOrNull(payload.given_name),
      familyName: trimOrNull(payload.family_name),
      email: trimOrNull(payload.email),
    },
    course: context.id
      ? {
          issuer: payload.iss,
          deploymentId: String(deploymentId),
          contextId: String(context.id),
          canvasCourseId: customValue('canvas_course_id'),
          // e.g. https://district.instructure.com. Used to read the course's
          // modules from the Canvas API (canvas.js).
          canvasApiBase: customValue('canvas_api_base_url'),
          title: trimOrNull(context.title),
          label: trimOrNull(context.label),
          platformName: trimOrNull(platform.name),
        }
      : null,
    roles,
    isInstructor: isInstructorRole(roles),
  };
}

// ---------- Canvas Developer Key configuration ----------
// Paste the JSON from /lti/config.json into Canvas: Admin -> Developer Keys
// -> + Developer Key -> LTI Key -> Method: Paste JSON (or Enter URL).

function canvasConfig() {
  const base = config.baseUrl;
  return {
    title: config.toolTitle,
    description: 'A friendly AI tutor that guides students to answers step by step.',
    oidc_initiation_url: `${base}/lti/login`,
    target_link_uri: `${base}/lti/launch`,
    public_jwk_url: `${base}/lti/jwks`,
    scopes: [],
    extensions: [
      {
        domain: new URL(base).hostname,
        tool_id: 'pli-student-tutor',
        platform: 'canvas.instructure.com',
        // "public" is required for Canvas to send the student's name and email.
        privacy_level: 'public',
        settings: {
          text: config.toolTitle,
          placements: [
            {
              placement: 'course_navigation',
              message_type: 'LtiResourceLinkRequest',
              target_link_uri: `${base}/lti/launch`,
              text: 'Tutor',
              default: 'enabled',
              visibility: 'members',
            },
          ],
        },
      },
    ],
    custom_fields: {
      canvas_user_id: '$Canvas.user.id',
      canvas_course_id: '$Canvas.course.id',
      canvas_api_base_url: '$Canvas.api.baseUrl',
    },
  };
}

module.exports = { config, handleLogin, verifyLaunch, getToolKey, canvasConfig, errorPage };
