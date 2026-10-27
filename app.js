const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let user = JSON.parse(localStorage.getItem('devhub-user') || 'null');

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(user && { Authorization: 'Bearer ' + user.token }) }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && user && path !== '/api/login') logout();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- Navigation ----------
function show(view) {
  document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== view);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'snippets') loadSnippets();
  if (view === 'roadmap') loadRoadmap();
}
$('#nav').addEventListener('click', e => e.target.dataset.view && show(e.target.dataset.view));

// ---------- Account ----------
function renderAccount() {
  $('#account').innerHTML = user ? `Signed in as<br>${esc(user.email)}<button id="logout">Log out</button>` : `<button id="open-auth">Log in</button>`;
  $('#logout')?.addEventListener('click', () => { logout(); show('tools'); });
  $('#open-auth')?.addEventListener('click', () => openAuth());
}
function logout() { user = null; localStorage.removeItem('devhub-user'); renderAccount(); }

let mode = 'login';
function openAuth(m = 'login') {
  mode = m; $('#auth-msg').textContent = '';
  $('#auth-title').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#auth-go').textContent = m === 'login' ? 'Log in' : 'Sign up';
  $('#auth-switch').textContent = m === 'login' ? 'Create an account' : 'I have an account';
  $('#auth').showModal();
}
$('#auth-switch').onclick = () => openAuth(mode === 'login' ? 'register' : 'login');
$('#auth-close').onclick = () => $('#auth').close();
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    user = await api('/api/' + mode, 'POST', Object.fromEntries(new FormData(e.target)));
    localStorage.setItem('devhub-user', JSON.stringify(user));
    e.target.reset(); $('#auth').close(); renderAccount();
    const active = document.querySelector('#nav .on').dataset.view; show(active);
  } catch (err) { $('#auth-msg').className = 'msg err'; $('#auth-msg').textContent = err.message; }
});

// ---------- Dev tools (client-side) ----------
const b64d = s => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
const TOOLS = [
  { name: 'JSON', actions: { Format: v => JSON.stringify(JSON.parse(v), null, 2), Minify: v => JSON.stringify(JSON.parse(v)) } },
  { name: 'Base64', actions: { Encode: v => btoa(unescape(encodeURIComponent(v))), Decode: v => decodeURIComponent(escape(atob(v))) } },
  { name: 'URL', actions: { Encode: encodeURIComponent, Decode: decodeURIComponent } },
  { name: 'JWT', actions: { Decode: v => { const [h, p] = v.trim().split('.'); return JSON.stringify({ header: b64d(h), payload: b64d(p) }, null, 2); } } },
  { name: 'Timestamp', actions: { 'To date': v => new Date(+v * (v.trim().length > 11 ? 1 : 1000)).toISOString(), 'To unix': v => String(Math.floor(new Date(v) / 1000)), 'Now': () => String(Math.floor(Date.now() / 1000)) } },
  { name: 'UUID', actions: { 'Make 5': () => Array.from({ length: 5 }, () => crypto.randomUUID()).join('\n') } },
];
let tool = 0;
function renderTools() {
  $('#tool-tabs').innerHTML = TOOLS.map((t, i) => `<button class="${i === tool ? 'on' : ''}" data-i="${i}">${t.name}</button>`).join('');
  $('#t-actions').innerHTML = Object.keys(TOOLS[tool].actions).map(a => `<button data-a="${esc(a)}">${esc(a)}</button>`).join('') + '<button class="ghost" id="t-copy">Copy output</button>';
}
$('#tool-tabs').addEventListener('click', e => { if (e.target.dataset.i) { tool = +e.target.dataset.i; $('#t-msg').textContent = ''; renderTools(); } });
$('#t-actions').addEventListener('click', async e => {
  const msg = $('#t-msg');
  if (e.target.id === 't-copy') { await navigator.clipboard.writeText($('#t-out').value); msg.className = 'msg'; return msg.textContent = 'Copied.'; }
  const fn = TOOLS[tool].actions[e.target.dataset.a]; if (!fn) return;
  try { $('#t-out').value = fn($('#t-in').value); msg.className = 'msg'; msg.textContent = 'Done.'; }
  catch (err) { msg.className = 'msg err'; msg.textContent = 'Could not process the input. Check that it is valid ' + TOOLS[tool].name + '.'; }
});

// ---------- Snippet vault (server) ----------
function gate() {
  const ok = !!user;
  $('#snip-app').hidden = !ok;
  $('#snip-gate').innerHTML = ok ? '' : `<div class="card"><p>Log in to save code snippets. They are stored privately in your own account.</p><button id="gate-login">Log in or sign up</button></div>`;
  $('#gate-login')?.addEventListener('click', () => openAuth());
  return ok;
}
async function loadSnippets() {
  if (!gate()) return;
  try {
    const list = await api('/api/snippets?q=' + encodeURIComponent($('#snip-search').value));
    $('#snip-list').innerHTML = list.length ? list.map(s => `<div class="card snip">
      <h3>${esc(s.title)}</h3><small>${esc(s.lang)}${s.tags ? ' · ' + esc(s.tags) : ''}</small>
      <pre><code>${esc(s.code)}</code></pre>
      <button data-copy="${s.id}">Copy</button> <button class="ghost" data-del="${s.id}">Delete</button></div>`).join('')
      : '<p class="sub">No snippets yet. Save your first one above.</p>';
    $('#snip-list').snips = list;
  } catch (e) { $('#snip-list').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
$('#snip-form').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('/api/snippets', 'POST', Object.fromEntries(new FormData(e.target))); e.target.reset(); loadSnippets(); }
  catch (err) { alert(err.message); }
});
$('#snip-search').addEventListener('input', () => { clearTimeout(window.st); window.st = setTimeout(loadSnippets, 250); });
$('#snip-list').addEventListener('click', async e => {
  const { copy, del } = e.target.dataset;
  if (copy) { await navigator.clipboard.writeText($('#snip-list').snips.find(s => s.id == copy).code); e.target.textContent = 'Copied'; }
  if (del && confirm('Delete this snippet?')) { await api('/api/snippets/' + del, 'DELETE'); loadSnippets(); }
});

// ---------- Roadmap (server when logged in, otherwise this browser) ----------
const ROAD = {
  'Frontend': [['HTML and semantic markup', 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content'], ['CSS layout: flexbox and grid', 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout'], ['JavaScript fundamentals', 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting'], ['fetch and async/await', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch'], ['A framework: React', 'https://react.dev/learn']],
  'Backend': [['Node.js basics', 'https://nodejs.org/en/learn'], ['HTTP and REST APIs', 'https://developer.mozilla.org/en-US/docs/Web/HTTP'], ['SQL and databases', 'https://sqlbolt.com'], ['Authentication and password hashing', 'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html']],
  'Ship it': [['Git and GitHub', 'https://git-scm.com/book'], ['Testing with node:test', 'https://nodejs.org/api/test.html'], ['Docker basics', 'https://docs.docker.com/get-started/']],
};
const TOTAL = Object.values(ROAD).flat().length;
async function loadRoadmap() {
  let done = [];
  try { done = user ? await api('/api/progress') : JSON.parse(localStorage.getItem('devhub-done') || '[]'); } catch {}
  $('#road-list').innerHTML = Object.entries(ROAD).map(([g, items]) => `<div class="group"><h3>${g}</h3>` + items.map(([t, url]) =>
    `<label class="topic ${done.includes(t) ? 'done' : ''}"><input type="checkbox" data-t="${esc(t)}" ${done.includes(t) ? 'checked' : ''}><span>${esc(t)}</span><a href="${url}" target="_blank" rel="noopener">Learn</a></label>`).join('') + '</div>').join('');
  const pct = Math.round(done.length / TOTAL * 100);
  $('#bar-fill').style.width = pct + '%';
  $('#road-sub').textContent = `${done.length} of ${TOTAL} topics done (${pct}%). ` + (user ? 'Progress is saved to your account.' : 'Log in to save progress to your account; for now it is saved in this browser.');
}
$('#road-list').addEventListener('change', async e => {
  const t = e.target.dataset.t; if (!t) return;
  if (user) await api('/api/progress', 'POST', { topic: t }).catch(() => {});
  else { const d = JSON.parse(localStorage.getItem('devhub-done') || '[]'); localStorage.setItem('devhub-done', JSON.stringify(e.target.checked ? [...d, t] : d.filter(x => x !== t))); }
  loadRoadmap();
});

renderAccount(); renderTools();
