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
  var BUILD = '2026-09-14.1';

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
/* Pushed to the right of the name, left of the close button. Quiet on
   purpose — it is a control most shoppers will never touch, and the one
   who needs it is looking for it. margin-left:auto is what keeps the
   header layout intact without a wrapper. */
.lang{margin-left:auto;font:inherit;font-size:11px;color:var(--muted);
  background:var(--sunk2);border:1px solid var(--line);border-radius:7px;
  padding:3px 5px;max-width:96px;cursor:pointer;appearance:none;
  text-align:right;transition:color .15s var(--ease),border-color .15s var(--ease)}
.lang:hover{color:var(--ink)}
.lang:focus-visible{outline:2px solid var(--sa-accent,#1b3a34);outline-offset:1px}
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
/* The Add button, over the image rather than below the price.
   Below would push every card taller for a control that only some cards have,
   and a rail of uneven cards reads as broken. Always visible — revealing it on
   hover hides it entirely on the phones most shoppers are using. */
.card .add{position:absolute;bottom:7px;right:7px;z-index:1;
  border:0;border-radius:999px;padding:5px 11px;font:inherit;font-size:11.5px;font-weight:600;
  background:var(--accent);color:#fff;cursor:pointer;
  box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .12s ease,opacity .12s ease}
.card .add:hover{transform:translateY(-1px)}
.card .add:focus-visible{outline:2px solid #fff;outline-offset:1px}
.card .add[disabled]{opacity:.85;cursor:default;transform:none}
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
      /**
       * The shopper picks the language they want to speak, not the merchant.
       *
       * A store has one language; its customers do not. On an Indian
       * storefront one customer speaks Hindi and the next speaks English,
       * and neither the page nor the merchant can answer for both. The
       * decoder cannot either — Hindi and Urdu are one spoken language in
       * two scripts, which is how an English sentence came back as Urdu and
       * then as Turkish. The person talking is the only one who knows.
       *
       * Starts on whatever the merchant set as their default, and the
       * choice is remembered for next time.
       */
      '<select class="lang" aria-label="Language you want to speak"></select>' +
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
    els.lang = p.querySelector('.lang');
    fillLanguages();
    els.form = p.querySelector('form');
    els.input = p.querySelector('textarea');
    els.send = p.querySelector('.send');
    els.mic = p.querySelector('.mic');
    els.voicebar = p.querySelector('.voicebar');
    els.wave = p.querySelector('.voicebar .wave');
    els.waveBars = [].slice.call(p.querySelectorAll('.voicebar .wave i'));
    els.live = p.querySelector('.voicebar .live');

    els.mic.addEventListener('click', function () {
      withVoice(function (v) { v.toggle(); });
    });
    // Start fetching before the press lands, so the first voice turn does not
    // pay for the chunk. Both events, because a keyboard user never hovers.
    els.mic.addEventListener('pointerenter', prefetchVoice);
    els.mic.addEventListener('focus', prefetchVoice);
    p.querySelector('.voiceoff').addEventListener('click', function () {
      // Nothing to stop if the chunk was never loaded, and loading it in order
      // to stop it would be absurd.
      if (voiceApi) voiceApi.stop(true);
    });
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

  /**
   * The opening suggestions, before there is anything on screen to narrow.
   *
   * Page-shaped guesses, which is all they can be: nothing has been searched
   * yet. Once an answer arrives the server replaces these with chips derived
   * from the products actually found — see `showChips`.
   */
  function chips(page) {
    var sets = {
      product: ['Will this fit me?', 'When would it arrive?', 'Show me similar'],
      collection: ['Help me choose', 'What’s most popular?', 'Under $100'],
      cart: ['Shipping cost?', 'Return policy', 'Anything I’m missing?'],
      other: ['What do you sell?', 'Shipping & returns', 'Help me choose'],
    };
    showChips(
      (sets[page.type] || sets.other).map(function (label) {
        return { label: label, message: label };
      }),
    );
  }

  /**
   * Render a chip row. `[]` clears it, which is a real instruction.
   *
   * A row left over from the previous answer suggests narrowing products that
   * are no longer on screen — the same mistake the early product cards made,
   * where the pictures contradicted the words, and the pictures are what people
   * believe.
   *
   * `label` is what the shopper reads; `message` is what gets sent, and the
   * server writes it so that the deterministic lane recognises it. That is why
   * tapping "Cheaper" costs nothing: it never reaches the model.
   */
  function showChips(list) {
    if (!els.chips) return;
    els.chips.innerHTML = '';
    (list || []).forEach(function (chip, i) {
      if (!chip || !chip.label) return;
      var b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = chip.label;
      b.style.animationDelay = 60 + i * 55 + 'ms';
      b.addEventListener('click', function () {
        els.input.value = chip.message || chip.label;
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
        if (!voiceIsOn()) withVoice(function (v) { v.toggle(); });
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
    if (role === 'user' && !voiceIsOn()) expand();
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
  /**
   * Report a funnel step the server cannot observe for itself.
   *
   * Fire and forget, and never allowed to matter: a merchant's funnel is worth
   * less than the shopper's turn, so a failure here is silent by design.
   */
  function step(name) {
    try {
      if (!state.sessionId) return;
      fetch(API + '/api/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shop: SHOP, sessionId: state.sessionId, step: name }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {
      /* analytics must never cost a shopper anything */
    }
  }

  /**
   * The one variant a card may add, or null when there is a choice to make.
   *
   * A tap must mean exactly one thing. With two sizes in stock there is no way
   * to know which the shopper wants, and a wrong variant is discovered at
   * checkout — so the button simply is not offered and the card stays a link to
   * the product page, where the choice belongs.
   *
   * This is the same reasoning that keeps "add this" out of the deterministic
   * lane server-side: act only where the input is unambiguous.
   */
  function soleVariant(p) {
    var vs = (p && p.variants) || [];
    var open = vs.filter(variantAvailable);
    return open.length === 1 && open[0] && open[0].id ? open[0] : null;
  }

  /**
   * Add a variant to the cart and report what the cart says afterwards.
   *
   * The confirmation comes from the server's reading of the cart, never from
   * here: a widget that wrote "Added — £189.00" from its own copy of the price
   * would be stating a total nobody had checked.
   */
  async function addVariant(variant, title) {
    try {
      var r = await fetch(API + '/api/cart/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          shop: SHOP,
          variantId: variant.id,
          quantity: 1,
        }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok || !d.ok) throw new Error(d.error || 'add failed');
      if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
      addMsg('bot', d.reply || 'Added to your cart.');
      state.messages.push({ role: 'bot', text: d.reply || 'Added to your cart.' });
      persist();
      return true;
    } catch (e) {
      // Never a silent failure on a button the shopper pressed. Naming the
      // product matters: "that didn't work" beside four cards says nothing.
      addMsg('bot', 'I couldn’t add the ' + (title || 'item') + ' — you can add it from its page.');
      return false;
    }
  }

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

      /**
       * An Add button, only where a tap can mean one thing.
       *
       * Appended rather than built into the innerHTML above because the card may
       * be an anchor: a button inside a link is not a valid nesting and a click
       * on it would navigate as well as add. Positioned over the image by CSS,
       * and it stops the event so the card's own navigation does not fire.
       */
      var only = soleVariant(p);
      if (only && !allOut) {
        var add = document.createElement('button');
        add.className = 'add';
        add.type = 'button';
        add.textContent = 'Add';
        add.setAttribute('aria-label', 'Add ' + (p.title || 'item') + ' to cart');
        add.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (add.disabled) return;
          add.disabled = true;
          add.textContent = '…';
          addVariant(only, p.title).then(function (ok) {
            add.textContent = ok ? 'Added' : 'Add';
            // Left disabled on success: tapping again would add a second one,
            // which is almost never what the shopper meant by a tap.
            add.disabled = ok;
          });
        });
        c.querySelector('.ph').appendChild(add);
      }
      if (href) {
        // Plain navigation in the same tab. The session lives in
        // sessionStorage, so the conversation is still there when the panel
        // reopens on the product page.
        c.addEventListener('click', function () {
          persist();
          /**
           * The one funnel step the server cannot see.
           *
           * Following a card is a navigation AWAY from us, so nothing
           * server-side observes it. `keepalive` because the page is about to
           * unload and an ordinary fetch would be cancelled mid-flight.
           */
          step('card_tapped');
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

  // ---------- voice, loaded on demand -------------------------------------
  //
  // The microphone is the heaviest thing this widget does and the least often
  // used, so it does not ship with the page. `ARCHITECTURE §3.1` asked for
  // exactly this — "voice chunk loads only when the mic toggle is first
  // pressed" — and until now it was one file carrying loader, panel and voice
  // against the loader's own 15 KB budget.
  //
  // A shopper who never presses the microphone downloads none of it.

  var voiceApi = null;
  var voiceLoading = null;

  /**
   * Report a milestone to the server.
   *
   * Lives here rather than in the voice chunk because it is not voice-specific
   * — the language picker below sends one too — and because two copies of a
   * beacon means two copies of the rule about what must never be in it. No
   * audio and no transcript: only what happened, and the levels.
   *
   * Voice is the one path that cannot be tested from outside a browser, since
   * it needs a real microphone. Two attempts at the endpointing bug were made
   * blind, both wrong, and the server saw nothing either time — a recorder that
   * never stops never sends audio, so the logs looked identical to "nobody
   * tried it". These lines are the difference between diagnosing and guessing.
   */
  function voiceDiag(event, fields) {
    try {
      var payload = { voice: event, build: BUILD };
      for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k)) payload[k] = fields[k];
      say('voice ' + event + ' ' + JSON.stringify(fields || {}));
      fetch(API + '/api/diag?shop=' + encodeURIComponent(SHOP || ''), {
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
   * Everything the voice chunk is given.
   *
   * References for the two objects that are mutated in place, an accessor for
   * the one that is replaced wholesale. `CONFIG` is reassigned when
   * /api/config answers, so handing over its current value would pin the chunk
   * to an empty object for the life of the page.
   */
  function voiceHost() {
    return {
      API: API,
      SHOP: SHOP,
      BUILD: BUILD,
      els: els,
      state: state,
      config: function () {
        return CONFIG;
      },
      // `data-lang` on the embed tag, an override a merchant may already be
      // relying on. `document.currentScript` is only readable while the host
      // script is executing, so the chunk cannot look it up for itself.
      scriptLang: (SCRIPT && SCRIPT.dataset.lang) || '',
      say: say,
      diag: voiceDiag,
      persist: persist,
      addMsg: addMsg,
      stream: stream,
      chosenLang: chosenLang,
      pageLang: pageLang,
      // Barge-in: speaking over the assistant must abort the turn being
      // generated, not merely silence the audio already produced.
      abortInflight: function () {
        if (inflight) inflight.abort();
      },
    };
  }

  /**
   * Fetch and initialise the chunk. Idempotent, and safe to call eagerly.
   *
   * A classic script rather than a module `import()`: both are governed by the
   * merchant's `script-src`, which already has to allow this origin for
   * widget.js to run at all, but a cross-origin module import additionally
   * requires CORS on the response — one more thing to be misconfigured on a
   * storefront we do not control, in exchange for nothing.
   *
   * Cache-busted by BUILD so a fix reaches a browser holding a stale copy;
   * widget.js is unversioned and cached, and a mismatched pair is the one
   * failure mode a split introduces.
   */
  function loadVoice() {
    if (voiceApi) return Promise.resolve(voiceApi);
    if (voiceLoading) return voiceLoading;
    voiceLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = API + '/widget-voice.js?v=' + encodeURIComponent(BUILD);
      s.async = true;
      s.onload = function () {
        var factory = window.__storeagentVoice;
        // Read once and remove: a global that outlives its handoff is a name
        // another script on the merchant's page can collide with.
        try {
          delete window.__storeagentVoice;
        } catch (e) {
          window.__storeagentVoice = undefined;
        }
        if (typeof factory !== 'function') {
          reject(new Error('voice chunk did not register'));
          return;
        }
        try {
          voiceApi = factory(voiceHost());
          resolve(voiceApi);
        } catch (e) {
          reject(e);
        }
      };
      s.onerror = function () {
        reject(new Error('voice chunk failed to load'));
      };
      document.head.appendChild(s);
    });
    // A failed load must not be cached as a permanent refusal: the shopper may
    // simply have been offline for a moment, and the next press should retry.
    voiceLoading.catch(function () {
      voiceLoading = null;
    });
    return voiceLoading;
  }

  /**
   * Start the chunk downloading before it is needed.
   *
   * Called on pointerenter/focus of the microphone, the same trick the panel
   * already uses: by the time a press lands the script is usually parsed, so
   * the first voice turn does not pay for it. Costs nothing if never pressed —
   * a prefetched script that goes unused is one cached request.
   */
  function prefetchVoice() {
    if (!canListen()) return;
    loadVoice().catch(function () {});
  }

  /** Run something with the chunk, loading it first if this is the first press. */
  function withVoice(fn) {
    loadVoice().then(fn, function (err) {
      // The microphone is an enhancement; text still works. Say so rather than
      // leaving a pressed button that does nothing.
      say('voice chunk failed: ' + (err && err.message));
      addMsg('bot', 'I couldn’t start the microphone — type instead and I’ll help the same way.');
    });
  }

  /** Is a voice turn in progress? False before the chunk has ever loaded. */
  function voiceIsOn() {
    return !!(voiceApi && voiceApi.isOn());
  }

  /**
   * The language the SHOPPER chose, remembered across visits.
   *
   * localStorage rather than the session: someone who speaks Hindi on
   * Monday still speaks Hindi on Tuesday, and being asked again every
   * visit is the kind of small insult that stops people using a feature.
   */
  var LANG_KEY = 'storeagent.lang';
  var CONFIG = {};

  function chosenLang() {
    try {
      var v = localStorage.getItem(LANG_KEY);
      if (v) return v;
    } catch (e) {
      /* private mode; fall through to the merchant default */
    }
    return CONFIG.voiceLanguage || 'en';
  }

  function fillLanguages() {
    if (!els.lang) return;
    // Server-supplied so the list cannot drift from what the decoder and
    // the admin dropdown accept.
    var list = CONFIG.voiceLanguages || [['en', 'English']];
    var now = chosenLang();
    els.lang.innerHTML = list
      .map(function (pair) {
        var code = pair[0];
        var label = pair[1];
        return (
          '<option value="' + code + '"' + (code === now ? ' selected' : '') + '>' + label + '</option>'
        );
      })
      .join('');
    els.lang.addEventListener('change', function () {
      try {
        localStorage.setItem(LANG_KEY, els.lang.value);
      } catch (e) {
        /* the choice still applies to this page */
      }
      voiceDiag('language_chosen', { lang: els.lang.value });
    });
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

    // `shop` rides in the QUERY STRING as well as the body, because two things
    // upstream of the body need it. The CORS preflight has no body at all and
    // still has to decide whether this origin may call us, and the rate
    // limiter runs before the body is parsed — without this every merchant
    // shared one bucket and throttled each other. The body copy is what the
    // turn itself uses.
    fetch(API + '/api/chat?shop=' + encodeURIComponent(SHOP || ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        message: text,
        sessionId: state.sessionId,
        shop: SHOP,
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
          } else if (ev === 'chips') {
            // Derived server-side from the products actually found, and written
            // so the deterministic lane can answer them — so tapping one is
            // typically instant and free.
            showChips(d.chips);
          } else if (ev === 'delta') {
            pending += d.text;
            schedule();
          } else if (ev === 'speak') {
            // Already grounded and settled server-side — safe to voice.
            //
            // Only reachable during a voice turn, which cannot start without
            // the chunk, so a missing voiceApi here means the turn was text and
            // the server sent speech for it. Dropping it is correct.
            if (voiceApi) voiceApi.enqueueSpeech(d.text);
          } else if (ev === 'reset') {
            // Grounding tripwire fired — discard the partial answer entirely,
            // and drop any queued audio before it can be spoken.
            shown = '';
            pending = '';
            if (voiceApi) voiceApi.stopPlayback();
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
            if (isVoice && voiceApi && !voiceApi.isSpeaking()) voiceApi.endTurn();
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

    fetch(API + '/api/exposure?shop=' + encodeURIComponent(shop || ''), {
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
        fetch(API + '/api/diag?shop=' + encodeURIComponent(SHOP || ''), {
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
    // Kept at module scope too: the language picker is built when the panel
    // mounts, which is long after render() has returned.
    if (cfg) CONFIG = cfg;
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
    /**
     * Restoring a panel is not a request to talk.
     *
     * open() defaults to voice-first, which is right when a shopper presses
     * the launcher — and wrong here. This runs on every page load where the
     * panel was left open, so the microphone switched itself on for anyone
     * who reloaded or clicked through to another product, with no gesture
     * behind it. Grabbing a microphone unasked is alarming even when it
     * works, and browsers increasingly refuse it outright without a gesture.
     */
    if (state.open) open({ voice: false });
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
