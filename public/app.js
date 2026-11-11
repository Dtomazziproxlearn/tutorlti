const chatEl = document.getElementById('chat');
const formEl = document.getElementById('form');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const welcomeEl = document.getElementById('welcome');
const welcomeTitleEl = document.getElementById('welcome-title');
const newChatEl = document.getElementById('new-chat');

// The server puts a session token in the page when Canvas launches the tool.
// It's sent with every request instead of a cookie, because browsers block
// third-party cookies inside the Canvas iframe.
const BOOT = (() => {
  try {
    return JSON.parse(document.getElementById('lti-boot').textContent);
  } catch {
    return {};
  }
})();

if (window.self !== window.top) document.documentElement.classList.add('in-canvas');

// The conversation is stored on the server; we only track which one we're in.
let conversationId = null;

const AVATAR_ICONS = {
  // Graduation cap, for the tutor.
  assistant: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="12" fill="#00bde8" />
    <path d="M12 6.2 4 10l8 3.8 6.5-3.1V15h1.5v-5l-8-3.8Z" fill="#fff" />
    <path d="M7.5 12.8v3c0 1.2 2 2.2 4.5 2.2s4.5-1 4.5-2.2v-3L12 15l-4.5-2.2Z" fill="#fff" />
  </svg>`,
  // Generic person silhouette, for the student.
  user: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="12" fill="var(--accent)" />
    <circle cx="12" cy="9.5" r="3.5" fill="#fff" />
    <path d="M5 19c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" fill="#fff" />
  </svg>`,
};

// Open links in tutor replies in a new tab so students don't lose the chat.
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

// Shows a tutor reply with its Markdown formatting (bold, lists, etc.).
// The HTML is sanitized so a reply can never inject scripts into the page,
// and images are blocked so a reply can't pull in pictures from the web.
// Falls back to plain text if either library failed to load.
// The chat can't display LaTeX math, so turn delimiters like $$3x + 5 = 20$$
// or \(3x + 5 = 20\) into plain parentheses: (3x + 5 = 20). Single $ signs
// are left alone so prices like $5 still show correctly.
function stripMathDelimiters(text) {
  return text
    .replace(/\$\$\s*([\s\S]+?)\s*\$\$/g, '($1)')
    .replace(/\\\(\s*([\s\S]+?)\s*\\\)/g, '($1)')
    .replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, '($1)')
    .replace(/\(\(([^()]*)\)\)/g, '($1)');
}

function renderMarkdown(el, text) {
  el.classList.add('markdown');
  text = stripMathDelimiters(text);
  if (window.marked && window.DOMPurify) {
    const html = marked.parse(text, { breaks: true });
    el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'form', 'input', 'video', 'audio'] });
  } else {
    el.textContent = text;
  }
}

function addMessage(role, text) {
  if (role === 'error') {
    const div = document.createElement('div');
    div.className = 'message error';
    div.textContent = text;
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    return div;
  }

  const row = buildMessageRow(role);
  row.bubble.textContent = text;
  chatEl.scrollTop = chatEl.scrollHeight;
  return row.bubble;
}

function addTypingIndicator() {
  const row = buildMessageRow('assistant');
  row.bubble.classList.add('thinking');
  row.bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  chatEl.scrollTop = chatEl.scrollHeight;
  return row.bubble;
}

// Builds a `.row` with the role's avatar and an empty message bubble,
// ordered so the avatar sits on the outside edge (student on the right,
// tutor on the left), and appends it to the chat.
function buildMessageRow(role) {
  const row = document.createElement('div');
  row.className = `row ${role}`;

  const avatar = document.createElement('div');
  avatar.className = `avatar ${role}`;
  avatar.innerHTML = AVATAR_ICONS[role];

  const bubble = document.createElement('div');
  bubble.className = `message ${role}`;

  if (role === 'user') {
    row.append(bubble, avatar);
  } else {
    row.append(avatar, bubble);
  }

  chatEl.appendChild(row);
  return { row, bubble };
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
}
inputEl.addEventListener('input', autoGrow);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Hold the typing indicator a bit before revealing the reply, roughly
// scaled to its length, so responses don't pop in instantly.
function typingDelay(text) {
  const ms = 400 + text.length * 6;
  return Math.min(ms, 2500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BOOT.token || ''}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function setComposerEnabled(enabled, placeholder) {
  inputEl.disabled = !enabled;
  sendEl.disabled = !enabled;
  if (placeholder) inputEl.placeholder = placeholder;
}

// On load: greet the student by name and reopen their recent conversation.
async function init() {
  if (!BOOT.token) {
    setComposerEnabled(false, 'Open the tutor from Canvas to start.');
    return;
  }
  try {
    const { res, data } = await api('/api/session');
    if (!res.ok) {
      setComposerEnabled(false, 'Please reload the page in Canvas.');
      addMessage('error', data.error || "We couldn't start the tutor.");
      return;
    }
    if (data.firstName) {
      welcomeTitleEl.textContent = `Hi ${data.firstName}! What are we working on today?`;
    }
    conversationId = data.conversationId;
    if (data.messages && data.messages.length) {
      welcomeEl?.remove();
      for (const m of data.messages) {
        if (m.role === 'user') {
          addMessage('user', m.content);
        } else {
          const { bubble } = buildMessageRow('assistant');
          renderMarkdown(bubble, m.content);
        }
      }
      chatEl.scrollTop = chatEl.scrollHeight;
      newChatEl.hidden = false;
    }
  } catch {
    addMessage('error', 'Network error. Please reload the page in Canvas.');
  }
}

newChatEl.addEventListener('click', async () => {
  if (sendEl.disabled) return;
  // Next message starts a new conversation on the server.
  conversationId = null;
  chatEl.replaceChildren(welcomeEl);
  newChatEl.hidden = true;
  inputEl.focus();
});

async function sendMessage(text) {
  welcomeEl?.remove();
  addMessage('user', text);

  inputEl.value = '';
  autoGrow();
  sendEl.disabled = true;

  const thinkingEl = addTypingIndicator();

  try {
    const { res, data } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId, message: text }),
    });

    if (!res.ok) {
      thinkingEl.closest('.row').remove();
      addMessage('error', data.error || 'Something went wrong.');
      if (data.conversationFull) newChatEl.hidden = false;
      if (data.sessionExpired) setComposerEnabled(false, 'Please reload the page in Canvas.');
      return;
    }

    conversationId = data.conversationId;
    newChatEl.hidden = false;
    await sleep(typingDelay(data.text));
    thinkingEl.classList.remove('thinking');
    renderMarkdown(thinkingEl, data.text);
  } catch (err) {
    thinkingEl.closest('.row').remove();
    addMessage('error', 'Network error. Check your connection and try again.');
  } finally {
    if (!inputEl.disabled) sendEl.disabled = false;
    inputEl.focus();
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  sendMessage(text);
});

// Starter prompts on the welcome screen send themselves when tapped.
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (!sendEl.disabled) sendMessage(chip.dataset.prompt);
  });
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

init();
