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

  // Printed on mount. widget.js is unversioned and cached, so without this
  // there is no way to tell a stale copy in a merchant's browser from current
  // code — which makes "I deployed a fix" and "you are still running the bug"
  // look the same.
  var BUILD = '2026-09-12.4';

  var state = { open: false, sessionId: null, messages: [], draft: '', products: [] };
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved) state = Object.assign(state, JSON.parse(saved));
  } catch (e) {}

  var els = {};
  /**
   * Per-turn UI handles. The card rail belongs to ONE answer, so it is
   * created next to that answer's bubble and forgotten when the next turn
   * starts — rather than a single rail at the top of the panel being
   * rewritten by every question.
   */
  var turnUi = { bubble: null, rail: null };
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

  /**
   * Pin the host's own layout beyond the reach of merchant CSS.
   *
   * Shadow DOM protects the INSIDE of the widget. It does not protect the host
   * element, and a page rule targeting the host beats any `:host` rule in the
   * cascade — so the isolation that makes the widget safe to embed stops
   * exactly where it matters most.
   *
   * This is not hypothetical. On a live store the theme laid out `<body>` as a
   * grid and hid unexpected direct children; our host is exactly that, so it
   * computed `display:none`. The widget still loaded, mounted, and computed a
   * correct 56px launcher — and generated no box at all. Nothing errored and
   * nothing logged; the only symptom was a merchant saying the button was not
   * there, and it took a server-side self-check to find.
   *
   * Inline + `!important` is the one declaration a merchant stylesheet cannot
   * outrank, so the few properties the widget cannot survive losing are pinned
   * here rather than in the shadow stylesheet.
   *
   * The host is fixed at zero size rather than `display:block`. That keeps it
   * out of flow entirely, so it cannot add a row to a grid body, a child to a
   * flex row, or a margin anywhere — which is the legitimate reason a theme
   * hides unexpected children of `<body>` in the first place. A fixed ancestor
   * does NOT become the containing block for fixed descendants (only
   * transform/filter/perspective/contain/will-change do, and all are pinned
   * off), so the launcher and panel still resolve against the viewport.
   */
  var PINNED = {
    position: 'fixed',
    top: '0',
    left: '0',
    right: 'auto',
    bottom: 'auto',
    width: '0',
    height: '0',
    'max-width': 'none',
    'max-height': 'none',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    overflow: 'visible',
    'z-index': '2147483000',
    float: 'none',
    clip: 'auto',
    'clip-path': 'none',
    transform: 'none',
    filter: 'none',
    perspective: 'none',
    contain: 'none',
    'will-change': 'auto',
    // Must be `auto`, not `none`: pointer-events inherits into the shadow tree,
    // so `none` here would trade an invisible launcher for an unclickable one.
    // The host is 0x0 and the launcher sits outside it, so this intercepts
    // nothing the merchant's page needs.
    'pointer-events': 'auto',
  };
  function pinHost() {
    for (var k in PINNED) {
      if (Object.prototype.hasOwnProperty.call(PINNED, k)) {
        try {
          host.style.setProperty(k, PINNED[k], 'important');
        } catch (e) {}
      }
    }
  }
  pinHost();

  var root = host.attachShadow({ mode: 'open' });

  var CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;font-family:var(--sa-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
:host{
  --accent:var(--sa-accent,#1b3a34);
  --paper:var(--sa-bg,#fffefb);
  --ink:var(--sa-fg,#14161a);
  --muted:color-mix(in srgb,var(--ink) 52%,transparent);
  /* Hairlines, not borders. A 1px line at 11% ink reads as a drawn box; at
     7% it reads as two surfaces meeting, which is the difference between a
     form and a finished object. */
  --line:color-mix(in srgb,var(--ink) 7%,transparent);
  --sunk:color-mix(in srgb,var(--ink) 4.5%,transparent);
  /* One step further down for the composer, so the input sits IN the panel
     rather than on it. A single flat surface everywhere is most of what
     makes an interface look unfinished. */
  --sunk2:color-mix(in srgb,var(--ink) 7.5%,transparent);
  /* The light catch along a top edge. Present on both themes: on dark it
     is the highlight, on light it is barely there and does no harm. */
  --sheen:color-mix(in srgb,#fff 55%,transparent);
  --r:var(--sa-radius,16px);
  --ease:cubic-bezier(.22,1,.36,1);

  /* Shadow DOM isolates STYLE, not STACKING. The host still takes part in the
     page's stacking context, and all:initial above resets it to z-index:auto --
     so the launcher, despite being position:fixed and last in the body, paints
     UNDER any theme element with a positive z-index: sticky headers, cart
     drawers, announcement bars, cookie banners, back-to-top buttons. On such a
     theme the widget loads, mounts, works, and is invisible, which is
     indistinguishable from being broken.

     position:relative plus a top-of-range z-index puts the whole widget in its
     own stacking context above theme content. Neither property creates a
     containing block, so the fixed launcher and panel still resolve against the
     viewport -- that is why this is not transform or contain. */
  position:relative;
  z-index:2147483000;
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
  /* 352x440, down from 404x640 in two steps.
     At full size the panel covered the hero, the product and the buy
     button — the page a shopper is reading while asking about it. An
     assistant that obscures the thing being discussed works against
     itself. Height takes the deeper cut because height is what swallows a
     page; the width only had to keep two product cards side by side, and
     352 still does (352 - 32 padding = 320; two 156px cards + 11px gap =
     323, which scrolls by one card rather than wrapping).
     Voice opens smaller still — see .panel.compact. */
  position:fixed;right:22px;bottom:22px;width:352px;height:min(440px,calc(100dvh - 132px));
  background:var(--paper);color:var(--ink);border:1px solid var(--line);
  border-radius:calc(var(--r) + 4px);
  display:flex;flex-direction:column;overflow:hidden;contain:layout paint;
  /* Four layers, each doing one job: a hairline of contact shadow so the
     edge is not floating, a close soft shadow for the lift, a wide faint
     one for the room it sits in, and an inset sheen along the top edge so
     the panel catches light like an object rather than being a filled
     rectangle. One big blurry shadow is what a flat card looks like. */
  box-shadow:
    0 0 0 .5px color-mix(in srgb,var(--ink) 6%,transparent),
    0 2px 6px -1px rgba(0,0,0,.10),
    0 18px 48px -12px rgba(0,0,0,.28),
    inset 0 1px 0 0 var(--sheen);
  transform-origin:100% 100%;
  opacity:0;transform:scale(.92) translateY(12px);pointer-events:none;
  transition:opacity .2s linear,transform .38s var(--ease);
}
.panel.show{opacity:1;transform:none;pointer-events:auto}

header{
  display:flex;align-items:center;gap:10px;padding:13px 14px;flex:0 0 auto;
  border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 82%,transparent);
  backdrop-filter:saturate(1.5) blur(12px);position:relative;z-index:2}
/* A lit face, not a flat swatch: the accent with a highlight falling from
   the top left, and a hairline ring so it reads as a physical chip. */
.avatar{width:28px;height:28px;border-radius:9px;color:#fff;
  background:linear-gradient(160deg,
    color-mix(in srgb,var(--accent) 82%,#fff) 0%,
    var(--accent) 55%,
    color-mix(in srgb,var(--accent) 88%,#000) 100%);
  box-shadow:
    inset 0 1px 0 0 color-mix(in srgb,#fff 35%,transparent),
    0 1px 2px color-mix(in srgb,var(--accent) 45%,transparent);
  display:grid;place-items:center;flex:0 0 auto}
.who{display:flex;flex-direction:column;line-height:1.3;min-width:0}
.who b{font-size:13.5px;font-weight:600;letter-spacing:-.012em}
/* A presence dot rather than the bare word. "Ready" on its own is a label;
   a small live dot beside it is a state, and states are what people read. */
.who span{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:5px;
  letter-spacing:.005em}
.who span::before{content:'';width:5px;height:5px;border-radius:50%;flex:0 0 auto;
  background:color-mix(in srgb,var(--accent) 70%,transparent);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent)}
header .x{margin-left:auto;background:none;border:0;cursor:pointer;color:var(--muted);
  width:30px;height:30px;border-radius:8px;display:grid;place-items:center;transition:background .16s,color .16s}
header .x:hover{background:var(--sunk);color:var(--ink)}

.scroll{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.scroll::-webkit-scrollbar{width:10px}
.scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--ink) 14%,transparent);
  border-radius:9px;border:3.5px solid transparent;background-clip:content-box}
.scroll::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--ink) 24%,transparent);
  background-clip:content-box}

/* ---------- opening state ------------------------------------------------ */
.intro{padding:26px 20px 8px}
.intro h2{font-size:19px;font-weight:600;letter-spacing:-.02em;line-height:1.3;margin-bottom:5px}
.intro p{font-size:13.5px;color:var(--muted);line-height:1.55}

/* ---------- messages ----------------------------------------------------- */
.log{display:flex;flex-direction:column;gap:10px;padding:16px 16px 4px}
/* 15px at 1.6, not 14.5 at 1.55. The difference sounds trivial and is most
   of why a chat panel reads as a form field instead of something written to
   you — text people actually read wants air. */
.msg{max-width:88%;padding:11px 14px;font-size:15px;line-height:1.6;white-space:pre-wrap;
  word-wrap:break-word;border-radius:16px;letter-spacing:-.003em;
  animation:rise .34s var(--ease) both}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
/* A TINT of the accent, not the accent itself.
   Solid brand colour on every shopper bubble turns the transcript into a
   column of flat blocks — loud against a light theme, harsh against a dark
   one, and it spends the accent on the least important thing on screen.
   The accent belongs on the one control you want pressed. A wash of it
   still reads as "this was you", and the text stays ink, so contrast holds
   whatever colour the merchant picks. */
.msg.user{align-self:flex-end;border-bottom-right-radius:6px;
  background:color-mix(in srgb,var(--accent) 13%,var(--paper));
  color:var(--ink);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--accent) 18%,transparent),
    inset 0 1px 0 0 color-mix(in srgb,#fff 22%,transparent)}
.msg.bot{align-self:flex-start;background:var(--sunk);border-bottom-left-radius:6px;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--ink) 5%,transparent),
    inset 0 1px 0 0 var(--sheen)}
.dots{display:inline-flex;gap:4px;padding:3px 1px}
.dots i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.3;
  animation:blink 1.25s infinite var(--ease)}
.dots i:nth-child(2){animation-delay:.16s}.dots i:nth-child(3){animation-delay:.32s}
@keyframes blink{0%,100%{opacity:.22;transform:translateY(0)}45%{opacity:.75;transform:translateY(-2px)}}

/* ---------- products: the hero, not an afterthought ---------------------- */
.rail{padding:12px 16px 4px}
.rail h3{font-size:10.5px;font-weight:650;letter-spacing:.085em;text-transform:uppercase;
  color:var(--muted);margin-bottom:9px}
.cards{display:flex;gap:11px;overflow-x:auto;scroll-snap-type:x mandatory;
  padding-bottom:6px;scrollbar-width:none}
.cards::-webkit-scrollbar{display:none}
.card{flex:0 0 156px;scroll-snap-align:start;border:1px solid var(--line);border-radius:13px;
  overflow:hidden;background:var(--paper);cursor:pointer;text-align:left;padding:0;
  box-shadow:0 1px 2px color-mix(in srgb,var(--ink) 6%,transparent),
    inset 0 1px 0 0 var(--sheen);
  display:block;text-decoration:none;color:inherit;font:inherit;
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
form{display:flex;align-items:flex-end;gap:8px;padding:11px 13px;flex:0 0 auto;
  border-top:1px solid var(--line);
  background:color-mix(in srgb,var(--paper) 92%,transparent);
  backdrop-filter:saturate(1.4) blur(10px);
  box-shadow:inset 0 1px 0 0 var(--sheen);
  padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
.field{flex:1;display:flex;align-items:center;background:var(--sunk2);
  border:1px solid color-mix(in srgb,var(--ink) 6%,transparent);
  border-radius:13px;transition:border-color .18s,background .18s,box-shadow .18s;
  box-shadow:inset 0 1px 2px color-mix(in srgb,var(--ink) 5%,transparent)}
/* A ring, not a hard border swap. The 2px halo is what reads as focus on a
   touch device where there is no cursor to follow. */
.field:focus-within{border-color:color-mix(in srgb,var(--accent) 40%,transparent);
  background:var(--paper);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}
textarea{flex:1;border:0;background:none;color:inherit;resize:none;outline:none;
  font-size:14.5px;line-height:1.45;padding:11px 13px;max-height:104px;min-height:42px}
textarea::placeholder{color:var(--muted)}
/* Quiet, because the mic beside it is the primary action now. Still a
   full-size target — demoting it visually must not demote it to the thumb. */
.send{width:42px;height:42px;flex:0 0 auto;border:1px solid var(--line);border-radius:12px;cursor:pointer;
  background:var(--paper);color:var(--ink);display:grid;place-items:center;
  transition:transform .18s var(--ease),opacity .18s,background .18s}
.send:not(:disabled):hover{background:var(--sunk)}
.send:disabled{opacity:.32;cursor:default}
.send:not(:disabled):hover{transform:translateY(-1px) scale(1.03)}
.send:not(:disabled):active{transform:scale(.94)}
.send:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* ---------- the microphone is the primary input -------------------------
   It used to be a bordered outline button beside a filled send arrow, so
   the accent colour said "typing is the real way to use this" and voice
   read as a secondary affordance. It is the other way round: speaking a
   question is faster than typing it, and on a phone it is the only
   comfortable way. The mic is now the filled, larger control and send is
   the quiet one — the same relationship, reversed. */
.mic{width:48px;height:48px;flex:0 0 auto;border:0;border-radius:14px;cursor:pointer;
  background:var(--accent);color:#fff;display:grid;place-items:center;position:relative;
  box-shadow:0 1px 2px rgba(0,0,0,.10),0 8px 20px -8px color-mix(in srgb,var(--accent) 60%,transparent);
  transition:background .18s,border-color .18s,transform .18s var(--ease),color .18s}
.mic:hover{transform:translateY(-1px) scale(1.03)}
.mic:active{transform:scale(.95)}
.mic:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mic[data-state=listening]{background:var(--accent);color:#fff;border-color:var(--accent)}
.mic[data-state=listening]::after{content:'';position:absolute;inset:-4px;border-radius:14px;
  border:2px solid var(--accent);opacity:.45;animation:ring 1.4s var(--ease) infinite}
.mic[data-state=speaking]{color:var(--accent);border-color:var(--accent)}
.mic[data-state=thinking]{opacity:.55}
.voicebar{display:none;align-items:center;gap:9px;padding:9px 16px 0;font-size:12.5px;color:var(--muted)}
.voicebar.on{display:flex}
.voicebar .live{flex:1;color:var(--ink);font-style:italic}

/* ---------- waveform ----------------------------------------------------
   Driven by the real signal in both directions: the microphone analyser
   while listening, the TTS output while speaking. A looping animation would
   have been a third of the code and a lie — it says "working" while a dead
   mic looks identical to a live one, which is precisely the confusion that
   made voice so hard to diagnose here.

   Bars, not a canvas: eleven divs scale on the compositor, cost nothing to
   animate, and inherit the merchant's accent colour for free. */
/* ---------- compact: the voice-first state ------------------------------
   What the launcher opens into. Tall enough for the waveform, the live
   transcript and one answer, and no taller — a shopper who tapped a
   microphone is listening, not reading, and a full-height panel over the
   product they are asking about is the thing they were complaining about.
   It grows to the full conversation the moment there is one. */
/* A SQUARE. Tapping the launcher opens this, already listening.
   Square because it is not a transcript — it is one object doing one
   thing, and a wide short bar reads as a document that got cut off. The
   waveform sits in the middle of it with room on every side, which is what
   makes the listening state legible from across a desk. */
.panel.compact{width:320px;height:320px}
.panel.compact .rail,
.panel.compact .chips,
.panel.compact .intro{display:none}
/* The conversation is centred in the remaining space rather than stacked
   from the top, so a one-line answer sits in the middle of the square
   instead of clinging to the header. */
.panel.compact .scroll{display:flex;flex-direction:column;justify-content:center}
.panel.compact .log{padding:0 18px;gap:8px}
.panel.compact .msg{font-size:14px;max-width:100%;text-align:center;
  background:none;box-shadow:none;padding:2px 0}
.panel.compact .msg.user{color:var(--muted);font-size:13px;align-self:center}
.panel.compact .msg.bot{align-self:center}
/* Only the latest exchange: older turns are what the expanded panel is for. */
.panel.compact .msg:not(:nth-last-child(-n+2)){display:none}
/* The waveform becomes the subject of the square, not a detail beside a
   label — it is the only thing on screen that is actually moving. */
.panel.compact .voicebar{flex-direction:column;gap:10px;padding:4px 18px 2px}
.panel.compact .wave{height:44px;gap:3px}
.panel.compact .wave i{width:3px}
.panel.compact .live{text-align:center;font-style:normal;font-size:13px}
/* Typing is still possible, just not the invitation. */
.panel.compact form{padding:10px 14px}
.panel.compact textarea{min-height:38px;font-size:14px}

@media (max-width:480px){
  /* Still square, still anchored to the thumb, never a full-height sheet —
     a shopper who tapped a microphone did not ask to lose the page. */
  .panel.compact{width:min(320px,calc(100vw - 32px));height:min(320px,calc(100vw - 32px));
    left:auto;right:16px;bottom:16px;border-radius:var(--r)}
}

.wave{display:flex;align-items:center;gap:2px;height:18px;flex:0 0 auto}
.wave i{width:2px;height:100%;border-radius:2px;background:var(--accent);opacity:.35;
  transform:scaleY(.15);transform-origin:center;transition:transform .07s linear,opacity .07s linear}
.wave.live i{opacity:.9}
.wave.speaking i{background:var(--accent);opacity:.75}
@media (prefers-reduced-motion:reduce){
  /* Still shows state, without the motion. */
  .wave i{transition:none;transform:scaleY(.5)}
  .wave.live i,.wave.speaking i{transform:scaleY(.7)}
}
.voicebar button{background:none;border:0;color:var(--muted);cursor:pointer;font:inherit;
  text-decoration:underline;padding:0}

.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* merchant-configurable side */
:host([data-position=left]) .launcher{right:auto;left:22px}
:host([data-position=left]) .panel{right:auto;left:22px;transform-origin:0 100%}

@media (max-width:540px){
  /* A third of the viewport, not the whole phone. The panel is a sheet the
     shopper consults while still seeing the product they were looking at —
     covering the page is what makes an assistant feel like an interruption.
     dvh, not vh, so the mobile URL bar collapsing does not resize it. */
  .panel{right:0;left:0;bottom:0;width:100%;height:33dvh;border-radius:20px 20px 0 0;
    transform-origin:50% 100%}
  .launcher{right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}

  /* At a third of the viewport the chrome is the constraint, not the content:
     the default header, composer and intro come to ~128px, which on a short
     phone leaves under 60px of actual conversation. Everything below is a
     tighter version of the same layout so the sheet stays usable at this size
     rather than technically correct and unreadable. */
  header{padding:10px 14px}
  .avatar{width:26px;height:26px;border-radius:8px}
  .intro{padding:14px 16px 6px}
  .intro h2{font-size:17px}
  .intro p{font-size:12.5px}
  form{padding:9px 12px;padding-bottom:calc(9px + env(safe-area-inset-bottom,0px))}
  textarea{min-height:38px;max-height:72px;padding:9px 12px}
  .card{flex-basis:120px}
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
      '<div class="log" aria-live="polite"></div>' +
      '<div class="chips"></div>' +
      '</div>' +
      '<div class="voicebar"><span class="wave">' +
      '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>' +
      '</span><span class="live">Listening…</span>' +
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
    els.log = p.querySelector('.log');
    els.chips = p.querySelector('.chips');
    els.status = p.querySelector('.status');
    els.form = p.querySelector('form');
    els.input = p.querySelector('textarea');
    els.send = p.querySelector('.send');
    els.mic = p.querySelector('.mic');
    els.voicebar = p.querySelector('.voicebar');
    els.wave = p.querySelector('.voicebar .wave');
    els.waveBars = [].slice.call(p.querySelectorAll('.voicebar .wave i'));
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
  /**
   * Tapping the launcher starts LISTENING, it does not open a chat box.
   *
   * Opening a text panel and focusing a textarea says "type your question",
   * which is the slower thing to do and, on a phone, the awkward one. A
   * shopper who taps a microphone-shaped button has already said what they
   * want to do. So the panel opens small, in voice mode, already
   * listening — the keyboard never appears and no one has to find the mic.
   *
   * The full conversation is one tap away and arrives automatically as soon
   * as anything is typed or answered; nothing is removed, only reordered.
   */
  function open(opts) {
    build();
    state.open = true;
    launcher.classList.add('away');
    launcher.classList.remove('nudge');
    var voiceFirst = !opts || opts.voice !== false;
    requestAnimationFrame(function () {
      els.panel.classList.add('show');
      if (voiceFirst && canListen()) {
        els.panel.classList.add('compact');
        // Not focused: focusing a textarea raises the mobile keyboard over
        // the thing the shopper is trying to talk to.
        if (!voice.on) void toggleVoice();
      } else {
        els.panel.classList.remove('compact');
        els.input.focus({ preventScroll: true });
      }
    });
    persist();
  }

  /** Voice needs a microphone and a recorder; without them, open to text. */
  function canListen() {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  /** Grow to the full conversation — typing, or an answer worth reading. */
  function expand() {
    if (els.panel) els.panel.classList.remove('compact');
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
    // A typed message means the shopper wants the full conversation.
    if (role === 'user' && !voice.on) expand();
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

  // Where a card points.
  //
  // On a storefront the RELATIVE path is deliberate: `window.Shopify.shop` is
  // the permanent `*.myshopify.com` domain, which is usually NOT the domain the
  // shopper is browsing. Sending them to the absolute one would hop domains
  // mid-session and abandon their cart. A relative path keeps them where they
  // already are.
  //
  // Off-storefront (the demo page) there is no such path to be relative to, so
  // fall back to the absolute shop domain.
  function productHref(p) {
    var handle = p.handle || '';
    if (!handle) return '';
    if (window.Shopify && window.Shopify.shop) return '/products/' + handle;
    return 'https://' + SHOP + '/products/' + handle;
  }

  /**
   * The card rail for the CURRENT answer, created inside the log.
   *
   * There used to be exactly one rail, pinned above the whole conversation.
   * It worked for the first question and quietly stopped after that: ask a
   * second thing and its cards replaced the first set, several screens above
   * the answer they belonged to and usually scrolled out of sight. A shopper
   * reading a list of six boards saw no pictures at all, because the pictures
   * were up where the conversation began.
   *
   * A rail per turn, inserted directly above the bubble it explains, so cards
   * and prose arrive together and stay together in the scrollback.
   */
  function turnRail() {
    if (turnUi.rail && turnUi.rail.isConnected) return turnUi.rail;
    var rail = document.createElement('div');
    rail.className = 'rail';
    rail.innerHTML = '<h3></h3><div class="cards"></div>';
    // AFTER the answer. Cards arrive first — ~44ms, off the speculative
    // search, while the model is still composing — and putting them where
    // they landed pushed the reply below the fold: a shopper saw pictures for
    // a question they had not been answered yet, and had to scroll to find
    // the words. Reading order beats arrival order, so the reply comes first
    // and the products illustrate it.
    if (turnUi.bubble && turnUi.bubble.isConnected && turnUi.bubble.nextSibling) {
      els.log.insertBefore(rail, turnUi.bubble.nextSibling);
    } else {
      els.log.appendChild(rail);
    }
    turnUi.rail = rail;
    return rail;
  }

  /** Drop this turn's rail — no results, or the turn failed. */
  function dropRail() {
    if (turnUi.rail && turnUi.rail.parentNode) turnUi.rail.parentNode.removeChild(turnUi.rail);
    turnUi.rail = null;
  }

  /**
   * Is this variant purchasable?
   *
   * A live UCP variant reports `availability: {available: true}`. The demo
   * fixtures use a flat `available`, and the card read only the flat one — so
   * against a real store the value was `undefined`, `!undefined` was true,
   * and EVERY product wore a "Sold out" badge while the answer beside it
   * said the same products were available.
   *
   * Unknown means available. Branding a purchasable product sold out costs a
   * sale outright; the opposite is corrected at the cart, where the
   * authoritative message comes from.
   */
  function variantAvailable(v) {
    if (!v) return true;
    if (v.availability && typeof v.availability.available === 'boolean') return v.availability.available;
    if (typeof v.available === 'boolean') return v.available;
    return true;
  }

  function renderCards(products, label) {
    var rail = turnRail();
    rail.querySelector('h3').textContent = label || 'From the store';
    var cards = rail.querySelector('.cards');
    cards.innerHTML = '';
    els.cards = cards;
    products.slice(0, 8).forEach(function (p, i) {
      var min = p.price_range && p.price_range.min ? p.price_range.min.amount : null;
      var vars = p.variants || [];
      var anyOut = vars.some(function (v) {
        return !variantAvailable(v);
      });
      var allOut = vars.length > 0 && vars.every(function (v) {
        return !variantAvailable(v);
      });

      // Demo fixtures carry `image`; real UCP payloads carry `media[]`.
      // display_image is the variant the conversation named — the white
      // pair, not whichever colourway the merchant set as primary. Correct
      // words under a contradicting picture is worse than no picture.
      var img = p.display_image || p.image || (p.media && p.media[0] && p.media[0].url) || '';

      // An anchor, not a button: clicking a product goes to the product page,
      // so it must behave like a link — middle-click, ctrl-click and "open in
      // new tab" all work, and the shopper sees the destination on hover.
      var href = productHref(p);
      var c = document.createElement(href ? 'a' : 'button');
      c.className = 'card';
      if (href) c.href = href;
      else c.type = 'button';
      c.style.animationDelay = i * 55 + 'ms';
      c.innerHTML =
        '<div class="ph">' +
        (img ? '<img alt="" loading="lazy" src="' + img + '">' : '') +
        (allOut ? '<span class="pill out">Sold out</span>' : anyOut ? '<span class="pill">Some sizes</span>' : '') +
        '</div><div class="meta"><div class="t"></div><div class="p"></div></div>';
      c.querySelector('.t').textContent = p.title || '';
      c.querySelector('.p').textContent = money(min);
      if (href) {
        // Plain navigation in the same tab. The session lives in
        // sessionStorage, so the conversation is still there when the panel
        // reopens on the product page.
        c.addEventListener('click', function () {
          persist();
        });
      } else {
        c.addEventListener('click', function () {
          els.input.value = 'Tell me more about the ' + p.title;
          submit();
        });
      }
      els.cards.appendChild(c);
    });
    state.products = products.slice(0, 8);
  }

  function skeletons(n) {
    var rail = turnRail();
    rail.querySelector('h3').textContent = 'Looking…';
    var cards = rail.querySelector('.cards');
    cards.innerHTML = '';
    els.cards = cards;
    for (var i = 0; i < n; i++) {
      var c = document.createElement('div');
      c.className = 'card skel';
      c.style.animationDelay = i * 55 + 'ms';
      c.innerHTML = '<div class="ph"></div><div class="meta"><div class="t"></div><div class="p"></div></div>';
      cards.appendChild(c);
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
    recognition: null,
    interim: '',
    stream: null,
    chunks: [],
    queue: [],
    playing: null,
    ctx: null,
    analyser: null,
    // The analyser's input, and the stream it is wired to. Kept so a new
    // microphone can be reconnected — a graph left pointing at an ended
    // track reads silence forever.
    source: null,
    wiredTo: null,
    silenceSince: 0,
    spokeMs: 0,
    peak: 0,
    raf: 0,
  };

  /**
   * Report a voice milestone to the server.
   *
   * Voice is the one path that cannot be tested from outside the browser: it
   * needs a real microphone. Two attempts at the endpointing bug were made
   * blind, both wrong, and the server saw nothing either time — a recorder
   * that never stops never sends audio, so the logs looked identical to
   * "nobody tried it". These lines are the difference between diagnosing and
   * guessing. No audio and no transcript, only what happened and the levels.
   */
  function voiceDiag(event, fields) {
    try {
      var payload = { voice: event, build: BUILD };
      for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) payload[k] = fields[k];
      say('voice ' + event + ' ' + JSON.stringify(fields || {}));
      fetch(API + '/api/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shop: SHOP, diag: payload }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* diagnostics must never break the feature they are diagnosing */
    }
  }

  /**
   * The short rising chime a mic makes when it opens.
   *
   * Every voice UI a shopper has used — Google, YouTube, a phone assistant —
   * marks the moment it starts listening with a sound, and they have learned
   * to wait for it. Ours opened in silence, so there was no signal to speak
   * against: people talked before it was recording, or waited for something
   * that never came and were endpointed on their own hesitation.
   *
   * Synthesised rather than a file: two oscillator notes cost nothing, need
   * no asset on the critical path, and cannot 404 on a merchant's CDN.
   */
  /**
   * Paint the bars from a frequency spectrum.
   *
   * `buf` is the analyser's byte data; the bars sample across it so the
   * shape reflects the actual voice rather than one averaged number moving
   * every bar together. A floor of 0.12 keeps the bars visible at rest —
   * collapsed to nothing reads as broken, which is the opposite of what a
   * listening indicator is for.
   */
  function drawWave(buf, gain) {
    var bars = els.waveBars;
    if (!bars || !bars.length) return;
    var per = Math.max(1, Math.floor(buf.length / bars.length));
    for (var i = 0; i < bars.length; i++) {
      var sum = 0;
      for (var j = 0; j < per; j++) sum += buf[i * per + j] || 0;
      var v = (sum / per / 255) * (gain || 1);
      bars[i].style.transform = 'scaleY(' + Math.max(0.12, Math.min(1, v)).toFixed(3) + ')';
    }
  }

  /** Collapse the bars to rest. */
  function idleWave() {
    if (els.wave) els.wave.className = 'wave';
    (els.waveBars || []).forEach(function (b) {
      b.style.transform = 'scaleY(0.15)';
    });
  }

  /**
   * Animate the bars from the SPOKEN audio while the assistant replies.
   *
   * A second analyser, on the playback element rather than the microphone.
   * Without it the bars freeze the moment the shopper stops talking and the
   * widget looks hung through the part where it is actually answering.
   */
  function watchPlayback(audio) {
    try {
      if (!voice.ctx) return;
      if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();
      var src = voice.ctx.createMediaElementSource(audio);
      var an = voice.ctx.createAnalyser();
      an.fftSize = 128;
      // Through the analyser AND on to the speakers — a MediaElementSource
      // re-routes the audio, so skipping this connection mutes the reply.
      src.connect(an).connect(voice.ctx.destination);
      var buf = new Uint8Array(an.frequencyBinCount);
      if (els.wave) els.wave.className = 'wave speaking';
      var tick = function () {
        if (voice.playing !== audio) return idleWave();
        an.getByteFrequencyData(buf);
        drawWave(buf, 1.6);
        voice.playRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      // Safari throws if an element is re-sourced. The reply still plays.
    }
  }

  function cue(kind) {
    try {
      if (!voice.ctx) return;
      if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();
      var now = voice.ctx.currentTime;
      // Up to start, down to finish — the direction people already read as
      // "go" and "done".
      var notes = kind === 'start' ? [660, 880] : [660, 440];
      notes.forEach(function (hz, i) {
        var osc = voice.ctx.createOscillator();
        var gain = voice.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        // Quiet, and shaped — a square-edged beep at full volume in a
        // shopper's ear is a reason to close the widget.
        gain.gain.setValueAtTime(0.0001, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.06, now + i * 0.07 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.07);
        osc.connect(gain).connect(voice.ctx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.08);
      });
    } catch (e) {
      /* a missing chime must never stop the mic working */
    }
  }

  function setVoiceState(s) {
    if (els.mic) els.mic.dataset.state = s;
    if (els.status) {
      els.status.textContent =
        s === 'listening' ? 'Listening…' : s === 'speaking' ? 'Speaking' : s === 'thinking' ? 'Thinking…' : 'Ready';
    }
  }

  async function toggleVoice() {
    if (voice.on) {
      voiceDiag('mic_off');
      return stopVoice(true);
    }
    voiceDiag('mic_on', {
      hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      hasRecorder: typeof MediaRecorder !== 'undefined',
      mime: typeof MediaRecorder === 'undefined' ? null : pickMime(),
    });
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      voiceDiag('mic_denied', { error: String((e && e.name) || e) });
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
    cancelAnimationFrame(voice.playRaf);
    stopRecognition();
    idleWave();
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
      // The recogniser has done its job once the utterance is over; leaving
      // it running would keep a second microphone consumer alive through
      // transcription and the spoken answer.
      stopRecognition();
      var blob = new Blob(voice.chunks, { type: rec.mimeType });
      var spoke = Math.round(voice.spokeMs);
      voiceDiag('recorder_stopped', { bytes: blob.size, type: rec.mimeType, spokeMs: spoke });
      /**
       * Bytes are not speech, and this gate only counted bytes.
       *
       * A few seconds of a quiet room is comfortably more than 1200 bytes of
       * opus, so silence was uploaded like any other turn — and a decoder
       * handed silence does not return nothing, it returns something. That
       * is where "context:", "###" and a Polish shopping list came from:
       * every one of them was a capture in which nobody had said a word.
       *
       * We already know whether anyone spoke — spokeMs is what the
       * endpointer uses to decide the turn is over. Asking it here costs
       * nothing and removes the entire class at the source, before the
       * request.
       */
      /**
       * A meter reading nothing at all is a broken meter, not a quiet room.
       *
       * Requiring speech before uploading is right, but gating on a signal
       * without checking the signal exists is how this went from "sometimes
       * invents a shopper" to "does not work at all": the analyser was wired
       * to a dead stream, every reading was zero, and so every real sentence
       * was discarded as silence. A real microphone in a real room produces
       * a non-zero peak within a frame or two; an exact zero across a whole
       * capture means the level is not measuring anything.
       *
       * So when the meter never moved, trust the recorder instead and send
       * the audio. The worst case is the fabrication filter earning its keep
       * server-side. Silently disabling the feature is not on the list.
       */
      if (spoke < MIN_SPEECH_MS && (voice.peak || 0) > 0) {
        voiceDiag('discarded_silence', { bytes: blob.size, spokeMs: spoke });
        if (els.live) els.live.textContent = "I didn't catch that — tap to try again.";
        endVoiceTurn();
        return;
      }
      if (spoke < MIN_SPEECH_MS) {
        // Uploading anyway, but say so: this is the level meter failing, and
        // it is the only place that failure is visible.
        voiceDiag('level_meter_dead', { bytes: blob.size, peak: voice.peak || 0 });
      }
      if (blob.size > 1200) transcribeAndSend(blob);
      else if (voice.on) startCapture(); // too short to be speech
    };
    rec.start(100);
    setVoiceState('listening');
    if (els.wave) els.wave.className = 'wave live';
    voice.interim = '';
    if (els.live) els.live.textContent = 'Listening…';
    voice.recognition = startRecognition();
    voiceDiag('capture_start', { interim: !!voice.recognition });
    // The analyser is created inside monitorSilence, so the chime has to
    // follow it — it plays through the same AudioContext.
    monitorSilence();
    cue('start');
  }

  function pickMime() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // Energy-based endpointing — deciding the shopper has stopped talking.
  //
  // This used to compare loudness against a hard-coded `level > 12`. That
  // number is only meaningful in a silent room. On a storefront with music
  // playing, a fan, traffic, or a busy shop, the ambient level sits ABOVE 12
  // permanently — so silence was never detected, the recorder never stopped,
  // and the shopper finished speaking to an assistant that just kept
  // listening. Nothing errored; it simply never answered.
  //
  // So the threshold is measured rather than assumed. The quietest recent
  // level is the room's noise floor, and speech is what rises clearly above
  // it. A room being loud no longer means the shopper is talking.
  //
  // Silence windows mirror packages/voice/src/endpoint.ts. That module varies
  // the wait by what was actually said — 260ms after a finished question,
  // 1100ms after "something warm and" — but it needs a transcript, and here
  // there is only loudness. `base` is the right choice when nothing is known.
  // Mirrors THRESHOLDS in packages/voice/src/endpoint.ts. Pinned by a test,
  // because two copies of a number is how they drift.
  var ENDPOINT_COMPLETE_MS = 260;  // a finished question — answer promptly
  var ENDPOINT_SILENCE_MS = 550;   // nothing conclusive either way
  var ENDPOINT_HANGING_MS = 1100;  // ends mid-thought — do not cut in
  var MIN_SPEECH_MS = 250;       // shorter than this is a cough, not a turn
  var MAX_UTTERANCE_MS = 20000;  // a hard stop, so noise cannot record forever
  var IDLE_GIVE_UP_MS = 8000;    // heard nothing at all — mic muted or dead

  /** Words that almost never end an utterance. Mirrors endpoint.ts. */
  var HANGING = (
    "and but or so because if when while that which the a an my your this these those some any " +
    "to for with about from in on at of like um uh er hmm well maybe actually just is are was " +
    "were do does can could would should i i'm it's its you we they he she"
  ).split(' ');
  var QUESTION_OPENERS =
    /^(?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|what|when|where|why|who|which|how)\b/i;

  /**
   * How long to wait on silence, given what has been said so far.
   *
   * The server has carried this logic since Phase 3 and it has never run: it
   * needs a transcript, and the widget only ever had loudness, so every
   * utterance got the same 550ms. 400ms after "how much is the wool coat?"
   * means finished; the same 400ms after "something warm and" means still
   * thinking, and cutting in there is both rude and wrong.
   *
   * With interim text there is finally something to read.
   */
  function silenceWindowFor(transcript) {
    var text = (transcript || '').trim();
    if (text === '') return ENDPOINT_SILENCE_MS;
    var lastWord = (/([a-z']+)[^a-z']*$/i.exec(text) || ['', ''])[1].toLowerCase();
    if (HANGING.indexOf(lastWord) !== -1) return ENDPOINT_HANGING_MS;
    if (/[.!?]$/.test(text)) return ENDPOINT_COMPLETE_MS;
    if (QUESTION_OPENERS.test(text) && text.split(/\s+/).length >= 3) return ENDPOINT_COMPLETE_MS;
    return ENDPOINT_SILENCE_MS;
  }

  /**
   * Live interim text, from the browser's own recogniser.
   *
   * Display only. The authoritative transcript still comes from the server,
   * which is language-locked and identical in every browser — this just
   * fills the gap between speaking and being answered, which was silent and
   * made the widget feel like it had stopped responding.
   *
   * It also, finally, gives the endpointer a transcript to judge.
   *
   * Firefox has no SpeechRecognition; there it simply does not run and
   * everything else behaves exactly as before.
   */
  function startRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    try {
      var rec = new SR();
      /**
       * The storefront's language, then the browser's — never a hard-coded
       * en-US.
       *
       * A shopper on a Spanish storefront speaking Spanish got interim text
       * in English, because the recogniser had been pinned to en-US and
       * will cheerfully transliterate whatever it hears into the language
       * it was told to expect. `<html lang>` is what the merchant's theme
       * declares, which is the best available statement of who the shop is
       * for; the browser's own language is the fallback.
       *
       * The authoritative transcript is unaffected either way — the server
       * detects the language independently — so a wrong guess here costs
       * the live caption, not the answer.
       */
      rec.lang =
        (SCRIPT && SCRIPT.dataset.lang) ||
        document.documentElement.getAttribute('lang') ||
        navigator.language ||
        'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        voice.interim = text.trim();
        if (voice.interim && els.live) els.live.textContent = voice.interim;
      };
      // A recogniser that dies must never take the recording with it.
      rec.onerror = function () {};
      rec.onend = function () {};
      rec.start();
      return rec;
    } catch (e) {
      return null;
    }
  }

  function stopRecognition() {
    if (!voice.recognition) return;
    try {
      voice.recognition.onresult = null;
      voice.recognition.stop();
    } catch (e) {}
    voice.recognition = null;
  }

  function monitorSilence() {
    if (!voice.ctx) {
      voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
      voice.analyser = voice.ctx.createAnalyser();
      voice.analyser.fftSize = 512;
    }
    /**
     * Rewire the analyser whenever the microphone itself changes.
     *
     * This used to be part of the block above, so the graph was built once
     * and bound to whatever stream existed on the FIRST voice turn. Ending a
     * turn releases the microphone, so the next turn calls getUserMedia
     * again and gets a new stream — while the analyser stayed connected to
     * the old, ended one. A dead track produces all-zero frequency data, so
     * every reading after the first turn was level 0, floor 0, peak 0.
     *
     * It was invisible for as long as nothing depended on the level: the
     * endpointer's unconditional backstop stopped the recorder anyway and
     * the audio was uploaded regardless. The moment the upload started
     * asking "did anyone actually speak", the answer was permanently no and
     * voice stopped working entirely from the second turn on.
     */
    if (voice.wiredTo !== voice.stream) {
      if (voice.source) {
        try {
          voice.source.disconnect();
        } catch (e) {
          /* already gone with its stream */
        }
      }
      voice.source = voice.ctx.createMediaStreamSource(voice.stream);
      voice.source.connect(voice.analyser);
      voice.wiredTo = voice.stream;
    }
    // Resume matters on iOS/Safari, where the context starts suspended and
    // every level reads 0 — which looks exactly like silence forever.
    if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();

    var buf = new Uint8Array(voice.analyser.frequencyBinCount);
    var startedAt = performance.now();
    voice.silenceSince = startedAt;
    voice.spokeMs = 0;
    // Both seeded from the signal, never assumed. `floorRaw` chases the
    // quietest level seen, `peak` the loudest.
    var floorRaw = 255;
    var peak = 0;
    var last = startedAt;

    function tick() {
      if (!voice.on) return;
      voice.analyser.getByteFrequencyData(buf);
      // The same data the endpointer reads, shown to the shopper.
      drawWave(buf, 2.2);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i];
      var level = sum / buf.length;
      var now = performance.now();
      var dt = now - last;
      last = now;

      // Fall to a new quiet level at once, climb back very slowly — so a gap
      // between words re-reads the room honestly while a passing truck does
      // not raise the floor for good.
      if (level < floorRaw) floorRaw = level;
      else floorRaw += (level - floorRaw) * 0.002;
      if (level > peak) peak = level;
      else peak *= 0.9997;
      // Published so the upload gate can tell "the room was quiet" from "the
      // meter is not working" — see the peak check in rec.onstop.
      voice.peak = peak;

      // The floor is CAPPED against the peak, and that cap is the whole fix.
      //
      // Taking the plain minimum meant the floor calibrated to whatever was
      // heard first. Press the mic and start talking — which is what everyone
      // does — and the first frames are speech, so the floor became the
      // speaking level and the threshold then demanded you exceed your own
      // voice by half again. Nothing ever registered as speech, so nothing
      // ever registered as the end of it, and the recorder ran forever.
      //
      // A real noise floor is never half the peak, so clamping there keeps a
      // speech-poisoned reading from swallowing the signal.
      voice.floor = Math.min(floorRaw, peak * 0.5);

      // Whichever is higher: clear of the room, or a real fraction of how
      // loud this speaker actually is. The first handles a noisy shop, the
      // second a quiet room with a soft voice.
      var threshold = Math.max(6, voice.floor + 6, peak * 0.3);
      var speaking = level > threshold;

      if (speaking) {
        voice.silenceSince = now;
        voice.spokeMs += dt;
        // Barge-in: talking over playback cancels audio AND the generation.
        if (voice.playing && voice.spokeMs > 160) {
          stopPlayback();
          if (inflight) inflight.abort();
        }
      }

      var recording = voice.recorder && voice.recorder.state === 'recording';
      // Varies with what has actually been said, where a transcript exists.
      var window_ = silenceWindowFor(voice.interim);
      var quietLongEnough =
        voice.spokeMs > MIN_SPEECH_MS && now - voice.silenceSince > window_;
      // UNCONDITIONAL. The previous version required speech to have been
      // detected before it would fire, which made it useless in exactly the
      // case it existed for: when speech detection is what failed, the
      // backstop was disabled too and the recorder never stopped at all.
      var tooLong = now - startedAt > MAX_UTTERANCE_MS;
      // Nothing heard at all — a muted or dead mic. Stop and start a fresh
      // capture rather than sitting in a listening state that cannot end.
      var heardNothing = voice.spokeMs === 0 && now - startedAt > IDLE_GIVE_UP_MS;

      var reading = {
        level: Math.round(level * 10) / 10,
        floor: Math.round(voice.floor * 10) / 10,
        peak: Math.round(peak * 10) / 10,
        threshold: Math.round(threshold * 10) / 10,
        spokeMs: Math.round(voice.spokeMs),
        elapsedMs: Math.round(now - startedAt),
        waitMs: window_,
        words: voice.interim ? voice.interim.split(/s+/).length : 0,
      };

      if (recording && (quietLongEnough || tooLong || heardNothing)) {
        reading.reason = quietLongEnough ? 'silence' : tooLong ? 'max-duration' : 'no-speech';
        voiceDiag('endpoint', reading);
        voice.recorder.stop();
        return;
      }

      // A heartbeat while still listening. The failure mode being chased is
      // one where the recorder NEVER stops — so a report sent only on stop is
      // never sent at all, which is exactly why the server saw nothing the
      // last two times. This makes "still listening, and here is why" visible.
      if (now - (voice.lastBeat || 0) > 3000) {
        voice.lastBeat = now;
        voiceDiag('listening', reading);
      }

      voice.raf = requestAnimationFrame(tick);
    }
    voice.raf = requestAnimationFrame(tick);
  }

  /** The storefront's language as a bare ISO-639-1 code, or '' if unset. */
  function pageLang() {
    try {
      var l = (document.documentElement.getAttribute('lang') || '').trim().toLowerCase();
      // "en-GB" and "pt-BR" both carry a region the decoder does not want.
      return /^[a-z]{2}/.test(l) ? l.slice(0, 2) : '';
    } catch (e) {
      return '';
    }
  }

  async function transcribeAndSend(blob) {
    setVoiceState('thinking');
    try {
      var r = await fetch(API + '/api/voice/transcribe', {
        method: 'POST',
        // The storefront's own locale, so transcription is told the language
        // instead of guessing it from a second of audio. Shopify renders
        // <html lang> per locale, so on a translated store this is the
        // language the shopper chose.
        headers: { 'content-type': blob.type || 'audio/webm', 'x-storefront-lang': pageLang() },
        body: blob,
      });
      var d = await r.json();
      var text = (d && d.text ? d.text : '').trim();
      // Nothing heard. Ending the turn says so; restarting silently did not.
      if (!text) { voiceDiag('transcript_empty'); endVoiceTurn(); return; }
      els.live.textContent = text;
      addMsg('user', text);
      state.messages.push({ role: 'user', text: text });
      persist();
      stream(text, true);
    } catch (e) {
      voiceDiag('transcribe_error', { error: String((e && e.message) || e) });
      endVoiceTurn();
    }
  }

  /**
   * Close the voice turn: chime down, release the microphone, back to idle.
   *
   * Called from every path a turn can end on — spoken answer finished,
   * nothing transcribed, transcription failed, the turn errored. Each of
   * those used to restart capture instead, so a failure was indistinguishable
   * from success and the mic stayed open through both.
   */
  function endVoiceTurn() {
    if (!voice.on) return;
    cue('end');
    voiceDiag('turn_end');
    stopVoice(true);
  }

  function enqueueSpeech(text) {
    voice.queue.push(text);
    if (!voice.playing) playNext();
  }

  async function playNext() {
    var text = voice.queue.shift();
    if (!text) {
      voice.playing = null;
      // ONE SHOT: press, speak, get answered, done — the way every mic a
      // shopper has used behaves.
      //
      // This used to hand the turn straight back and start listening again.
      // An always-open mic is a different product: it holds the microphone
      // indefinitely, records the room between questions, and gives no
      // moment where the shopper can tell whether it is still listening. It
      // also meant a failed turn looped silently, which is most of why voice
      // looked dead rather than broken.
      endVoiceTurn();
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
      watchPlayback(audio);
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

  // Set when the server returns 402 — the merchant is out of plan allowance.
  // Deliberately NOT part of persisted state: if they upgrade mid-session the
  // shopper should recover on the next page load, not stay stuck.
  var suspended = false;

  function stream(text, isVoice) {
    var bubble = addMsg('bot', '');
    // A new turn owns a new rail; the previous one stays where it is, beside
    // the answer it belongs to.
    turnUi.bubble = bubble;
    turnUi.rail = null;

    if (suspended) {
      bubble.textContent =
        'I can’t answer right now, but the team can help — leave an email and someone will follow up.';
      els.status.textContent = 'Ready';
      return;
    }

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
        // 402 means the merchant is out of plan allowance, or their shop is
        // frozen. That is between us and the merchant — the shopper did
        // nothing wrong and must never see a billing message, a plan name, or
        // a number. So the assistant simply steps aside and points at the
        // channel that still works.
        if (res.status === 402) {
          dropRail();
          bubble.textContent =
            'I can’t answer right now, but the team can help — leave an email and someone will follow up.';
          suspended = true;
          return;
        }
        // 429 is the rate limiter, which is temporary by definition, so it
        // gets a "try shortly" rather than a dead end.
        if (res.status === 429) {
          dropRail();
          bubble.textContent = 'A lot of people are asking at once. Try that again in a few seconds.';
          return;
        }
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
          } else if (ev === 'trace') {
            /**
             * Say what it is doing while it does it.
             *
             * A shop assistant says "let me check" and walks off; they do
             * not stare at you in silence and then recite an answer. The
             * search takes a second or two and the panel showed three
             * animated dots for all of it — identical to the dots shown
             * while the model thinks, so the shopper could not tell whether
             * anything was happening on their behalf.
             *
             * Only until the first real text arrives, and only if nothing
             * has been painted yet, so it can never overwrite an answer.
             */
            if (!shown && d && d.type === 'tool_start') {
              var doing =
                d.detail === 'search_catalog' || d.detail === 'get_product'
                  ? 'Checking the catalog…'
                  : d.detail === 'get_policy'
                    ? 'Checking the store policy…'
                    : d.detail === 'add_to_cart'
                      ? 'Adding that to your cart…'
                      : null;
              if (doing) els.status.textContent = doing;
            }
          } else if (ev === 'products') {
            /**
             * The FINAL list replaces the early one, empty included.
             *
             * The early cards are whatever the first search returned, sent
             * fast so something is on screen while the model writes. For a
             * query that matched nothing that is the browse fallback — so
             * "cheapest shoes" in a snowboard shop showed a gift card and a
             * snowboard under "What I found", beside a reply that had found
             * nothing. Clearing is the honest state, and the pictures are
             * what a shopper believes over the words.
             */
            if (d.final && d.products.length === 0) dropRail();
            else renderCards(d.products, d.products.length === 1 ? 'The match' : 'What I found');
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
            if (turnUi.rail && turnUi.rail.querySelector('.card.skel')) dropRail();
            // Products to look at, or an answer too long to hear comfortably,
            // are both reasons to stop being a voice bubble.
            if (turnUi.rail || String(d.reply || '').length > 220) expand();
            els.status.textContent = d.grounded ? 'Ready' : 'Passed to the team';
            persist();
            // A turn that produced no audio never reaches playNext, so
            // nothing would close it and the microphone would stay open on a
            // finished conversation.
            if (isVoice && !voice.playing && voice.queue.length === 0) endVoiceTurn();
          } else if (ev === 'error') {
            flush();
            bubble.textContent = d.message;
          }
        }
        return pump();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        dropRail();
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

  /**
   * Is this the merchant previewing their own theme, rather than a shopper?
   *
   * Shopify sets `Shopify.designMode` inside the theme editor and nowhere else.
   */
  function inThemeEditor() {
    try {
      return !!(window.Shopify && window.Shopify.designMode);
    } catch (e) {
      return false;
    }
  }

  /**
   * Say out loud what the widget decided.
   *
   * Every path that ends in "render nothing" used to be silent: holdout,
   * disabled, and a mount that never ran all looked identical from the outside
   * — an empty corner and an empty console. That is indistinguishable from a
   * broken install, and it cost a full debugging session to tell apart states
   * the widget already knew. One line each is a rounding error next to the
   * theme's own console noise, and it is the difference between "I can't see
   * the button" and a diagnosis.
   */
  function say(msg) {
    try {
      console.info('[StoreAgent] ' + msg);
    } catch (e) {}
  }

  function mount() {
    var sid = sessionId();
    state.sessionId = state.sessionId || sid;
    var shop = SHOP;

    // The theme editor is the merchant looking at their own store. They are
    // not a shopper, and putting them in the experiment breaks two things:
    //
    //   - A merchant who draws the holdout installs the app, enables it, and
    //     sees NOTHING — silently, permanently (the arm is sticky per browser),
    //     with no way to tell that from a broken install. One in five merchants
    //     would conclude the app does not work on their first run.
    //   - Their sessions land in the control group, so the incrementality
    //     number is computed partly from people who were never shopping.
    //
    // So: no exposure beacon at all from here — nothing about a preview should
    // reach the experiment — and render unconditionally. The merchant's own
    // on/off setting is still honoured, because `render` bails on
    // `enabled: false`. Only the RANDOM assignment is bypassed, never an
    // explicit choice.
    if (inThemeEditor()) {
      say('theme editor detected — always shown here, and not counted in the experiment');
      fetch(API + '/api/config?shop=' + encodeURIComponent(shop))
        .then(function (r) {
          return r.json();
        })
        .then(render)
        .catch(function () {
          render({ enabled: true });
        });
      return;
    }

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
        if (d && d.arm === 'holdout') {
          say('not shown: this browser is in the holdout (experiment control group)');
          return;
        }
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

  /**
   * Measure the mounted launcher and report it.
   *
   * "It mounted" and "the merchant can see it" are different claims, and the
   * gap between them is where this failure lives: the widget can be in the DOM,
   * correct, and painted off-screen, at zero size, transparent, or underneath
   * something. None of that is visible from the server, and asking a merchant
   * to read DevTools has a poor success rate.
   *
   * elementFromPoint at the launcher's own centre is the decisive test: if it
   * returns anything other than our host, something is covering us, and the
   * reply names the thing.
   *
   * Theme editor only — this is a merchant looking at their own preview. It is
   * never sent from a shopper's page.
   */
  function selfCheck() {
    if (!inThemeEditor()) return;
    try {
      requestAnimationFrame(function () {
        var r = launcher.getBoundingClientRect();
        var cs = getComputedStyle(launcher);
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var hit = document.elementFromPoint(cx, cy);
        // Computed width/height vs the measured rect is the discriminator:
        // "56px" with a 0x0 rect means the rule applied but an ancestor is not
        // rendered; "0px"/"auto" would mean the stylesheet never matched.
        var hs = getComputedStyle(host);
        var hr = host.getBoundingClientRect();
        var chain = [];
        for (var n = host.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
          var ns = getComputedStyle(n);
          chain.push(n.tagName + ':' + ns.display + (ns.visibility === 'hidden' ? '/hidden' : ''));
        }
        var diag = {
          build: BUILD,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          computed: { w: cs.width, h: cs.height, right: cs.right, bottom: cs.bottom },
          hostStyle: { display: hs.display, visibility: hs.visibility, zIndex: hs.zIndex, position: hs.position },
          hostRect: { w: Math.round(hr.width), h: Math.round(hr.height) },
          hostConnected: host.isConnected === true,
          shadowKids: root.childNodes.length,
          ancestors: chain,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          style: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex, position: cs.position },
          onTop: hit === host,
          covering: hit === host ? null : (hit ? (hit.tagName + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '')) : 'nothing'),
          inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
        };
        say('self-check ' + JSON.stringify(diag));
        fetch(API + '/api/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shop: SHOP, diag: diag }),
          keepalive: true,
        }).catch(function () {});
      });
    } catch (e) {
      say('self-check failed: ' + e.message);
    }
  }

  /**
   * Read a brand token the app embed block may have set on the host.
   * Returns '' when the theme did not supply one.
   */
  function themeToken(name) {
    try {
      return getComputedStyle(host).getPropertyValue(name).trim();
    } catch (e) {
      return '';
    }
  }

  function render(cfg) {
    if (cfg && cfg.enabled === false) {
      say('not shown: disabled in the StoreAgent app settings');
      return;
    }
    if (cfg) {
      /**
       * The theme editor wins over the server default.
       *
       * Brand tokens have two sources: the app embed block, which writes
       * `--sa-accent` into a page <style> rule, and the admin settings behind
       * /api/config. Applying the server value here as an INLINE style beat the
       * theme's rule unconditionally, so a merchant who picked red in the theme
       * editor watched the widget render in our built-in green and had no way
       * to tell why — their setting was saved and correct, and silently
       * overwritten a moment later.
       *
       * A value already on the host came from the block the merchant is looking
       * at, so it is the more specific intent and is left alone. The server
       * value stays as the fallback for themes that do not supply one.
       */
      if (cfg.accentColor && themeToken('--sa-accent') === '') {
        host.style.setProperty('--sa-accent', cfg.accentColor);
      }
      if (cfg.cornerRadius != null && themeToken('--sa-radius') === '') {
        host.style.setProperty('--sa-radius', cfg.cornerRadius + 'px');
      }
      if (cfg.position === 'left') host.setAttribute('data-position', 'left');
      state.greeting = cfg.greeting || '';
    }
    document.body.appendChild(host);
    // Confirms the launcher is in the DOM. If this prints and the corner still
    // looks empty, the widget mounted and something is covering or clipping it
    // — a different problem from "never rendered", and previously they were
    // indistinguishable.
    say('ready (' + BUILD + ') — launcher mounted bottom-' + (host.getAttribute('data-position') === 'left' ? 'left' : 'right'));
    selfCheck();
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
