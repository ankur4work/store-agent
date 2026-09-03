/**
 * StoreAgent widget.
 *
 * ## Design position
 *
 * An embedded widget cannot have its own visual identity — merchant brand
 * tokens override our colours, and it must look like it belongs inside
 * whatever store it lands in. So the craft has to live in the things that
 * survive re-skinning:
 *
 *   - **Products are the hero.** Most assistants bury results in chat bubbles.
 *     Here cards are large, image-forward, and appear BEFORE the prose — they
 *     arrive in ~44ms off the speculative search while the model is still
 *     thinking.
 *   - **The panel is physically connected to the launcher.** It scales out of
 *     the launcher's corner rather than teleporting in, so the two read as one
 *     object.
 *   - **Staggered reveal.** Cards and messages enter on a small cascade. It
 *     costs nothing and is the difference between "rendered" and "composed".
 *   - **Every state is designed** — first open, thinking, empty results,
 *     offline, error. There are no spinners; a spinner says "waiting",
 *     a skeleton says "arriving".
 *
 * ## Rules it must keep (docs/EXPERIENCE-CONTRACT.md)
 *
 *   - fixed reserved launcher box from first paint → CLS 0
 *   - streaming text flushed on rAF, never per token (INP)
 *   - transform/opacity only; prefers-reduced-motion fully honoured
 *   - composer never blocks; a new message interrupts rather than queues
 *   - session survives navigation (every Shopify theme click is a reload)
 *   - Shadow DOM both ways: merchant CSS can't reach in, ours can't leak out
 */
(function () {
  'use strict';

  // Captured during initial script execution — `document.currentScript` is
  // null by the time any async callback runs.
  var SCRIPT = document.currentScript;
  var API = (SCRIPT && SCRIPT.dataset.api) || '';
  var SHOP =
    (SCRIPT && SCRIPT.dataset.shop) ||
    (window.Shopify && window.Shopify.shop) ||
    location.hostname;
  var KEY = 'storeagent.session';

  var state = { open: false, sessionId: null, messages: [], draft: '', products: [] };
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved) state = Object.assign(state, JSON.parse(saved));
  } catch (e) {}

  var els = {};
  function persist() {
    try {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({
          open: state.open,
          sessionId: state.sessionId,
          messages: state.messages.slice(-30),
          products: state.products.slice(0, 8),
          draft: els.input ? els.input.value : '',
        })
      );
    } catch (e) {}
  }

  var host = document.createElement('div');
  host.id = 'storeagent-root';
  var root = host.attachShadow({ mode: 'open' });

  var CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;font-family:var(--sa-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
:host{
  --accent:var(--sa-accent,#1b3a34);
  --paper:var(--sa-bg,#fffefb);
  --ink:var(--sa-fg,#14161a);
  --muted:color-mix(in srgb,var(--ink) 55%,transparent);
  --line:color-mix(in srgb,var(--ink) 11%,transparent);
  --sunk:color-mix(in srgb,var(--ink) 5%,transparent);
  --r:var(--sa-radius,16px);
  --ease:cubic-bezier(.22,1,.36,1);
}

/* ---------- launcher: fixed reserved box, present from first paint ------- */
.launcher{
  position:fixed;right:22px;bottom:22px;width:56px;height:56px;border:0;padding:0;cursor:pointer;
  border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;
  box-shadow:0 2px 6px rgba(0,0,0,.12),0 12px 32px -8px color-mix(in srgb,var(--accent) 55%,transparent);
  transition:transform .32s var(--ease),box-shadow .32s var(--ease),opacity .2s linear;
  margin-bottom:env(safe-area-inset-bottom,0px);
}
.launcher:hover{transform:translateY(-2px) scale(1.04);
  box-shadow:0 4px 10px rgba(0,0,0,.14),0 18px 44px -10px color-mix(in srgb,var(--accent) 65%,transparent)}
.launcher:active{transform:scale(.96);transition-duration:.09s}
.launcher:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.launcher.away{transform:translateY(96px) scale(.9);opacity:0;pointer-events:none}
.launcher .mark{transition:transform .4s var(--ease)}
.launcher:hover .mark{transform:rotate(-8deg)}
/* one-time attention pulse, never a loop */
.launcher.nudge::after{content:'';position:absolute;inset:-3px;border-radius:50%;
  border:2px solid var(--accent);opacity:0;animation:ring 1.6s var(--ease) 2}
@keyframes ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.35)}}

/* ---------- panel: scales out of the launcher, not teleported ------------ */
.panel{
  position:fixed;right:22px;bottom:22px;width:404px;height:min(640px,calc(100dvh - 44px));
  background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:var(--r);
  display:flex;flex-direction:column;overflow:hidden;contain:layout paint;
  box-shadow:0 1px 2px rgba(0,0,0,.06),0 24px 70px -18px rgba(0,0,0,.35);
  transform-origin:100% 100%;
  opacity:0;transform:scale(.92) translateY(12px);pointer-events:none;
  transition:opacity .2s linear,transform .38s var(--ease);
}
.panel.show{opacity:1;transform:none;pointer-events:auto}

header{
  display:flex;align-items:center;gap:11px;padding:15px 16px;flex:0 0 auto;
  border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 86%,transparent);
  backdrop-filter:saturate(1.4) blur(8px);position:relative;z-index:2}
.avatar{width:30px;height:30px;border-radius:9px;background:var(--accent);color:#fff;
  display:grid;place-items:center;flex:0 0 auto}
.who{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.who b{font-size:14px;font-weight:600;letter-spacing:-.01em}
.who span{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
header .x{margin-left:auto;background:none;border:0;cursor:pointer;color:var(--muted);
  width:30px;height:30px;border-radius:8px;display:grid;place-items:center;transition:background .16s,color .16s}
header .x:hover{background:var(--sunk);color:var(--ink)}

.scroll{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.scroll::-webkit-scrollbar{width:9px}
.scroll::-webkit-scrollbar-thumb{background:var(--line);border-radius:9px;border:3px solid var(--paper)}

/* ---------- opening state ------------------------------------------------ */
.intro{padding:26px 20px 8px}
.intro h2{font-size:19px;font-weight:600;letter-spacing:-.02em;line-height:1.3;margin-bottom:5px}
.intro p{font-size:13.5px;color:var(--muted);line-height:1.55}

/* ---------- messages ----------------------------------------------------- */
.log{display:flex;flex-direction:column;gap:10px;padding:16px 16px 4px}
.msg{max-width:87%;padding:10px 13px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;
  word-wrap:break-word;border-radius:14px;animation:rise .34s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:5px}
.msg.bot{align-self:flex-start;background:var(--sunk);border-bottom-left-radius:5px}
.dots{display:inline-flex;gap:4px;padding:3px 1px}
.dots i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.3;
  animation:blink 1.25s infinite var(--ease)}
.dots i:nth-child(2){animation-delay:.16s}.dots i:nth-child(3){animation-delay:.32s}
@keyframes blink{0%,100%{opacity:.22;transform:translateY(0)}45%{opacity:.75;transform:translateY(-2px)}}

/* ---------- products: the hero, not an afterthought ---------------------- */
.rail{padding:12px 16px 4px}
.rail h3{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);margin-bottom:9px}
.cards{display:flex;gap:11px;overflow-x:auto;scroll-snap-type:x mandatory;
  padding-bottom:6px;scrollbar-width:none}
.cards::-webkit-scrollbar{display:none}
.card{flex:0 0 156px;scroll-snap-align:start;border:1px solid var(--line);border-radius:13px;
  overflow:hidden;background:var(--paper);cursor:pointer;text-align:left;padding:0;
  animation:pop .42s var(--ease) both;transition:transform .22s var(--ease),box-shadow .22s var(--ease),border-color .22s}
@keyframes pop{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:none}}
.card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--accent) 35%,transparent);
  box-shadow:0 10px 26px -12px rgba(0,0,0,.3)}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card .ph{position:relative;aspect-ratio:4/5;background:var(--sunk);overflow:hidden}
.card img{width:100%;height:100%;object-fit:cover;display:block;
  transition:transform .5s var(--ease);opacity:0;animation:fade .4s .05s forwards}
@keyframes fade{to{opacity:1}}
.card:hover img{transform:scale(1.04)}
.pill{position:absolute;left:8px;bottom:8px;font-size:10.5px;font-weight:600;letter-spacing:.02em;
  padding:3px 7px;border-radius:999px;background:rgba(255,255,255,.94);color:#14161a;
  box-shadow:0 1px 3px rgba(0,0,0,.18)}
.pill.out{background:rgba(28,28,30,.9);color:#fff}
.card .meta{padding:9px 10px 11px}
.card .t{font-size:12.5px;font-weight:600;line-height:1.35;letter-spacing:-.01em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card .p{font-size:12.5px;color:var(--muted);margin-top:3px;font-variant-numeric:tabular-nums}
.card.skel{pointer-events:none}
.card.skel .ph,.card.skel .t,.card.skel .p{
  background:linear-gradient(100deg,var(--sunk) 30%,color-mix(in srgb,var(--ink) 9%,transparent) 50%,var(--sunk) 70%);
  background-size:220% 100%;animation:shimmer 1.3s infinite linear}
.card.skel .t,.card.skel .p{color:transparent;border-radius:5px;height:11px;margin-top:5px}
.card.skel .t{width:82%}.card.skel .p{width:44%}
@keyframes shimmer{to{background-position:-220% 0}}

/* ---------- chips -------------------------------------------------------- */
.chips{display:flex;gap:7px;flex-wrap:wrap;padding:14px 16px 4px}
.chip{border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:999px;
  padding:8px 13px;font-size:12.5px;cursor:pointer;line-height:1;
  animation:rise .36s var(--ease) both;transition:background .16s,border-color .16s,transform .16s var(--ease)}
.chip:hover{background:var(--sunk);border-color:color-mix(in srgb,var(--accent) 30%,transparent);transform:translateY(-1px)}
.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ---------- composer ----------------------------------------------------- */
form{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;flex:0 0 auto;
  border-top:1px solid var(--line);background:var(--paper);
  padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
.field{flex:1;display:flex;align-items:center;background:var(--sunk);border:1px solid transparent;
  border-radius:12px;transition:border-color .18s,background .18s}
.field:focus-within{border-color:color-mix(in srgb,var(--accent) 45%,transparent);background:var(--paper)}
textarea{flex:1;border:0;background:none;color:inherit;resize:none;outline:none;
  font-size:14.5px;line-height:1.45;padding:11px 13px;max-height:104px;min-height:42px}
textarea::placeholder{color:var(--muted)}
.send{width:42px;height:42px;flex:0 0 auto;border:0;border-radius:12px;cursor:pointer;
  background:var(--accent);color:#fff;display:grid;place-items:center;
  transition:transform .18s var(--ease),opacity .18s}
.send:disabled{opacity:.32;cursor:default}
.send:not(:disabled):hover{transform:translateY(-1px) scale(1.03)}
.send:not(:disabled):active{transform:scale(.94)}
.send:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mic{width:42px;height:42px;flex:0 0 auto;border:1px solid var(--line);border-radius:12px;cursor:pointer;
  background:var(--paper);color:var(--ink);display:grid;place-items:center;position:relative;
  transition:background .18s,border-color .18s,transform .18s var(--ease),color .18s}
.mic:hover{background:var(--sunk)}
.mic:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mic[data-state=listening]{background:var(--accent);color:#fff;border-color:var(--accent)}
.mic[data-state=listening]::after{content:'';position:absolute;inset:-4px;border-radius:14px;
  border:2px solid var(--accent);opacity:.45;animation:ring 1.4s var(--ease) infinite}
.mic[data-state=speaking]{color:var(--accent);border-color:var(--accent)}
.mic[data-state=thinking]{opacity:.55}
.voicebar{display:none;align-items:center;gap:9px;padding:9px 16px 0;font-size:12.5px;color:var(--muted)}
.voicebar.on{display:flex}
.voicebar .live{flex:1;color:var(--ink);font-style:italic}
.voicebar button{background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;
  text-decoration:underline;padding:0}

.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* merchant-configurable side */
:host([data-position=left]) .launcher{right:auto;left:22px}
:host([data-position=left]) .panel{right:auto;left:22px;transform-origin:0 100%}

@media (max-width:540px){
  .panel{right:0;left:0;bottom:0;width:100%;height:88dvh;border-radius:20px 20px 0 0;
    transform-origin:50% 100%}
  .launcher{right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}
  .card{flex-basis:142px}
}
@media (prefers-color-scheme:dark){
  :host{--paper:var(--sa-bg,#141619);--ink:var(--sa-fg,#eef1f3);
    --accent:var(--sa-accent,#4a9d8e)}
  .pill{background:rgba(255,255,255,.92)}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition-duration:.01ms!important}
}
`;

  var st = document.createElement('style');
  st.textContent = CSS;
  root.appendChild(st);

  // ---------- launcher ----------------------------------------------------
  var launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', 'Open shopping assistant');
  launcher.innerHTML =
    '<svg class="mark" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20 11.5c0 4.3-3.8 7.8-8.5 7.8-1.2 0-2.4-.2-3.4-.6L4 20l1.4-3.6C4.3 15.1 3.5 13.4 3.5 11.5 3.5 7.2 7.3 3.7 12 3.7s8 3.5 8 7.8z"/>' +
    '<path d="M9.2 10.8l1.5 1.5 3.4-3.4"/></svg>';
  launcher.addEventListener('click', toggle);
  launcher.addEventListener('pointerenter', build, { once: true });
  root.appendChild(launcher);

  var lastY = 0;
  addEventListener(
    'scroll',
    function () {
      if (state.open) return;
      launcher.classList.toggle('away', scrollY > lastY && scrollY > 240);
      lastY = scrollY;
    },
    { passive: true }
  );

  // ---------- panel -------------------------------------------------------
  function build() {
    if (els.panel) return;
    var p = document.createElement('div');
    p.className = 'panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-modal', 'false');
    p.setAttribute('aria-label', 'Shopping assistant');
    p.innerHTML =
      '<header>' +
      '<div class="avatar"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/></svg></div>' +
      '<div class="who"><b>Assistant</b><span class="status">Ready</span></div>' +
      '<button class="x" aria-label="Close"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>' +
      '</header>' +
      '<div class="scroll">' +
      '<div class="intro"><h2></h2><p></p></div>' +
      '<div class="rail" hidden><h3></h3><div class="cards"></div></div>' +
      '<div class="log" aria-live="polite"></div>' +
      '<div class="chips"></div>' +
      '</div>' +
      '<div class="voicebar"><span class="live">Listening…</span>' +
      '<button type="button" class="voiceoff">Stop voice</button></div>' +
      '<form><div class="field"><textarea rows="1" placeholder="Ask about fit, shipping, anything…" aria-label="Message"></textarea></div>' +
      '<button class="mic" type="button" aria-label="Talk instead of typing">' +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>' +
      '</button>' +
      '<button class="send" type="submit" aria-label="Send" disabled>' +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>' +
      '</button></form>';

    els.panel = p;
    els.scroll = p.querySelector('.scroll');
    els.intro = p.querySelector('.intro');
    els.rail = p.querySelector('.rail');
    els.railTitle = p.querySelector('.rail h3');
    els.cards = p.querySelector('.cards');
    els.log = p.querySelector('.log');
    els.chips = p.querySelector('.chips');
    els.status = p.querySelector('.status');
    els.form = p.querySelector('form');
    els.input = p.querySelector('textarea');
    els.send = p.querySelector('.send');
    els.mic = p.querySelector('.mic');
    els.voicebar = p.querySelector('.voicebar');
    els.live = p.querySelector('.voicebar .live');

    els.mic.addEventListener('click', toggleVoice);
    p.querySelector('.voiceoff').addEventListener('click', function () { stopVoice(true); });
    p.querySelector('.x').addEventListener('click', close);
    els.form.addEventListener('submit', submit);
    els.input.addEventListener('input', grow);
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit(e);
      }
    });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    root.appendChild(p);
    hydrate();
  }

  function hydrate() {
    var page = detectPage();
    var intro = {
      product: ['Questions about this piece?', 'I can check fit, materials, stock and delivery — all from live store data.'],
      collection: ['Looking for something?', 'Tell me what you need and I’ll pull the right pieces from the collection.'],
      cart: ['Anything before checkout?', 'I can confirm shipping, returns, or whether anything’s missing.'],
      other: ['What can I help you find?', 'Ask me anything about the products, shipping, or returns.'],
    }[page.type];
    els.intro.querySelector('h2').textContent = intro[0];
    els.intro.querySelector('p').textContent = intro[1];

    els.input.value = state.draft || '';
    grow();

    if (state.products.length) renderCards(state.products, 'Mentioned earlier');
    state.messages.forEach(function (m) {
      addMsg(m.role, m.text, true);
    });
    if (!state.messages.length) chips(page);
    else els.intro.hidden = true;
  }

  function chips(page) {
    var sets = {
      product: ['Will this fit me?', 'When would it arrive?', 'Show me similar'],
      collection: ['Help me choose', 'What’s most popular?', 'Under $100'],
      cart: ['Shipping cost?', 'Return policy', 'Anything I’m missing?'],
      other: ['What do you sell?', 'Shipping & returns', 'Help me choose'],
    };
    els.chips.innerHTML = '';
    (sets[page.type] || sets.other).forEach(function (label, i) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = label;
      b.style.animationDelay = 60 + i * 55 + 'ms';
      b.addEventListener('click', function () {
        els.input.value = label;
        submit();
      });
      els.chips.appendChild(b);
    });
  }

  function grow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 104) + 'px';
    els.send.disabled = els.input.value.trim() === '';
    persist();
  }

  function toggle() {
    state.open ? close() : open();
  }
  function open() {
    build();
    state.open = true;
    launcher.classList.add('away');
    launcher.classList.remove('nudge');
    requestAnimationFrame(function () {
      els.panel.classList.add('show');
      els.input.focus({ preventScroll: true });
    });
    persist();
  }
  function close() {
    state.open = false;
    if (els.panel) els.panel.classList.remove('show');
    launcher.classList.remove('away');
    launcher.focus({ preventScroll: true });
    persist();
  }

  function detectPage() {
    var p = location.pathname;
    if (/\/products\//.test(p)) return { type: 'product', title: document.title };
    if (/\/collections\//.test(p)) return { type: 'collection', title: document.title };
    if (/\/cart/.test(p)) return { type: 'cart' };
    return { type: 'other', title: document.title };
  }

  function addMsg(role, text, instant) {
    els.intro.hidden = true;
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    if (instant) d.style.animation = 'none';
    if (text) d.textContent = text;
    els.log.appendChild(d);
    toBottom();
    return d;
  }

  function toBottom() {
    els.scroll.scrollTop = els.scroll.scrollHeight;
  }

  function money(v) {
    return v == null ? '' : '$' + (v / 100).toFixed(2);
  }

  function renderCards(products, label) {
    els.rail.hidden = false;
    els.railTitle.textContent = label || 'From the store';
    els.cards.innerHTML = '';
    products.slice(0, 8).forEach(function (p, i) {
      var min = p.price_range && p.price_range.min ? p.price_range.min.amount : null;
      var vars = p.variants || [];
      var anyOut = vars.some(function (v) {
        return !v.available;
      });
      var allOut = vars.length > 0 && vars.every(function (v) {
        return !v.available;
      });

      // Demo fixtures carry `image`; real UCP payloads carry `media[]`.
      var img = p.image || (p.media && p.media[0] && p.media[0].url) || '';

      var c = document.createElement('button');
      c.className = 'card';
      c.type = 'button';
      c.style.animationDelay = i * 55 + 'ms';
      c.innerHTML =
        '<div class="ph">' +
        (img ? '<img alt="" loading="lazy" src="' + img + '">' : '') +
        (allOut ? '<span class="pill out">Sold out</span>' : anyOut ? '<span class="pill">Some sizes</span>' : '') +
        '</div><div class="meta"><div class="t"></div><div class="p"></div></div>';
      c.querySelector('.t').textContent = p.title || '';
      c.querySelector('.p').textContent = money(min);
      c.addEventListener('click', function () {
        els.input.value = 'Tell me more about the ' + p.title;
        submit();
      });
      els.cards.appendChild(c);
    });
    state.products = products.slice(0, 8);
  }

  function skeletons(n) {
    els.rail.hidden = false;
    els.railTitle.textContent = 'Looking…';
    els.cards.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var c = document.createElement('div');
      c.className = 'card skel';
      c.style.animationDelay = i * 55 + 'ms';
      c.innerHTML = '<div class="ph"></div><div class="meta"><div class="t"></div><div class="p"></div></div>';
      els.cards.appendChild(c);
    }
  }

  // ---------- voice -------------------------------------------------------
  //
  // Deliberately a pipeline (STT -> grounded text turn -> TTS) rather than a
  // speech-to-speech model. Speech-to-speech emits audio, so there is no text
  // for the grounding validator to check — and unlike a chat bubble, spoken
  // audio cannot be retracted. We only ever speak text the tripwire has
  // already settled and validated, which the gateway sends as `speak` events.
  //
  // Mic permission is requested on the FIRST deliberate press, never on load.
  var voice = {
    on: false,
    recorder: null,
    stream: null,
    chunks: [],
    queue: [],
    playing: null,
    ctx: null,
    analyser: null,
    silenceSince: 0,
    spokeMs: 0,
    raf: 0,
  };

  function setVoiceState(s) {
    if (els.mic) els.mic.dataset.state = s;
    if (els.status) {
      els.status.textContent =
        s === 'listening' ? 'Listening…' : s === 'speaking' ? 'Speaking' : s === 'thinking' ? 'Thinking…' : 'Ready';
    }
  }

  async function toggleVoice() {
    if (voice.on) return stopVoice(true);
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      // Permission denied is a normal outcome, not an error state. Fall back
      // to text without ceremony.
      els.voicebar.classList.remove('on');
      addMsg('bot', 'I couldn’t get microphone access — type instead and I’ll help the same way.');
      return;
    }
    voice.on = true;
    els.voicebar.classList.add('on');
    startCapture();
  }

  function stopVoice(full) {
    cancelAnimationFrame(voice.raf);
    if (voice.recorder && voice.recorder.state !== 'inactive') voice.recorder.stop();
    if (full && voice.stream) voice.stream.getTracks().forEach(function (t) { t.stop(); });
    if (full) {
      voice.on = false;
      voice.stream = null;
      els.voicebar.classList.remove('on');
      stopPlayback();
    }
    setVoiceState('idle');
  }

  function startCapture() {
    voice.chunks = [];
    var rec = new MediaRecorder(voice.stream, { mimeType: pickMime() });
    voice.recorder = rec;
    rec.ondataavailable = function (e) { if (e.data.size) voice.chunks.push(e.data); };
    rec.onstop = function () {
      var blob = new Blob(voice.chunks, { type: rec.mimeType });
      if (blob.size > 1200) transcribeAndSend(blob);
      else if (voice.on) startCapture(); // too short to be speech
    };
    rec.start(100);
    setVoiceState('listening');
    monitorSilence();
  }

  function pickMime() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // Energy-based endpointing. The server-side endpointer uses the transcript to
  // vary this threshold; here we only have loudness, so it stays conservative.
  function monitorSilence() {
    if (!voice.ctx) {
      voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
      voice.analyser = voice.ctx.createAnalyser();
      voice.analyser.fftSize = 512;
      voice.ctx.createMediaStreamSource(voice.stream).connect(voice.analyser);
    }
    var buf = new Uint8Array(voice.analyser.frequencyBinCount);
    voice.silenceSince = performance.now();
    voice.spokeMs = 0;
    var last = performance.now();

    function tick() {
      if (!voice.on) return;
      voice.analyser.getByteFrequencyData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i];
      var level = sum / buf.length;
      var now = performance.now();
      var dt = now - last;
      last = now;

      if (level > 12) {
        voice.silenceSince = now;
        voice.spokeMs += dt;
        // Barge-in: talking over playback cancels audio AND the generation.
        if (voice.playing && voice.spokeMs > 160) {
          stopPlayback();
          if (inflight) inflight.abort();
        }
      } else if (
        voice.spokeMs > 250 &&
        now - voice.silenceSince > 700 &&
        voice.recorder &&
        voice.recorder.state === 'recording'
      ) {
        voice.recorder.stop();
        return;
      }
      voice.raf = requestAnimationFrame(tick);
    }
    voice.raf = requestAnimationFrame(tick);
  }

  async function transcribeAndSend(blob) {
    setVoiceState('thinking');
    try {
      var r = await fetch(API + '/api/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      });
      var d = await r.json();
      var text = (d && d.text ? d.text : '').trim();
      if (!text) { if (voice.on) startCapture(); return; }
      els.live.textContent = text;
      addMsg('user', text);
      state.messages.push({ role: 'user', text: text });
      persist();
      stream(text, true);
    } catch (e) {
      if (voice.on) startCapture();
    }
  }

  function enqueueSpeech(text) {
    voice.queue.push(text);
    if (!voice.playing) playNext();
  }

  async function playNext() {
    var text = voice.queue.shift();
    if (!text) {
      voice.playing = null;
      if (voice.on) startCapture(); // hand the turn back
      return;
    }
    try {
      var r = await fetch(API + '/api/voice/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      if (!r.ok) throw new Error('tts');
      var url = URL.createObjectURL(await r.blob());
      var audio = new Audio(url);
      voice.playing = audio;
      setVoiceState('speaking');
      audio.onended = function () { URL.revokeObjectURL(url); playNext(); };
      audio.onerror = function () { URL.revokeObjectURL(url); playNext(); };
      await audio.play();
    } catch (e) {
      playNext(); // a failed utterance must not stall the queue
    }
  }

  function stopPlayback() {
    if (voice.playing) {
      voice.playing.pause();
      voice.playing = null;
    }
    voice.queue.length = 0;
  }

  // ---------- send --------------------------------------------------------
  var inflight = null;

  function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    var text = els.input.value.trim();
    if (!text) return;

    if (inflight) inflight.abort(); // interrupt, never queue
    els.chips.innerHTML = '';
    els.input.value = '';
    grow();
    addMsg('user', text);
    state.messages.push({ role: 'user', text: text });
    persist();
    stream(text);
  }

  function stream(text, isVoice) {
    var bubble = addMsg('bot', '');
    bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    els.status.textContent = 'Thinking…';
    skeletons(3);

    var ctl = new AbortController();
    inflight = ctl;

    var shown = '';
    var pending = '';
    var queued = false;
    function flush() {
      queued = false;
      if (!pending) return;
      shown += pending;
      pending = '';
      bubble.textContent = shown; // replaces the dots on first real text
      toBottom();
    }
    function schedule() {
      if (!queued) {
        queued = true;
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
        voice: isVoice === true,
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
              handle(buf.slice(0, i));
              buf = buf.slice(i + 2);
            }
            return pump();
          });
        }

        function handle(record) {
          var ev = '';
          var data = '';
          record.split('\n').forEach(function (l) {
            if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
            else if (l.indexOf('data:') === 0) data += l.slice(5).trim();
          });
          if (!data) return;
          var d;
          try {
            d = JSON.parse(data);
          } catch (err) {
            return;
          }

          if (ev === 'session') {
            state.sessionId = d.sessionId;
            persist();
          } else if (ev === 'products') {
            renderCards(d.products, d.products.length === 1 ? 'The match' : 'What I found');
          } else if (ev === 'delta') {
            pending += d.text;
            schedule();
          } else if (ev === 'speak') {
            // Already grounded and settled server-side — safe to voice.
            enqueueSpeech(d.text);
          } else if (ev === 'reset') {
            // Grounding tripwire fired — discard the partial answer entirely,
            // and drop any queued audio before it can be spoken.
            shown = '';
            pending = '';
            stopPlayback();
            bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
          } else if (ev === 'done') {
            flush();
            if (shown !== d.reply) bubble.textContent = d.reply;
            state.messages.push({ role: 'bot', text: d.reply });
            if (els.railTitle.textContent === 'Looking…') els.rail.hidden = true;
            els.status.textContent = d.grounded ? 'Ready' : 'Passed to the team';
            persist();
          } else if (ev === 'error') {
            flush();
            bubble.textContent = d.message;
          }
        }
        return pump();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        els.rail.hidden = true;
        bubble.textContent =
          'I couldn’t reach the store just then. Try again in a moment, or leave an email and someone will follow up.';
      })
      .finally(function () {
        if (inflight === ctl) inflight = null;
        if (els.status.textContent === 'Thinking…') els.status.textContent = 'Ready';
      });
  }

  // ---------- measurement -------------------------------------------------
  //
  // A slice of shoppers is held back and never sees the assistant, so there is
  // an honest control group to compare against. Two things matter here:
  //
  //   1. The ARM IS DECIDED BY THE SERVER. The widget asks; it does not choose.
  //      Deciding client-side would let a shopper (or a bored developer with
  //      devtools) put themselves in either group and quietly corrupt the
  //      experiment.
  //   2. HELD-BACK SESSIONS STILL GET A SESSION ID, written to storage where
  //      the web pixel can read it. Without that the control group's orders are
  //      invisible, and an unmeasurable control group makes the whole
  //      comparison worthless. This is the one job the widget does even when it
  //      renders nothing at all.
  var SESSION_KEY = 'storeagent.sid';

  function sessionId() {
    try {
      var existing = localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var id =
        (crypto.randomUUID && crypto.randomUUID()) ||
        String(Date.now()) + Math.random().toString(36).slice(2);
      localStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (e) {
      return String(Date.now());
    }
  }

  // ---------- mount -------------------------------------------------------
  function mount() {
    var sid = sessionId();
    state.sessionId = state.sessionId || sid;
    var shop = SHOP;

    fetch(API + '/api/exposure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, shop: shop }),
      keepalive: true,
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        // Held back: record nothing on screen, leave the session id in place
        // for the pixel, and stop.
        if (d && d.arm === 'holdout') return;
        return fetch(API + '/api/config?shop=' + encodeURIComponent(shop))
          .then(function (r) {
            return r.json();
          })
          .then(render);
      })
      .catch(function () {
        // Measurement must never cost a conversation. If the beacon fails,
        // show the assistant rather than silently disabling it.
        render({ enabled: true });
      });
  }

  function render(cfg) {
    if (cfg && cfg.enabled === false) return;
    if (cfg) {
      if (cfg.accentColor) host.style.setProperty('--sa-accent', cfg.accentColor);
      if (cfg.cornerRadius != null) host.style.setProperty('--sa-radius', cfg.cornerRadius + 'px');
      if (cfg.position === 'left') host.setAttribute('data-position', 'left');
      state.greeting = cfg.greeting || '';
    }
    document.body.appendChild(host);
    if (state.open) open();
    else if (!state.messages.length) {
      // A single, quiet invitation after real dwell. Never on load, never twice.
      setTimeout(function () {
        if (!state.open && !sessionStorage.getItem(KEY + '.nudged')) {
          launcher.classList.add('nudge');
          try {
            sessionStorage.setItem(KEY + '.nudged', '1');
          } catch (e) {}
        }
      }, 20000);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
