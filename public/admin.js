'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const PAGE = 50;

let token = '';
try { token = sessionStorage.getItem('adminToken') || ''; } catch {}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function call(query = '', body) {
  let res;
  try {
    res = await fetch('/api/admin' + query, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { error: 'Could not reach the server.' };
  }
  const data = await res.json().catch(() => ({ error: 'Something went wrong.' }));
  if (res.status === 401) logout(data.error);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function ago(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  for (const [n, unit] of [[86400, 'd'], [3600, 'h'], [60, 'min']]) if (s >= n) return `${Math.floor(s / n)} ${unit} ago`;
  return `${s} s ago`;
}

const shortId = (v) => (v === 'seed' ? 'starter list' : v ? v.slice(0, 8) : 'unknown');

/* ---------- Login ---------- */
function showPanel(on) {
  $('#login').hidden = on;
  $('#panel').hidden = !on;
  $('#logout').hidden = !on;
}

function logout(msg) {
  token = '';
  try { sessionStorage.removeItem('adminToken'); } catch {}
  showPanel(false);
  if (msg) {
    $('#login-msg').textContent = msg;
    $('#login-msg').classList.add('error');
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('#token').value;
  const data = await call(`?limit=1`);
  if (data.error) {
    $('#login-msg').textContent = data.error;
    $('#login-msg').classList.add('error');
    return;
  }
  try { sessionStorage.setItem('adminToken', token); } catch {}
  $('#token').value = '';
  showPanel(true);
  loadItems(true);
});
$('#logout').addEventListener('click', () => logout());

/* ---------- Tabs ---------- */
$$('.admin-tabs .pill').forEach((b) => b.addEventListener('click', () => {
  $$('.admin-tabs .pill').forEach((x) => x.classList.toggle('active', x === b));
  $('#tab-items').hidden = b.dataset.tab !== 'items';
  $('#tab-blocked').hidden = b.dataset.tab !== 'blocked';
  if (b.dataset.tab === 'blocked') loadBlocked();
}));

/* ---------- Things ---------- */
let offset = 0;
let searchSeq = 0;

async function loadItems(reset) {
  const mine = ++searchSeq;
  if (reset) offset = 0;
  const search = encodeURIComponent($('#search').value.trim());
  const data = await call(`?search=${search}&limit=${PAGE}&offset=${offset}`);
  if (mine !== searchSeq || data.error) return data.error && toast(data.error);
  const list = $('#rows');
  if (reset) list.textContent = '';
  data.items.forEach((it) => list.append(itemRow(it)));
  offset += data.items.length;
  $('#count').textContent = `${data.total} thing${data.total === 1 ? '' : 's'}`;
  $('#more').hidden = offset >= data.total;
  if (!data.total) list.append(el('li', { className: 'empty-row', textContent: 'Nothing matches.' }));
}

function itemRow(it) {
  const row = el('li', { className: 'row' });
  const name = el('div', { className: 'name', textContent: it.name });
  if (it.flagged) name.append(el('span', { className: 'badge', textContent: 'flagged by filter' }));
  if (it.blocked) name.append(el('span', { className: 'badge', textContent: 'submitter blocked' }));
  const meta = el('div', { className: 'meta' });
  meta.append(
    `${it.votes} vote${it.votes === 1 ? '' : 's'} · `,
    el('span', { className: 'o', textContent: `${it.overPct}% over` }), ' / ',
    el('span', { className: 'u', textContent: `${100 - it.overPct}% under` }),
    ` · ${it.duels} duels · added ${ago(it.createdAt)} by ${shortId(it.createdBy)}`,
  );
  const info = el('div', {}, name, meta);

  const actions = el('div', { className: 'actions' });
  const btn = (label, cls, fn) => {
    const b = el('button', { className: `act ${cls}`, textContent: label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      await fn();
      b.disabled = false;
    });
    return b;
  };

  actions.append(
    btn('Rename', '', async () => {
      const input = el('input', { className: 'rename-input', value: it.name, maxLength: 60 });
      const save = el('button', { className: 'act', textContent: 'Save' });
      const cancel = el('button', { className: 'act', textContent: 'Cancel' });
      const form = el('form', { className: 'rename' }, input, save, cancel);
      name.replaceWith(form);
      input.focus();
      cancel.addEventListener('click', (e) => { e.preventDefault(); form.replaceWith(name); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await call('', { action: 'rename', id: it.id, name: input.value });
        if (r.error) return toast(r.error);
        name.firstChild.textContent = input.value.trim().replace(/\s+/g, ' ');
        form.replaceWith(name);
        toast('Renamed.');
      });
    }),
    btn('Delete', 'danger', async () => {
      if (!confirm(`Delete “${it.name}” and all its votes?`)) return;
      const r = await call('', { action: 'delete', id: it.id });
      if (r.error) return toast(r.error);
      row.remove();
      toast('Deleted.');
    }),
  );

  if (it.createdBy && it.createdBy !== 'seed' && !it.blocked) {
    actions.append(btn('Block submitter + delete all theirs', 'danger', async () => {
      if (!confirm(`Block ${shortId(it.createdBy)} from adding things, and delete everything they have added?`)) return;
      const r = await call('', { action: 'block', voter: it.createdBy, purge: true });
      if (r.error) return toast(r.error);
      toast(`Blocked. Deleted ${r.removed} thing${r.removed === 1 ? '' : 's'}.`);
      loadItems(true);
    }));
  }

  row.append(info, actions);
  return row;
}

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadItems(true), 200);
});
$('#more').addEventListener('click', () => loadItems(false));

/* ---------- Blocked ---------- */
async function loadBlocked() {
  const data = await call('?view=blocked');
  if (data.error) return toast(data.error);
  const list = $('#blocked-rows');
  list.textContent = '';
  if (!data.blocked.length) {
    list.append(el('li', { className: 'empty-row', textContent: 'Nobody is blocked.' }));
    return;
  }
  for (const b of data.blocked) {
    const row = el('li', { className: 'row' });
    const unblock = el('button', { className: 'act', textContent: 'Unblock' });
    unblock.addEventListener('click', async () => {
      const r = await call('', { action: 'unblock', voter: b.voter });
      if (r.error) return toast(r.error);
      row.remove();
      toast('Unblocked.');
    });
    row.append(
      el('div', {},
        el('div', { className: 'name', textContent: shortId(b.voter) }),
        el('div', { className: 'meta', textContent: `Blocked ${ago(b.at)} · ${b.items} thing${b.items === 1 ? '' : 's'} still listed` })),
      el('div', { className: 'actions' }, unblock),
    );
    list.append(row);
  }
}

/* ---------- Start ---------- */
if (token) {
  showPanel(true);
  loadItems(true);
} else {
  showPanel(false);
}
