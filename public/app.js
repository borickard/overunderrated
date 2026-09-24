'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
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
  const nameEl = $('#rate-name');
  const resultEl = $('#rate-result');
  const choices = $('.choices');
  let item = null;
  let busy = false;
  let loaded = false;

  function size() {
    if (current !== 'rate') return;
    fit(nameEl, { maxH: innerHeight * 0.42, max: Math.min(320, Math.max(innerWidth * 0.2, 120)) });
  }

  async function load(exclude) {
    const data = await api('/api/next' + (exclude ? `?exclude=${exclude}` : ''));
    item = data.item;
    nameEl.classList.add('in');
    nameEl.textContent = item ? item.name : 'Nothing here yet.';
    resultEl.innerHTML = item && !data.fresh
      ? '<p class="kicker">You have rated everything. Change your mind, or add something new.</p>'
      : '';
    choices.classList.remove('voted');
    $$('.choice', choices).forEach((b) => b.classList.remove('picked'));
    size();
    requestAnimationFrame(() => requestAnimationFrame(() => nameEl.classList.remove('in')));
  }

  async function advance(exclude) {
    nameEl.classList.add('out');
    await sleep(180);
    nameEl.classList.remove('out');
    await load(exclude);
  }

  async function vote(dir) {
    if (busy || !item) return;
    busy = true;
    choices.classList.add('voted');
    $(`.choice[data-dir="${dir}"]`, choices).classList.add('picked');
    const data = await api('/api/vote', { id: item.id, dir });
    if (data.error) {
      toast(data.error);
      choices.classList.remove('voted');
      busy = false;
      return;
    }
    const it = data.item;
    const agree = dir === 1 ? it.overPct : 100 - it.overPct;
    resultEl.innerHTML = `
      <div class="split"><i class="o" style="width:50%"></i><i class="u" style="width:50%"></i></div>
      <div class="split-labels"><span class="o">${it.overPct}% overrated</span><span class="u">${100 - it.overPct}% underrated</span></div>`;
    requestAnimationFrame(() => {
      $('.split .o', resultEl).style.width = it.overPct + '%';
      $('.split .u', resultEl).style.width = 100 - it.overPct + '%';
    });
    if (it.votes > 1) toast(`${agree}% agree with you · ${it.votes} votes`);
    await sleep(1100);
    await advance(item.id);
    busy = false;
  }

  choices.addEventListener('click', (e) => {
    const b = e.target.closest('.choice');
    if (b) vote(Number(b.dataset.dir));
  });
  $('#rate-skip').addEventListener('click', () => !busy && item && advance(item.id));

  return {
    enter() {
      if (!loaded) { loaded = true; load(); } else size();
    },
    key(k) {
      if (k === 'ArrowLeft' || k === 'o') vote(1);
      else if (k === 'ArrowRight' || k === 'u') vote(-1);
      else if (k === ' ') $('#rate-skip').click();
    },
    size,
  };
})();

/* ---------------- Duel ---------------- */
const Duel = (() => {
  const root = $('#duel');
  const grid = $('.duel-grid');
  const modeEl = $('#duel-mode');
  const emptyEl = $('#duel-empty');
  const sides = { a: $('#duel-a'), b: $('#duel-b') };
  let pair = null;
  let busy = false;

  function meta(it) {
    return it.votes ? `${it.overPct}% say overrated · ${it.votes} vote${it.votes === 1 ? '' : 's'}` : 'No votes yet';
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
    const data = await api('/api/duel');
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
    root.classList.toggle('over', data.mode === 'over');
    root.classList.toggle('under', data.mode === 'under');
    modeEl.className = 'mode ' + data.mode;
    modeEl.textContent = data.mode === 'over' ? 'overrated' : 'underrated';
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
    await sleep(650);
    await load();
    busy = false;
  }

  sides.a.addEventListener('click', () => pick('a'));
  sides.b.addEventListener('click', () => pick('b'));
  $('#duel-skip').addEventListener('click', () => !busy && load());

  return {
    enter: load,
    key(k) {
      if (k === 'ArrowLeft' || k === 'ArrowUp') pick('a');
      else if (k === 'ArrowRight' || k === 'ArrowDown') pick('b');
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
      return `<li style="animation-delay:${Math.min(i, 12) * 30}ms">
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
      $('#top-foot').textContent = `${data.total} things so far. Ranked by votes, fine-tuned by head-to-head duels.`;
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
