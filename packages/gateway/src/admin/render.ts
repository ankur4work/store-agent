import type { Incrementality } from '@storeagent/attribution';
import { PLANS, PLAN_ORDER } from '@storeagent/billing';
import { accentIsAccessible, contrastWithWhite, type ShopSettings } from './settings.js';

/**
 * Server-rendered merchant admin.
 *
 * **Deviation from ARCHITECTURE §11 (Remix + Polaris + App Bridge React).**
 * The admin is a handful of forms and numbers. Remix + React + Polaris is
 * ~300KB of dependencies and a build step for that, on a surface where Shopify
 * explicitly grades load performance. Server-rendered HTML with Polaris-shaped
 * styling gets the same native feel, ships nothing to build, and — since I
 * cannot open a browser here — is directly assertable in tests, which a React
 * render is not. App Bridge is still loaded, because embedded auth and the
 * session token genuinely require it.
 *
 * Revisit if the admin grows real interactivity (conversation browsing, live
 * charts). Until then this is less to maintain and faster for the merchant.
 *
 * Every interpolation goes through `esc`. Settings are merchant-supplied and
 * land in both HTML and CSS.
 */

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface AdminViewModel {
  readonly shop: string;
  readonly apiKey: string;
  readonly host: string;
  readonly settings: ShopSettings;
  readonly stats: {
    readonly activeSessions: number;
    readonly mode: 'live' | 'demo';
    readonly model: string;
  };
  readonly lift: Incrementality;
  readonly liftSummary: string;
  readonly recommendedHoldout: number;
  readonly unmatchedOrders: number;
  /** Absent when billing is not configured on this deployment. */
  readonly billing?: {
    readonly planName: string;
    readonly planId: string;
    readonly status: string;
    readonly used: number;
    readonly included: number;
    readonly remaining: number;
    readonly overageMinor: number;
    readonly verdict: string;
    /** True while charges are simulated — must be visible, not hidden. */
    readonly test: boolean;
  };
  readonly saved?: boolean;
  readonly errors?: readonly string[];
  /**
   * Which route is being rendered. Billing lives on its own page: choosing a
   * plan is a deliberate, occasional errand, and a chooser wedged between
   * usage and appearance made the daily page longer for everyone who was not
   * changing plan that day.
   */
  readonly page?: 'home' | 'plan';
}

const money = (minor: number): string =>
  `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (r: number): string => `${(r * 100).toFixed(2)}%`;


/**
 * The plan card.
 *
 * Shows usage against the allowance as a bar, because a number alone does not
 * convey "you are nearly out". The warning appears at 80% rather than at the
 * wall: a merchant who discovers the limit by the widget stopping is a
 * merchant who churns.
 */
/**
 * The four figures a merchant opens the app to check.
 *
 * They existed before as label/value rows inside a "Status" card, which made
 * the page a wall of identical text and buried the two numbers that actually
 * change — usage and earnings — below the ones that never do.
 *
 * Each tile is `label / value / foot`. Nothing here is a hero figure: a
 * dashboard gets at most one, and none of these four earns the role over the
 * others, so they share a size and the eye picks its own entry point.
 *
 * The revenue tile is the one that must not overclaim. It shows a figure only
 * when the experiment is BOTH readable and significant — otherwise it says so
 * plainly rather than showing a provisional number a merchant might act on.
 */
function renderTiles(vm: AdminViewModel): string {
  const b = vm.billing;
  const revenue = vm.lift.incrementalRevenueMinor;

  const tile = (label: string, value: string, foot: string, small = false): string => `
    <div class="tile">
      <span class="label">${esc(label)}</span>
      <span class="value${small ? ' sm' : ''}">${esc(value)}</span>
      <span class="foot">${esc(foot)}</span>
    </div>`;

  return `<div class="tiles">
    ${
      b === undefined
        ? tile('Conversations resolved', vm.stats.activeSessions.toLocaleString(), 'billing not configured')
        : tile(
            'Resolved this month',
            b.used.toLocaleString(),
            `of ${b.included.toLocaleString()} included on ${b.planName}`,
          )
    }
    ${b === undefined ? '' : tile('Remaining', b.remaining.toLocaleString(), 'before extra usage is charged')}
    ${tile('Live conversations', vm.stats.activeSessions.toLocaleString(), 'happening right now')}
    ${
      // Shown only when there IS a figure. A tile reading "Measuring" occupies
      // the space of a number and carries none — the Results panel below
      // already explains what is still missing and why.
      revenue === null ? '' : tile('Revenue earned', money(revenue), 'more than the held-back group')
    }
  </div>`;
}

function renderPlan(b: NonNullable<AdminViewModel['billing']>): string {
  const pctUsed = b.included === 0 ? 0 : Math.min(100, Math.round((b.used / b.included) * 100));
  const state =
    b.verdict === 'frozen' || b.verdict === 'quota_exhausted' || b.verdict === 'cap_reached'
      ? 'over'
      : pctUsed >= 80
        ? 'warn'
        : 'ok';

  const message: Record<string, string> = {
    frozen: 'Shopify has paused this shop, usually because of an unpaid invoice.',
    quota_exhausted: 'You have used every conversation included this month. Upgrade to continue.',
    cap_reached: 'You have reached the spending limit you approved for this month.',
    overage: 'Beyond your included conversations; extra ones are billed at $0.06 each.',
  };

  return `
  <section class="card">
    <h2>Plan</h2>
    <div class="body">
      <div class="rows">
        <div class="row"><span class="k">Current plan</span>
          <span class="v"><span class="chip${state === 'over' ? ' grey' : ''}">${esc(b.planName)}</span></span></div>
        <div class="row"><span class="k">Resolved conversations</span>
          <span class="v">${b.used.toLocaleString()} <span class="muted">of ${b.included.toLocaleString()} this month</span></span></div>
        ${
          b.overageMinor > 0
            ? `<div class="row"><span class="k">Additional usage</span>
               <span class="v">${money(b.overageMinor)}</span></div>`
            : ''
        }
      </div>

      <div class="meter meter-${state}" role="img"
           aria-label="${b.used} of ${b.included} conversations used this month">
        <div class="meter-fill" style="width:${pctUsed}%"></div>
      </div>
      <div class="meter-legend">
        <span>${pctUsed}% used</span>
        <span>${b.remaining.toLocaleString()} left</span>
      </div>

      ${
        message[b.verdict] === undefined
          ? ''
          : `<p class="muted" style="margin-top:12px">${esc(message[b.verdict]!)}</p>`
      }

      ${
        b.test
          ? `<p class="muted" style="margin-top:12px"><strong>Test billing is on.</strong>
             Subscriptions are simulated and no money changes hands.</p>`
          : ''
      }

      <p class="muted" style="margin-top:12px">
        You are only charged for conversations the assistant resolves on its own. Messages
        within one conversation are never billed separately, and answers we could not ground
        are free.
      </p>

      <div class="plans">
        ${PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const current = id === b.planId;
          return `
          <div class="plan${current ? ' plan-current' : ''}">
            <div class="plan-head">
              <span class="plan-name">${esc(plan.name)}</span>
              ${current ? '<span class="chip">Current</span>' : ''}
            </div>
            <div class="plan-price">${
              plan.priceMinor === 0
                ? 'Free'
                : `${money(plan.priceMinor)}<span class="plan-per">/mo</span>`
            }</div>
            <div class="plan-meta">${plan.included.toLocaleString()} conversations${
              plan.overageMinor === null ? '' : `, then ${money(plan.overageMinor)} each`
            }</div>
            ${
              current
                ? '<button type="button" class="btn btn-quiet" disabled>Your plan</button>'
                : `<button type="button" class="btn${
                    id === 'free' ? ' btn-quiet' : ' btn-primary'
                  } planBtn" data-plan="${esc(id)}">${
                    id === 'free' ? 'Cancel subscription' : `Choose ${esc(plan.name)}`
                  }</button>`
            }
          </div>`;
        }).join('')}
      </div>
    </div>
  </section>`;
}

export function renderAdmin(vm: AdminViewModel): string {
  const s = vm.settings;
  const contrast = contrastWithWhite(s.accentColor);
  const accessible = accentIsAccessible(s.accentColor);
  const plan = vm.page === 'plan';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StoreAgent</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        data-api-key="${esc(vm.apiKey)}"></script>
<style>
  :root{
    --bg:#f1f2f4; --card:#fff; --ink:#303030; --sub:#616161;
    --line:#e3e3e3; --accent:#303030; --accentbar:#1b3a34; --ok:#0c5132; --okbg:#cdfee1;
    --warn:#5e4200; --warnbg:#ffd799;
    --r:12px;
  }
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;padding:24px 16px 64px}
  .wrap{max-width:800px;margin:auto;display:flex;flex-direction:column;gap:16px}

  /* ---------- page header -------------------------------------------------
     A bare "StoreAgent" over a stack of identical cards gave the page no
     entry point: nothing said what the app was for, and the one fact a
     merchant checks first — is it actually running — was four rows down
     inside a card. Title, one line of purpose, and the live state, in the
     order they get read. */
  .page{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:0 2px 4px}
  .page h1{font-size:20px;font-weight:650;letter-spacing:-.015em;line-height:1.25}
  .page .lede{font-size:13.5px;color:var(--sub);margin-top:4px;max-width:56ch;line-height:1.5}
  .page .meta{margin-left:auto;display:flex;align-items:center;gap:8px;
    flex-wrap:wrap;justify-content:flex-end;padding-top:3px}
  .shop{font-size:12.5px;color:var(--sub);
    background:var(--card);border:1px solid var(--line);padding:5px 11px;border-radius:8px}

  /* ---------- stat tiles --------------------------------------------------
     The four numbers a merchant opens the app to check, above the fold and
     legible at a glance, instead of buried as label/value rows. Values use
     the font's PROPORTIONAL figures: tabular-nums gives every digit the
     width of a zero, which reads loose and gappy at display sizes. Tabular
     is for columns that must align — the detail rows below — not for these. */
  .tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(158px,1fr))}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
    box-shadow:0 1px 0 rgba(0,0,0,.04);padding:14px 16px 15px;
    display:flex;flex-direction:column;gap:5px;min-height:104px}
  .tile .label{font-size:12.5px;color:var(--sub);line-height:1.3}
  .tile .value{font-size:26px;font-weight:650;letter-spacing:-.022em;line-height:1.15}
  .tile .value.sm{font-size:19px;letter-spacing:-.015em}
  .tile .foot{font-size:12px;color:var(--sub);line-height:1.4;margin-top:auto}

  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
    box-shadow:0 1px 0 rgba(0,0,0,.04)}
  /* A rule between a card's heading and its content. Every card was one
     undifferentiated block of text, so the eye had nothing to catch on. */
  .card > h2{font-size:14px;font-weight:650;padding:15px 18px 13px;letter-spacing:-.008em}
  .card > p.hint{font-size:13px;color:var(--sub);padding:0 18px 14px;margin-top:-5px;line-height:1.5}
  .card .body{padding:16px 18px 18px;border-top:1px solid var(--line)}

  .banner{display:flex;gap:10px;align-items:flex-start;padding:12px 15px;border-radius:10px;
    font-size:13.5px;line-height:1.5}
  .banner.ok{background:var(--okbg);color:var(--ok)}
  .banner.warn{background:var(--warnbg);color:var(--warn)}

  .rows{display:flex;flex-direction:column;gap:2px}
  .row{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line)}
  .row:first-child{border-top:0}
  .row .k{color:var(--sub);font-size:13.5px}
  .row .v{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:550}
  .chip{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px;
    background:var(--okbg);color:var(--ok)}
  .chip.grey{background:#f1f2f4;color:var(--sub)}

  /* ---------- usage meter -------------------------------------------------
     A number alone does not convey "nearly out". The legend gives both halves
     the merchant actually asks: how far in, and how much is left. */
     The unfilled track is a LIGHTER STEP OF THE FILL'S OWN RAMP, not neutral
     grey: state then reads across the whole bar rather than only the filled
     part, so "nearly out" is legible at a glance even when the fill is short. */
  .meter{margin-top:14px;height:8px;border-radius:999px;overflow:hidden;background:#dbe5e1}
  .meter-fill{height:100%;border-radius:999px;background:var(--accentbar);
    transition:width .4s cubic-bezier(.22,1,.36,1)}
  .meter-ok{background:#dbe5e1}
  .meter-ok .meter-fill{background:#1b3a34}
  .meter-warn{background:#f6e6c4}
  .meter-warn .meter-fill{background:#b98900}
  .meter-over{background:#f7ddd8}
  .meter-over .meter-fill{background:#8e1f0b}
  .meter-legend{display:flex;justify-content:space-between;margin-top:6px;
    font-size:12px;color:var(--sub);font-variant-numeric:tabular-nums}

  /* ---------- plan chooser ------------------------------------------------
     Three bare "Switch to X" buttons made the merchant leave the page to find
     out what a plan costs. Price and allowance belong at the point of choice. */
  .plans{display:grid;gap:10px;margin-top:16px;
    grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .plan{border:1px solid var(--line);border-radius:10px;padding:13px 14px;
    display:flex;flex-direction:column;gap:5px;background:#fff}
  .plan-current{border-color:#1b3a34;box-shadow:0 0 0 1px #1b3a34 inset;background:#fbfdfc}
  .plan-head{display:flex;align-items:center;gap:8px;min-height:20px}
  .plan-name{font-size:13.5px;font-weight:650}
  /* Proportional figures, not tabular: these are standalone display numbers
     in separate cards, not a column that has to align. */
  .plan-price{font-size:19px;font-weight:650;letter-spacing:-.02em}
  .plan-per{font-size:12.5px;font-weight:500;color:var(--sub);letter-spacing:0}
  .plan-meta{font-size:12px;color:var(--sub);line-height:1.45;min-height:34px}
  .plan .btn{width:100%;margin-top:4px}

  /* ---------- buttons ----------------------------------------------------- */
  .btn{font:inherit;font-size:13px;font-weight:600;padding:8px 13px;border-radius:8px;
    border:1px solid #b5b5b5;background:#fff;color:var(--ink);cursor:pointer;
    transition:background .15s,border-color .15s,transform .08s}
  .btn:hover{background:#f7f7f7}
  .btn:active{transform:translateY(1px)}
  .btn:focus-visible{outline:2px solid #005bd3;outline-offset:1px}
  .btn-primary{background:#303030;border-color:#303030;color:#fff}
  .btn-primary:hover{background:#1a1a1a;border-color:#1a1a1a}
  .btn-quiet{color:var(--sub)}
  .btn[disabled]{opacity:.55;cursor:default;transform:none}
  .btn[disabled]:hover{background:#fff}

  form{display:flex;flex-direction:column;gap:16px}
  .field{display:flex;flex-direction:column;gap:6px}
  label{font-size:13.5px;font-weight:550}
  .sub{font-size:12.5px;color:var(--sub);font-weight:400}
  input[type=text],select,input[type=number]{
    border:1px solid #8a8a8a;border-radius:8px;padding:8px 11px;font:inherit;background:#fff;color:inherit}
  input:focus,select:focus{outline:2px solid #005bd3;outline-offset:-1px;border-color:#005bd3}
  .colorRow{display:flex;align-items:center;gap:10px}
  input[type=color]{width:44px;height:36px;padding:2px;border:1px solid #8a8a8a;border-radius:8px;background:#fff}
  .swatch{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--sub)}
  .dot{width:15px;height:15px;border-radius:5px;border:1px solid rgba(0,0,0,.12)}
  .toggle{display:flex;align-items:center;gap:9px}
  .actions{display:flex;gap:9px;align-items:center;padding-top:2px}
  button.primary{background:#303030;color:#fff;border:0;border-radius:8px;padding:9px 16px;
    font:inherit;font-weight:550;cursor:pointer}
  button.primary:hover{background:#1a1a1a}
  .errors{background:#fee9e8;color:#8e1f0b;border-radius:10px;padding:11px 14px;font-size:13.5px}
  .errors[hidden]{display:none}
  .errors li{margin-left:16px}

  code{background:#f1f2f4;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12.5px}
  .muted{color:var(--sub);font-size:12.5px}
  a{color:#005bd3}
</style>
</head>
<body>
<!--
  App Bridge navigation. The first link (or rel="home") is HIDDEN from the
  menu, because the app name in Shopify's sidebar already links to it — so
  only Plan appears. Billing is its own route rather than a card on the
  dashboard: choosing a plan is a deliberate, occasional errand, and sitting
  it between usage and appearance made the daily page longer for everyone.
-->
<s-app-nav>
  <s-link href="/admin" rel="home">StoreAgent</s-link>
  ${vm.billing === undefined ? '' : '<s-link href="/admin/plan">Plan</s-link>'}
</s-app-nav>
<div class="wrap">

  <header class="page">
    <div>
      <h1>${plan ? 'Plan' : 'StoreAgent'}</h1>
      <p class="lede">${
        plan
          ? 'What you are on, what you have used, and what the other plans cost.'
          : 'Answers shoppers’ questions from your live catalog, and measures what it earns against a group who never see it.'
      }</p>
    </div>
    <div class="meta">
      <span class="chip${s.enabled ? '' : ' grey'}">${s.enabled ? 'Live' : 'Paused'}</span>
      <span class="shop">${esc(vm.shop)}</span>
    </div>
  </header>

  ${plan ? renderPlanPage(vm) : renderTiles(vm)}
  ${plan ? '' : renderHomeSections(vm)}
</div>
</body>
</html>`;
}

/** The Plan route: usage and the chooser, nothing else. */
function renderPlanPage(vm: AdminViewModel): string {
  return vm.billing === undefined
    ? '<section class="card"><h2>Plan</h2><div class="body"><p class="muted">Billing is not configured on this deployment.</p></div></section>'
    : renderPlan(vm.billing);
}

/** Everything on the dashboard below the tiles. */
function renderHomeSections(vm: AdminViewModel): string {
  const s = vm.settings;
  const contrast = contrastWithWhite(s.accentColor);
  const accessible = accentIsAccessible(s.accentColor);
  return `
  ${vm.saved ? '<div class="banner ok">Settings saved. The widget picks them up on the next page load.</div>' : ''}
  ${
    vm.errors && vm.errors.length
      ? `<div class="errors"><strong>Couldn’t save:</strong><ul>${vm.errors
          .map((e) => `<li>${esc(e)}</li>`)
          .join('')}</ul></div>`
      : ''
  }

  <section class="card">
    <h2>Appearance</h2>
    <p class="hint">The assistant inherits your theme’s fonts. These settings control the rest.</p>
    <div class="body">
      <!--
        data-save-bar hands the form to Shopify's Contextual Save Bar: editing
        a field raises the admin's own save/discard bar rather than leaving a
        button stranded at the bottom of a card. Required for Built for
        Shopify, and it also fixes a real problem — a merchant who changes the
        accent colour and navigates away currently loses the change silently.

        data-discard-confirmation because discarding is destructive and
        unrecoverable; the confirmation is Shopify's, not a modal of ours.
      -->
      <div class="errors" id="formErrors" role="alert" aria-live="polite" hidden></div>
      <form id="settingsForm" method="POST" action="/admin/settings"
            data-save-bar data-discard-confirmation>
        <input type="hidden" name="shop" value="${esc(vm.shop)}">
        <input type="hidden" name="host" value="${esc(vm.host)}">

        <div class="field">
          <label for="accentColor">Accent colour</label>
          <div class="colorRow">
            <input type="color" id="accentColor" name="accentColor" value="${esc(s.accentColor)}">
            <input type="text" name="accentColorText" value="${esc(s.accentColor)}" size="9" aria-label="Accent colour hex">
            <span class="swatch"><span class="dot" style="background:${esc(s.accentColor)}"></span>
              contrast ${contrast.toFixed(1)}:1 ${
                accessible ? '— passes AA' : '— <strong>too light for white text</strong>'
              }</span>
          </div>
          <span class="sub">White text sits on this colour, so it must reach 4.5:1. Colours that don’t are rejected rather than shipped.</span>
        </div>

        <div class="field">
          <label for="cornerRadius">Corner radius <span class="sub">${esc(s.cornerRadius)}px</span></label>
          <input type="number" id="cornerRadius" name="cornerRadius" min="0" max="28" step="2" value="${esc(s.cornerRadius)}">
        </div>

        <div class="field">
          <label for="position">Position</label>
          <select id="position" name="position">
            <option value="right"${s.position === 'right' ? ' selected' : ''}>Bottom right</option>
            <option value="left"${s.position === 'left' ? ' selected' : ''}>Bottom left</option>
          </select>
        </div>

        <div class="field">
          <label for="greeting">Opening line <span class="sub">optional</span></label>
          <input type="text" id="greeting" name="greeting" maxlength="120"
            placeholder="Leave blank to use a line chosen from the page type"
            value="${esc(s.greeting)}">
        </div>

        <div class="toggle">
          <input type="checkbox" id="enabled" name="enabled" value="1"${s.enabled ? ' checked' : ''}>
          <label for="enabled">Show the assistant on my storefront</label>
        </div>

        <div class="actions"><button class="primary" type="submit">Save</button></div>
      </form>
      <script>
        // Session tokens are short-lived, so we fetch a FRESH one at submit
        // time rather than baking a stale token into the HTML — a merchant who
        // spends two minutes picking a colour would otherwise hit an expired
        // token on save.
        (function () {
          var form = document.querySelector('form');
          var hex = document.querySelector('input[name=accentColorText]');
          var picker = document.getElementById('accentColor');
          picker.addEventListener('input', function () { hex.value = picker.value; });
          hex.addEventListener('change', function () {
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.value)) picker.value = hex.value;
          });

          function showErrors(list) {
            var box = document.getElementById('formErrors');
            if (!box) return;
            box.innerHTML = '<strong>Couldn’t save:</strong><ul>' +
              list.map(function (e) {
                return '<li>' + String(e).replace(/[<>&]/g, '') + '</li>';
              }).join('') + '</ul>';
            box.hidden = false;
            box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }

          // Discard: Shopify's save bar fires a reset on the form. Reloading
          // restores the SAVED values rather than the DOM's defaults, which
          // drift once the colour picker and its text twin have been edited.
          form.addEventListener('reset', function () {
            location.reload();
          });

          form.addEventListener('submit', async function (e) {
            e.preventDefault();
            var data = Object.fromEntries(new FormData(form));
            data.accentColor = hex.value || picker.value;
            data.enabled = form.querySelector('#enabled').checked;
            var token = '';
            try { token = await window.shopify.idToken(); } catch (err) {}
            var res = await fetch('/admin/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
              body: JSON.stringify(data),
            });
            var body = await res.json().catch(function () { return {}; });
            if (res.ok) location.search = '?shop=' + encodeURIComponent(data.shop) +
              '&host=' + encodeURIComponent(data.host) + '&saved=1';
            // Inline, next to the fields, not an alert(). Built for Shopify
            // asks for contextual errors near the field — and alert() is
            // itself an unsolicited modal, which the guidelines forbid.
            else showErrors(body.errors || ['Could not save.']);
          });

          // Plan changes. The merchant is sent to Shopify's own approval
          // screen — nothing is charged here. It must open at the TOP window:
          // the admin runs in an iframe and Shopify's confirmation page
          // refuses to render inside one, so a plain redirect shows a blank
          // frame and the upgrade silently dies.
          document.querySelectorAll('.planBtn').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var plan = btn.getAttribute('data-plan');
              if (plan === 'free' &&
                  !confirm('Cancel your subscription and return to the Free plan?')) return;
              btn.disabled = true;
              var token = '';
              try { token = await window.shopify.idToken(); } catch (err) {}
              var res = await fetch('/admin/billing/subscribe', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
                body: JSON.stringify({ plan: plan }),
              });
              var body = await res.json().catch(function () { return {}; });
              btn.disabled = false;
              if (body.confirmationUrl) window.top.location.href = body.confirmationUrl;
              else if (res.ok) location.reload();
              else showErrors(body.errors || ['Could not change plan.']);
            });
          });

          // Self-heal a stale plan.
          //
          // The page renders from our stored row, which is fast but can be
          // wrong: /admin only reconciled when the merchant came back with a
          // charge_id, so a missed webhook, a plan changed from Shopify's own
          // pricing page, or simply opening the app from the Apps menu left a
          // paying merchant looking at "Free" indefinitely.
          //
          // /admin/billing reconciles against Shopify. Run it AFTER paint so
          // nothing blocks on the network, and reload only if the plan actually
          // moved. That cannot loop: the reconcile persisted the new plan, so
          // the reloaded page renders it and the next comparison matches.
          (async function () {
            var rendered = ${JSON.stringify(vm.billing?.planId ?? null)};
            if (rendered === null) return;
            try {
              var token = await window.shopify.idToken();
              var res = await fetch('/admin/billing', {
                headers: { authorization: 'Bearer ' + token },
              });
              if (!res.ok) return;
              var body = await res.json();
              if (body.billing && body.billing.planId !== rendered) location.reload();
            } catch (err) {
              // Offline, or Shopify is down. The cached plan is still shown,
              // which is the right outcome — never blank the page over this.
            }
          })();
        })();
      </script>
    </div>
  </section>

  <!--
    The Measurement card is gone. It was a bare number input asking a merchant
    to pick an experiment parameter, which is our decision to make well, not
    theirs to guess at.

    The value still round-trips as a hidden field. Dropping the input without
    this would post the settings form with no holdoutFraction, and saving an
    accent colour would silently resize or switch off the experiment — the
    measurement is months of accumulated data and must not be collateral.
  -->
  <input form="settingsForm" type="hidden" name="holdoutFraction" value="${esc(s.holdoutFraction)}">

  <section class="card">
    <h2>Turning it on</h2>
    <div class="body">
      <p class="muted">Go to <strong>Online Store → Themes → Customise → App embeds</strong> and switch on
      <strong>StoreAgent</strong>. Nothing is added to your theme code, and you can turn it off there at any time.</p>
    </div>
  </section>`;
}

/** Minimal page for an unauthenticated or non-embedded hit. */
/**
 * The "we could not authenticate you" page.
 *
 * `installUrl` is passed whenever the request named a valid shop. That is the
 * common case by far: the merchant opened the app from their admin before ever
 * completing OAuth, so the only useful thing this page can do is start it.
 * Without the link the page is a dead end that explains nothing the merchant
 * can act on.
 *
 * The link MUST target `_top`. Shopify's own login refuses to be framed, so
 * running OAuth inside the admin's iframe dead-ends on a blank frame — the
 * merchant has to be taken out of the iframe to authenticate.
 */
export function renderUnauthenticated(reason: string, installUrl?: string, apiKey?: string): string {
  const action =
    installUrl === undefined
      ? '<p>This page authenticates through Shopify and can’t be opened directly.</p>'
      : `<p>StoreAgent isn’t connected to this store yet. Connecting takes one click.</p>
<p><a class="btn" href="${esc(installUrl)}" target="_top" rel="noopener">Connect StoreAgent</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>StoreAgent</title>${
    apiKey === undefined
      ? ''
      : `
<!--
  App Bridge belongs on THIS page too, not only the authenticated one.

  Shopify's admin decides an embedded app is broken when the framed document
  never initialises App Bridge, and reports it as "The application can't be
  loaded, check that your browser allows third-party cookies" — which names
  a cause that has nothing to do with it and sends everyone to their browser
  settings. Any 401 rendered inside the frame produced exactly that.

  With App Bridge present the frame initialises, and the script below can do
  the thing that actually fixes the common case: a page reached by in-app
  navigation carries no id_token, so it asks App Bridge for a fresh one and
  reloads with it. Guarded on the token being absent, so it can never loop.
-->
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        data-api-key="${esc(apiKey)}"></script>
<script>
  (async function () {
    try {
      if (new URLSearchParams(location.search).has('id_token')) return;
      if (!window.shopify || !window.shopify.idToken) return;
      var token = await window.shopify.idToken();
      if (!token) return;
      var url = new URL(location.href);
      url.searchParams.set('id_token', token);
      location.replace(url.toString());
    } catch (err) {
      // Not embedded, or App Bridge unavailable. The page below still
      // explains itself and offers the install link.
    }
  })();
</script>`
  }<style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#f1f2f4;color:#303030;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.c{background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:26px 28px;max-width:440px}
h1{font-size:17px;margin:0 0 8px}p{color:#616161;margin:0 0 6px}
code{background:#f1f2f4;padding:1px 6px;border-radius:5px;font-size:12.5px}
.btn{display:inline-block;margin-top:10px;background:#303030;color:#fff;text-decoration:none;
  padding:9px 16px;border-radius:8px;font-weight:500}
.btn:hover{background:#1a1a1a}
</style></head><body><div class="c">
<h1>${installUrl === undefined ? 'Open this from your Shopify admin' : 'Connect StoreAgent'}</h1>
${action}
<p class="muted"><code>${esc(reason)}</code></p>
</div></body></html>`;
}
