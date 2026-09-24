'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
  } catch {
    return { error: 'Could not reach the server. Check your connection.' };
  }
  const data = await res.json().catch(() => ({ error: 'Something went wrong.' }));
  if (!res.ok && !data.error) data.error = 'Something went wrong.';
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Grow text as large as it can be while fitting in a box, without breaking words.
function fit(el, { maxH, maxW, max = 240, min = 28 } = {}) {
  const w = maxW ?? el.clientWidth;
  const h = maxH ?? el.clientHeight;
  // Measure in a slightly narrower box: heavy glyphs with tight tracking
  // overhang their advance width.
  el.style.width = Math.floor(w * 0.97) + 'px';
  el.style.overflowWrap = 'normal';
  el.style.maxHeight = 'none';
  let lo = min, hi = max;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    el.style.fontSize = mid + 'px';
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= h) lo = mid;
    else hi = mid;
  }
  el.style.fontSize = lo + 'px';
  // Only break inside words when even the smallest size can't fit them.
  el.style.overflowWrap = lo <= min ? 'anywhere' : 'normal';
  el.style.maxHeight = '';
  el.style.width = '';
}

/* ---------------- Router ---------------- */
const views = { rate: '/', duel: '/duel', top: '/top', add: '/add' };
let current = null;

function viewFromPath(p) {
  const hit = Object.entries(views).find(([, path]) => path === p);
  return hit ? hit[0] : 'rate';
}

function show(view, push = true) {
  if (push && location.pathname !== views[view]) history.pushState({}, '', views[view]);
  current = view;
  $$('.view').forEach((v) => (v.hidden = v.id !== view));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  ({ rate: Rate.enter, duel: Duel.enter, top: Top.enter, add: Add.enter })[view]();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  show(a.dataset.view);
});
addEventListener('popstate', () => show(viewFromPath(location.pathname), false));

/* ---------------- Rate ---------------- */
const Rate = (() => {
  const stage = $('.stage');
  const resultEl = $('#rate-result');
  const choices = $('.choices');
  const SWAP_MS = 260; // keep in sync with --swap in style.css
  let nameEl = $('#rate-name');
  let item = null;
  let upcoming = null; // promise of the next /api/next response, fetched ahead
  let busy = false;
  let loaded = false;

  const fetchNext = (exclude) => api('/api/next?exclude=' + exclude.filter(Boolean).join(','));

  function size(el = nameEl) {
    if (current !== 'rate') return;
    fit(el, { maxH: innerHeight * 0.42, max: Math.min(320, Math.max(innerWidth * 0.2, 120)) });
  }

  function label(data) {
    return data.item ? data.item.name : data.error ? 'Hold on.' : 'Nothing here yet.';
  }

  function note(text) {
    resultEl.textContent = '';
    if (!text) return;
    const p = document.createElement('p');
    p.className = 'kicker';
    p.textContent = text;
    resultEl.append(p);
  }

  function statusNote(data) {
    if (data.error) note(data.error);
    else if (data.item && !data.fresh) note('You have rated everything. Change your mind, or add something new.');
  }

  // Crowd result for the thing you just voted on. Static, so it never slows you down.
  function showResult(it) {
    resultEl.innerHTML = `
      <p class="last"><b></b> · <span class="o">${it.overPct}% overrated</span> / <span class="u">${100 - it.overPct}% underrated</span> · ${it.votes} vote${it.votes === 1 ? '' : 's'}</p>
      <div class="split"><i class="o" style="width:${it.overPct}%"></i><i class="u" style="width:${100 - it.overPct}%"></i></div>`;
    $('.last b', resultEl).textContent = it.name;
  }

  // Old name drops down and fades out while the new one drops in from above, at the same time.
  function swapTo(data) {
    const old = nameEl;
    const next = old.cloneNode(false);
    next.removeAttribute('id');
    next.textContent = label(data);
    old.removeAttribute('id');
    next.id = 'rate-name';

    const box = old.getBoundingClientRect();
    const parent = stage.getBoundingClientRect();
    old.style.position = 'absolute';
    old.style.left = box.left - parent.left + 'px';
    old.style.top = box.top - parent.top + 'px';
    old.style.width = box.width + 'px';
    old.style.margin = '0';
    old.classList.add('leave');
    old.after(next);
    nameEl = next;
    size(next);
    next.classList.add('enter');
    setTimeout(() => {
      old.remove();
      next.classList.remove('enter');
    }, SWAP_MS);
  }

  async function advance(prevId) {
    const data = await upcoming;
    item = data.item;
    swapTo(data);
    upcoming = fetchNext([item?.id, prevId]);
    return data;
  }

  async function load() {
    const data = await fetchNext([]);
    item = data.item;
    nameEl.textContent = label(data);
    statusNote(data);
    size();
    upcoming = fetchNext([item?.id]);
  }

  async function vote(dir) {
    if (busy || !item) return;
    busy = true;
    const prev = item;
    const button = $(`.choice[data-dir="${dir}"]`, choices);
    button.classList.add('picked');
    setTimeout(() => button.classList.remove('picked'), 160);
    const saved = api('/api/vote', { id: prev.id, dir });
    const data = await advance(prev.id);
    statusNote(data);
    setTimeout(() => (busy = false), SWAP_MS * 0.6);
    const res = await saved;
    if (res.error) toast(res.error);
    else if (item !== prev && !data.error) showResult(res.item);
  }

  async function skip() {
    if (busy || !item) return;
    busy = true;
    note('');
    statusNote(await advance(item.id));
    setTimeout(() => (busy = false), SWAP_MS * 0.6);
  }

  choices.addEventListener('click', (e) => {
    const b = e.target.closest('.choice');
    if (b) vote(Number(b.dataset.dir));
  });
  $('#rate-skip').addEventListener('click', skip);

  return {
    enter() {
      if (!loaded) { loaded = true; load(); } else size();
    },
    key(k) {
      if (k === 'ArrowLeft' || k === 'o') vote(1);
      else if (k === 'ArrowRight' || k === 'u') vote(-1);
      else if (k === ' ') skip();
    },
    size: () => size(),
  };
})();

/* ---------------- Duel ---------------- */
const Duel = (() => {
  const root = $('#duel');
  const grid = $('.duel-grid');
  const emptyEl = $('#duel-empty');
  const sides = { a: $('#duel-a'), b: $('#duel-b') };
  let pair = null;
  let busy = false;
  let seq = 0; // ignore responses that arrive after the question was switched
  let mode = 'over';
  try { if (localStorage.getItem('duelMode') === 'under') mode = 'under'; } catch {}

  function setMode(m, reload = true) {
    if (m !== 'over' && m !== 'under') return;
    const changed = m !== mode;
    mode = m;
    try { localStorage.setItem('duelMode', m); } catch {}
    $$('.mode-switch .mode').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    root.classList.toggle('over', m === 'over');
    root.classList.toggle('under', m === 'under');
    if (reload && changed) load();
  }

  function meta(it) {
    if (!it.votes) return 'No votes yet';
    const pct = mode === 'over' ? `${it.overPct}% say overrated` : `${100 - it.overPct}% say underrated`;
    return `${pct} · ${it.votes} vote${it.votes === 1 ? '' : 's'}`;
  }

  function size() {
    if (current !== 'duel' || !pair) return;
    const stacked = innerWidth <= 720;
    for (const s of Object.values(sides)) {
      const t = $('.thing', s);
      const cs = getComputedStyle(s);
      const w = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = stacked ? innerHeight * 0.18 : innerHeight * 0.36;
      fit(t, { maxW: w, maxH: h, max: 200 });
    }
  }

  async function load() {
    const mine = ++seq;
    const data = await api('/api/duel?mode=' + mode);
    if (mine !== seq) return;
    grid.classList.remove('done');
    Object.values(sides).forEach((s) => s.classList.remove('picked'));
    if (data.error) {
      pair = null;
      grid.hidden = true;
      $('#duel-skip').hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = data.error;
      return;
    }
    pair = data;
    grid.hidden = false;
    $('#duel-skip').hidden = false;
    emptyEl.hidden = true;
    for (const k of ['a', 'b']) {
      $('.thing', sides[k]).textContent = data[k].name;
      $('.meta', sides[k]).textContent = meta(data[k]);
    }
    size();
  }

  async function pick(k) {
    if (busy || !pair) return;
    busy = true;
    sides[k].classList.add('picked');
    grid.classList.add('done');
    const data = await api('/api/duel', { a: pair.a.id, b: pair.b.id, winner: pair[k].id, mode: pair.mode });
    if (data.error) toast(data.error);
    await load();
    busy = false;
  }

  sides.a.addEventListener('click', () => pick('a'));
  sides.b.addEventListener('click', () => pick('b'));
  $('#duel-skip').addEventListener('click', () => !busy && load());
  $$('.mode-switch .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode(mode, false);

  return {
    enter: load,
    key(k) {
      if (k === 'ArrowLeft' || k === 'ArrowUp') pick('a');
      else if (k === 'ArrowRight' || k === 'ArrowDown') pick('b');
      else if (k === 'o') setMode('over');
      else if (k === 'u') setMode('under');
      else if (k === ' ') $('#duel-skip').click();
    },
    size,
  };
})();

/* ---------------- Top ---------------- */
const Top = (() => {
  let which = 'overrated';
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function render(list, el, kind) {
    if (!list.length) {
      el.innerHTML = '<li class="none">Nothing yet. Go rate some things.</li>';
      return;
    }
    el.innerHTML = list.map((it, i) => {
      const pct = kind === 'overrated' ? it.overPct : 100 - it.overPct;
      return `<li>
        <span class="n">${i + 1}</span>
        <span class="name">${esc(it.name)}</span>
        <span class="pct"><b>${pct}%</b><small>${it.votes} vote${it.votes === 1 ? '' : 's'}</small></span>
      </li>`;
    }).join('');
  }

  function select(w) {
    which = w;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.list === w)));
    $('#list-overrated').hidden = w !== 'overrated';
    $('#list-underrated').hidden = w !== 'underrated';
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => select(t.dataset.list)));

  return {
    async enter() {
      select(which);
      const data = await api('/api/top');
      render(data.overrated || [], $('#list-overrated'), 'overrated');
      render(data.underrated || [], $('#list-underrated'), 'underrated');
      $('#top-foot').textContent = data.error || `${data.total} things so far. Ranked by votes, fine-tuned by head-to-head duels.`;
    },
    key(k) {
      if (k === 'ArrowLeft') select('overrated');
      else if (k === 'ArrowRight') select('underrated');
    },
  };
})();

/* ---------------- Add ---------------- */
const Add = (() => {
  const form = $('#add-form');
  const input = $('#add-input');
  const msg = $('#add-msg');
  const defaultHint = msg.textContent;
  const ideas = ['Anything.', 'Mondays.', 'Cilantro.', 'Jazz.', 'Airports.', 'Tote bags.', 'Lasagna.', 'Rain.'];
  let n = 0;
  setInterval(() => {
    if (current === 'add' && !input.value) input.placeholder = ideas[++n % ideas.length];
  }, 2200);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('.go', form);
    btn.disabled = true;
    const data = await api('/api/items', { name: input.value });
    btn.disabled = false;
    if (data.error) {
      msg.textContent = data.error;
      msg.classList.add('error');
      return;
    }
    msg.classList.remove('error');
    msg.textContent = defaultHint;
    input.value = '';
    toast(data.existed ? `“${data.item.name}” is already here. Now it’s up for rating.` : `Added “${data.item.name}”.`);
    input.focus();
  });
  input.addEventListener('input', () => {
    if (msg.classList.contains('error')) { msg.classList.remove('error'); msg.textContent = defaultHint; }
  });

  return { enter() { setTimeout(() => input.focus(), 30); }, key() {} };
})();

/* ---------------- Keys & resize ---------------- */
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const handler = { rate: Rate, duel: Duel, top: Top, add: Add }[current];
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'o', 'u'].includes(e.key)) {
    if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
    handler.key(e.key);
  }
});

let resizeRaf;
addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { Rate.size(); Duel.size(); });
});
document.fonts?.ready.then(() => { Rate.size(); Duel.size(); });

show(viewFromPath(location.pathname), false);
