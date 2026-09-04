import type { Incrementality } from '@storeagent/attribution';
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
}

const money = (minor: number): string =>
  `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (r: number): string => `${(r * 100).toFixed(2)}%`;

/**
 * The Results panel.
 *
 * When the sample cannot support a conclusion, this shows what is missing and
 * nothing else — no greyed-out placeholder figure, no "provisional" lift. A
 * merchant who sees a number acts on it, and a number that evaporates next
 * month costs more trust than an empty state ever does.
 */
function renderResults(vm: AdminViewModel): string {
  const l = vm.lift;
  const both = `${l.exposed.sessions.toLocaleString()} shown · ${l.holdout.sessions.toLocaleString()} held back`;

  if (!l.readable) {
    return `
      <div class="banner warn" style="margin-bottom:14px">
        <div><strong>Still measuring.</strong> ${esc(l.reason)}
        ${
          l.sessionsRemaining !== null
            ? ` Roughly ${l.sessionsRemaining.toLocaleString()} more sessions at the current split.`
            : ''
        }</div>
      </div>
      <div class="rows">
        <div class="row"><span class="k">Sessions measured</span><span class="v">${esc(both)}</span></div>
        <div class="row"><span class="k">Orders so far</span>
          <span class="v">${l.exposed.conversions} · ${l.holdout.conversions}</span></div>
      </div>
      <p class="muted" style="margin-top:12px">We show a lift figure only once the numbers can support one.
      A result that looks good this month and disappears next month is worse than waiting.</p>`;
  }

  const positive = l.absoluteLiftPp > 0;
  return `
    <div class="banner ${l.significant && positive ? 'ok' : 'warn'}" style="margin-bottom:14px">
      <div>${esc(vm.liftSummary)}</div>
    </div>
    <div class="rows">
      <div class="row"><span class="k">Shown the assistant</span>
        <span class="v">${pct(l.exposed.rate)} <span class="muted">of ${l.exposed.sessions.toLocaleString()}</span></span></div>
      <div class="row"><span class="k">Held back (control)</span>
        <span class="v">${pct(l.holdout.rate)} <span class="muted">of ${l.holdout.sessions.toLocaleString()}</span></span></div>
      <div class="row"><span class="k">Difference</span>
        <span class="v">${l.absoluteLiftPp > 0 ? '+' : ''}${l.absoluteLiftPp.toFixed(2)}pp
          <span class="muted">95% CI ${l.ci95Pp[0].toFixed(2)} to ${l.ci95Pp[1].toFixed(2)}</span></span></div>
      <div class="row"><span class="k">Incremental revenue</span>
        <span class="v">${
          l.incrementalRevenueMinor === null
            ? '<span class="muted">Not proven yet</span>'
            : money(l.incrementalRevenueMinor)
        }</span></div>
    </div>
    ${
      vm.unmatchedOrders > 0
        ? `<p class="muted" style="margin-top:12px">${vm.unmatchedOrders} order(s) couldn’t be matched to a session
           (ad blockers, or a checkout that skipped the storefront). They’re excluded from both sides rather than
           guessed at.</p>`
        : ''
    }`;
}


/**
 * The plan card.
 *
 * Shows usage against the allowance as a bar, because a number alone does not
 * convey "you are nearly out". The warning appears at 80% rather than at the
 * wall: a merchant who discovers the limit by the widget stopping is a
 * merchant who churns.
 */
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

      <div style="margin-top:12px;height:6px;border-radius:3px;background:#e3e3e3;overflow:hidden">
        <div style="height:100%;width:${pctUsed}%;background:${
          state === 'over' ? '#b98900' : state === 'warn' ? '#b98900' : '#1b3a34'
        }"></div>
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

      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        ${['growth', 'scale', 'plus']
          .filter((id) => id !== b.planId)
          .map(
            (id) =>
              `<button type="button" class="planBtn" data-plan="${esc(id)}">Switch to ${
                id[0]!.toUpperCase() + id.slice(1)
              }</button>`,
          )
          .join('')}
        ${
          b.planId === 'free'
            ? ''
            : '<button type="button" class="planBtn" data-plan="free">Cancel subscription</button>'
        }
      </div>
    </div>
  </section>`;
}

export function renderAdmin(vm: AdminViewModel): string {
  const s = vm.settings;
  const contrast = contrastWithWhite(s.accentColor);
  const accessible = accentIsAccessible(s.accentColor);

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
    --line:#e3e3e3; --accent:#303030; --ok:#0c5132; --okbg:#cdfee1;
    --warn:#5e4200; --warnbg:#ffd799;
    --r:12px;
  }
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;padding:24px 16px 64px}
  .wrap{max-width:800px;margin:auto;display:flex;flex-direction:column;gap:16px}

  .top{display:flex;align-items:center;gap:12px;margin-bottom:2px}
  .top h1{font-size:20px;font-weight:650;letter-spacing:-.01em}
  .shop{margin-left:auto;font-size:12.5px;color:var(--sub);
    background:var(--card);border:1px solid var(--line);padding:5px 11px;border-radius:8px}

  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
    box-shadow:0 1px 0 rgba(0,0,0,.04)}
  .card > h2{font-size:14px;font-weight:650;padding:15px 18px 0}
  .card > p.hint{font-size:13px;color:var(--sub);padding:4px 18px 0}
  .card .body{padding:16px 18px 18px}

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
  .errors li{margin-left:16px}

  code{background:#f1f2f4;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12.5px}
  .muted{color:var(--sub);font-size:12.5px}
  a{color:#005bd3}
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <h1>StoreAgent</h1>
    <span class="shop">${esc(vm.shop)}</span>
  </div>

  ${vm.saved ? '<div class="banner ok">Settings saved. The widget picks them up on the next page load.</div>' : ''}
  ${
    vm.errors && vm.errors.length
      ? `<div class="errors"><strong>Couldn’t save:</strong><ul>${vm.errors
          .map((e) => `<li>${esc(e)}</li>`)
          .join('')}</ul></div>`
      : ''
  }

  <section class="card">
    <h2>Status</h2>
    <div class="body">
      <div class="rows">
        <div class="row"><span class="k">Assistant</span>
          <span class="v"><span class="chip${s.enabled ? '' : ' grey'}">${s.enabled ? 'Live' : 'Paused'}</span></span></div>
        <div class="row"><span class="k">Catalog source</span>
          <span class="v">${vm.stats.mode === 'live' ? 'Your live catalog' : 'Demo catalog'}</span></div>
        <div class="row"><span class="k">Active conversations</span>
          <span class="v">${esc(vm.stats.activeSessions)}</span></div>
        <div class="row"><span class="k">Model</span>
          <span class="v muted">${esc(vm.stats.model)}</span></div>
      </div>
    </div>
  </section>

  ${vm.billing === undefined ? '' : renderPlan(vm.billing)}

  <section class="card">
    <h2>Appearance</h2>
    <p class="hint">The assistant inherits your theme’s fonts. These settings control the rest.</p>
    <div class="body">
      <form id="settingsForm" method="POST" action="/admin/settings">
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
            else alert((body.errors || ['Could not save.']).join('\\n'));
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
              else alert((body.errors || ['Could not change plan.']).join('\\n'));
            });
          });
        })();
      </script>
    </div>
  </section>

  <section class="card">
    <h2>Results</h2>
    <p class="hint">Measured against a held-back group who never see the assistant. That comparison is the only
      way to tell revenue the assistant <em>caused</em> from revenue it merely stood next to.</p>
    <div class="body">${renderResults(vm)}</div>
  </section>

  <section class="card">
    <h2>Measurement</h2>
    <p class="hint">A slice of shoppers never sees the assistant, so there's something honest to compare against.</p>
    <div class="body">
      <div class="field">
        <label for="holdoutFraction">Held-back share
          <span class="sub">${(s.holdoutFraction * 100).toFixed(0)}%</span></label>
        <input form="settingsForm" type="number" id="holdoutFraction" name="holdoutFraction"
          min="0" max="0.5" step="0.05" value="${esc(s.holdoutFraction)}">
        <span class="sub">
          ${
            Math.abs(s.holdoutFraction - vm.recommendedHoldout) < 0.001
              ? 'Matches what we’d recommend for your traffic.'
              : `We’d suggest ${(vm.recommendedHoldout * 100).toFixed(0)}% at your traffic. ` +
                `A smaller share costs fewer sales but takes far longer to give you an answer — ` +
                `the held-back group is the slower of the two to fill.`
          }
        </span>
      </div>
      <p class="muted" style="margin-top:10px">Set it to 0 to turn measurement off. You’ll get every sale, and
        no way to know which ones the assistant earned.</p>
    </div>
  </section>

  <section class="card">
    <h2>Turning it on</h2>
    <div class="body">
      <p class="muted">Go to <strong>Online Store → Themes → Customise → App embeds</strong> and switch on
      <strong>StoreAgent</strong>. Nothing is added to your theme code, and you can turn it off there at any time.</p>
    </div>
  </section>

</div>
</body>
</html>`;
}

/** Minimal page for an unauthenticated or non-embedded hit. */
export function renderUnauthenticated(reason: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>StoreAgent</title><style>
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#f1f2f4;color:#303030;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
.c{background:#fff;border:1px solid #e3e3e3;border-radius:12px;padding:26px 28px;max-width:440px}
h1{font-size:17px;margin:0 0 8px}p{color:#616161;margin:0 0 6px}
code{background:#f1f2f4;padding:1px 6px;border-radius:5px;font-size:12.5px}
</style></head><body><div class="c">
<h1>Open this from your Shopify admin</h1>
<p>This page authenticates through Shopify and can’t be opened directly.</p>
<p class="muted"><code>${esc(reason)}</code></p>
</div></body></html>`;
}
