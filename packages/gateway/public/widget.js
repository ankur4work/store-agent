/**
 * StoreAgent widget.
 *
 * Implements the rules in docs/EXPERIENCE-CONTRACT.md that are the widget's to
 * keep:
 *   - launcher occupies a fixed reserved box from first paint  → CLS 0
 *   - panel chunk is prefetched on hover, so opening is instant
 *   - streaming text is flushed on requestAnimationFrame, never per token
 *     (per-token DOM writes are the classic INP failure in chat UIs)
 *   - product cards render from the FIRST tool result, seconds before prose
 *   - transform/opacity only; honours prefers-reduced-motion
 *   - composer never blocks; a new message interrupts rather than queues
 *   - Shadow DOM so merchant CSS cannot reach in, and ours cannot leak out
 *
 * Vanilla rather than a framework: this is a panel and a list. Preact would
 * cost 4KB and buy nothing yet.
 */
(function () {
  'use strict';

  var API = (document.currentScript && document.currentScript.dataset.api) || '';
  var STORAGE_KEY = 'storeagent.session';
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // --- session survives navigation (EXPERIENCE-CONTRACT §2) ---------------
  var state = { open: false, sessionId: null, busy: false, messages: [], draft: '' };
  try {
    var saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) state = Object.assign(state, JSON.parse(saved), { busy: false });
  } catch (e) { /* private mode — degrade to a fresh session */ }

  function persist() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          open: state.open,
          sessionId: state.sessionId,
          messages: state.messages.slice(-30),
          draft: els.input ? els.input.value : '',
        })
      );
    } catch (e) {}
  }

  var host = document.createElement('div');
  host.id = 'storeagent-root';
  host.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  var els = {};

  var CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:var(--sa-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
.launcher{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;
  border:0;cursor:pointer;background:var(--sa-accent,#1f3a3d);color:#fff;display:grid;place-items:center;
  box-shadow:0 6px 24px rgba(0,0,0,.22);transition:transform .18s cubic-bezier(.32,.72,0,1);
  padding-bottom:env(safe-area-inset-bottom,0)}
.launcher:hover{transform:scale(1.06)}
.launcher:focus-visible{outline:3px solid #fff;outline-offset:3px}
.launcher.hidden{transform:translateY(120px)}
.panel{position:fixed;right:20px;bottom:88px;width:396px;height:min(620px,calc(100vh - 120px));
  background:var(--sa-bg,#fff);color:var(--sa-fg,#16181a);border-radius:16px;display:flex;flex-direction:column;
  overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.28);opacity:0;transform:translateY(8px) scale(.99);
  transition:opacity .18s ease,transform .18s cubic-bezier(.32,.72,0,1);contain:layout paint}
.panel.show{opacity:1;transform:none}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.08);flex:0 0 auto}
header b{font-size:15px;font-weight:600}
header .status{font-size:12px;opacity:.6;margin-left:auto}
header button{background:none;border:0;cursor:pointer;font-size:20px;line-height:1;opacity:.55;padding:4px}
header button:hover{opacity:1}
.log{flex:1 1 auto;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.msg{max-width:88%;padding:10px 13px;border-radius:14px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
.msg.user{align-self:flex-end;background:var(--sa-accent,#1f3a3d);color:#fff;border-bottom-right-radius:5px}
.msg.bot{align-self:flex-start;background:rgba(0,0,0,.05);border-bottom-left-radius:5px}
.msg.bot.thinking::after{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;
  background:currentColor;opacity:.45;margin-left:3px;animation:pulse 1.1s infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:.7}}
.cards{display:flex;gap:10px;overflow-x:auto;padding:2px 16px 12px;scroll-snap-type:x mandatory;flex:0 0 auto}
.cards::-webkit-scrollbar{height:0}
.card{flex:0 0 148px;scroll-snap-align:start;border:1px solid rgba(0,0,0,.1);border-radius:12px;overflow:hidden;background:#fff}
.card img{width:100%;height:150px;object-fit:cover;display:block;background:rgba(0,0,0,.06)}
.card .b{padding:8px 9px}
.card .t{font-size:12.5px;font-weight:600;line-height:1.3;margin-bottom:3px}
.card .p{font-size:12.5px;opacity:.75}
.card.skeleton .t,.card.skeleton .p{background:rgba(0,0,0,.08);color:transparent;border-radius:4px}
.card.skeleton img{background:rgba(0,0,0,.08)}
.chips{display:flex;gap:7px;flex-wrap:wrap;padding:0 16px 12px;flex:0 0 auto}
.chip{border:1px solid rgba(0,0,0,.16);background:none;border-radius:999px;padding:7px 12px;font-size:12.5px;cursor:pointer}
.chip:hover{background:rgba(0,0,0,.05)}
form{display:flex;gap:8px;padding:12px 14px;border-top:1px solid rgba(0,0,0,.08);flex:0 0 auto}
input{flex:1;border:1px solid rgba(0,0,0,.16);border-radius:10px;padding:11px 13px;font-size:14.5px;min-width:0}
input:focus{outline:2px solid var(--sa-accent,#1f3a3d);outline-offset:-1px}
form button{border:0;border-radius:10px;padding:0 15px;background:var(--sa-accent,#1f3a3d);color:#fff;cursor:pointer;font-size:14px}
form button:disabled{opacity:.4;cursor:default}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:520px){
  .panel{right:0;left:0;bottom:0;width:100%;height:85vh;border-radius:16px 16px 0 0;
    padding-bottom:env(safe-area-inset-bottom,0)}
  .launcher{right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0))}
}
@media (prefers-color-scheme:dark){
  .panel{--sa-bg:#16181a;--sa-fg:#eceff1}
  .msg.bot{background:rgba(255,255,255,.09)}
  .card{background:#1d2022;border-color:rgba(255,255,255,.12)}
  input{background:#1d2022;color:inherit;border-color:rgba(255,255,255,.16)}
  header,form{border-color:rgba(255,255,255,.1)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

  var style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  // --- launcher: fixed reserved box, present from first paint -------------
  var launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', 'Open shopping assistant');
  launcher.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>';
  launcher.addEventListener('click', toggle);
  // Prefetch nothing over the network here — the panel is built locally, so
  // "prefetch on hover" is simply building the DOM before it is needed.
  launcher.addEventListener('pointerenter', buildPanel, { once: true });
  root.appendChild(launcher);

  // Auto-hide on scroll-down so the launcher never sits over Add to Cart.
  var lastY = scrollY;
  addEventListener(
    'scroll',
    function () {
      if (state.open) return;
      var down = scrollY > lastY && scrollY > 200;
      launcher.classList.toggle('hidden', down);
      lastY = scrollY;
    },
    { passive: true }
  );

  function buildPanel() {
    if (els.panel) return;
    var p = document.createElement('div');
    p.className = 'panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Shopping assistant');
    p.innerHTML =
      '<header><b>Assistant</b><span class="status"></span>' +
      '<button aria-label="Close">&times;</button></header>' +
      '<div class="log" aria-live="polite" aria-atomic="false"></div>' +
      '<div class="cards" hidden></div>' +
      '<div class="chips"></div>' +
      '<form><input type="text" placeholder="Ask about sizing, shipping, anything…" ' +
      'autocomplete="off" aria-label="Message"><button type="submit">Send</button></form>';

    els.panel = p;
    els.log = p.querySelector('.log');
    els.cards = p.querySelector('.cards');
    els.chips = p.querySelector('.chips');
    els.status = p.querySelector('.status');
    els.form = p.querySelector('form');
    els.input = p.querySelector('input');

    p.querySelector('header button').addEventListener('click', close);
    els.form.addEventListener('submit', onSubmit);
    els.input.addEventListener('input', persist);
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    root.appendChild(p);
    els.input.value = state.draft || '';
    state.messages.forEach(function (m) {
      addMessage(m.role, m.text);
    });
    if (state.messages.length === 0) renderChips();
  }

  function renderChips() {
    var page = detectPage();
    var sets = {
      product: ['Will this fit me?', 'When does it arrive?', 'Show me similar'],
      collection: ['Help me choose', "What's most popular?", 'Under $100'],
      cart: ['Shipping cost?', 'Return policy', "Anything I'm missing?"],
      other: ['What do you sell?', 'Shipping & returns', 'Help me choose'],
    };
    (sets[page.type] || sets.other).forEach(function (label) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', function () {
        els.input.value = label;
        onSubmit(new Event('submit'));
      });
      els.chips.appendChild(b);
    });
  }

  function toggle() {
    state.open ? close() : open();
  }

  function open() {
    buildPanel();
    state.open = true;
    launcher.classList.add('hidden');
    // Force a frame so the transition runs from the initial state.
    requestAnimationFrame(function () {
      els.panel.classList.add('show');
      els.input.focus();
    });
    persist();
  }

  function close() {
    state.open = false;
    if (els.panel) els.panel.classList.remove('show');
    launcher.classList.remove('hidden');
    launcher.focus();
    persist();
  }

  function detectPage() {
    var p = location.pathname;
    if (/\/products\//.test(p)) return { type: 'product', title: document.title };
    if (/\/collections\//.test(p)) return { type: 'collection', title: document.title };
    if (/\/cart/.test(p)) return { type: 'cart' };
    return { type: 'other', title: document.title };
  }

  function addMessage(role, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text || '';
    els.log.appendChild(d);
    els.log.scrollTop = els.log.scrollHeight;
    return d;
  }

  function renderProducts(products) {
    els.cards.hidden = false;
    els.cards.innerHTML = '';
    products.slice(0, 8).forEach(function (p) {
      var min = p.price_range && p.price_range.min ? p.price_range.min.amount : null;
      var c = document.createElement('div');
      c.className = 'card';
      c.innerHTML =
        '<img alt="" loading="lazy" width="148" height="150" src="' +
        (p.image || '') +
        '"><div class="b"><div class="t"></div><div class="p"></div></div>';
      c.querySelector('.t').textContent = p.title || '';
      c.querySelector('.p').textContent = min == null ? '' : '$' + (min / 100).toFixed(2);
      els.cards.appendChild(c);
    });
  }

  function renderSkeletons(n) {
    els.cards.hidden = false;
    els.cards.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var c = document.createElement('div');
      c.className = 'card skeleton';
      c.innerHTML = '<img alt="" width="148" height="150"><div class="b"><div class="t">&nbsp;</div><div class="p">&nbsp;</div></div>';
      els.cards.appendChild(c);
    }
  }

  var inflight = null;

  function onSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    var text = els.input.value.trim();
    if (!text) return;

    // A new message INTERRUPTS rather than queues (EXPERIENCE-CONTRACT §1).
    if (inflight) inflight.abort();

    els.chips.innerHTML = '';
    els.input.value = '';
    addMessage('user', text);
    state.messages.push({ role: 'user', text: text });
    persist();
    send(text);
  }

  function send(text) {
    var bubble = addMessage('bot', '');
    bubble.classList.add('thinking');
    els.status.textContent = 'thinking…';
    renderSkeletons(3);

    var ctl = new AbortController();
    inflight = ctl;

    // rAF batching: deltas accumulate into `pending` and are written to the
    // DOM once per frame. Writing per token is what wrecks INP.
    var shown = '';
    var pending = '';
    var scheduled = false;
    function flush() {
      scheduled = false;
      if (!pending) return;
      shown += pending;
      pending = '';
      bubble.classList.remove('thinking');
      bubble.textContent = shown;
      els.log.scrollTop = els.log.scrollHeight;
    }
    function schedule() {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    }

    fetch(API + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        message: text,
        sessionId: state.sessionId,
        page: detectPage(),
      }),
    })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('http ' + res.status);
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
              handleEvent(buf.slice(0, i));
              buf = buf.slice(i + 2);
            }
            return pump();
          });
        }

        function handleEvent(record) {
          var ev = '';
          var data = '';
          record.split('\n').forEach(function (line) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          if (!data) return;
          var payload;
          try {
            payload = JSON.parse(data);
          } catch (err) {
            return;
          }

          if (ev === 'session') {
            state.sessionId = payload.sessionId;
            persist();
          } else if (ev === 'products') {
            renderProducts(payload.products);
          } else if (ev === 'delta') {
            pending += payload.text;
            schedule();
          } else if (ev === 'reset') {
            // The grounding tripwire killed a partial answer. Discard it —
            // the shopper must never keep a half-written unverified claim.
            shown = '';
            pending = '';
            bubble.textContent = '';
            bubble.classList.add('thinking');
          } else if (ev === 'done') {
            flush();
            if (shown !== payload.reply) {
              bubble.textContent = payload.reply;
              shown = payload.reply;
            }
            bubble.classList.remove('thinking');
            state.messages.push({ role: 'bot', text: payload.reply });
            els.status.textContent = payload.grounded ? '' : 'needs a human';
            persist();
          } else if (ev === 'error') {
            flush();
            bubble.classList.remove('thinking');
            bubble.textContent = payload.message;
          }
        }

        return pump();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        bubble.classList.remove('thinking');
        // No dead ends, even on a network failure.
        bubble.textContent =
          "I couldn't reach our systems just then. Try again, or leave an email and we'll follow up.";
      })
      .finally(function () {
        if (inflight === ctl) inflight = null;
        els.status.textContent = '';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(host);
    // Restore an open panel across a full page navigation — on a standard
    // Shopify theme every click is a reload, and a widget that forgets you
    // between pages is worse than no widget (EXPERIENCE-CONTRACT §2).
    if (state.open) open();
  });
  if (document.readyState !== 'loading') {
    document.body.appendChild(host);
    if (state.open) open();
  }
})();
