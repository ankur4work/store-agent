#!/usr/bin/env node
/**
 * Secret scanner. Runs as a pre-commit hook and in CI.
 *
 * Default: scans STAGED content only (fast, blocks the commit that would leak).
 * `--all`: scans every tracked file (use in CI).
 *
 * Deliberately narrow. A scanner that cries wolf gets disabled, and a disabled
 * scanner catches nothing — so every rule here targets a credential format with
 * a distinctive prefix rather than guessing at entropy.
 */
import { execSync } from 'node:child_process';

const RULES = [
  { name: 'Shopify API secret key', re: /\bshpss_[a-f0-9]{32}\b/i },
  { name: 'Shopify admin access token', re: /\bshpat_[a-f0-9]{32}\b/i },
  { name: 'Shopify custom app token', re: /\bshpca_[a-f0-9]{32}\b/i },
  { name: 'Shopify private app token', re: /\bshppa_[a-f0-9]{32}\b/i },
  { name: 'Opaque access token (atkn_)', re: /\batkn_[a-f0-9]{40,}\b/i },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic OAuth token', re: /\bsk-ant-oat\d+-[A-Za-z0-9_-]{20,}/ },
  // OpenAI issues several shapes. The generic `sk-` rule is last and widest;
  // the specific ones exist so the violation message names the right thing.
  { name: 'OpenAI service account key', re: /\bsk-svcacct-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI admin key', re: /\bsk-admin-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // Assignment with a real-looking value (placeholders and empties pass).
  {
    name: 'Populated secret assignment',
    re: /\b(?:API_SECRET|CLIENT_SECRET|WEBHOOK_SECRET|ACCESS_TOKEN|PRIVATE_KEY)\s*[:=]\s*['"]?(?!your[-_]|<|\$\{|example|placeholder|xxx|\s*$)[A-Za-z0-9_\-]{16,}/i,
  },
];

const ALLOWED_PATHS = [/(^|\/)\.env\.example$/, /(^|\/)scripts\/check-secrets\.mjs$/];

const all = process.argv.includes('--all');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const files = sh(all ? 'git ls-files' : 'git diff --cached --name-only --diff-filter=ACM')
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !ALLOWED_PATHS.some((re) => re.test(f)));

const findings = [];
for (const file of files) {
  let content;
  try {
    content = all ? sh(`git show HEAD:"${file}" 2>nul`) : sh(`git show ":${file}"`);
  } catch {
    continue; // binary, deleted, or unreadable — nothing to scan
  }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push({ file, line: i + 1, rule: rule.name, text: line.trim().slice(0, 80) });
      }
    }
  });
}

if (findings.length > 0) {
  console.error('\n  BLOCKED — possible secret detected\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`    ${f.text}\n`);
  }
  console.error('  If this is a real credential: ROTATE IT, then remove it from the change.');
  console.error('  Secrets belong in .env (gitignored). Document the name in .env.example.');
  console.error('  False positive? Add a targeted rule exception in scripts/check-secrets.mjs.\n');
  process.exit(1);
}

console.log(`check-secrets: clean (${files.length} file${files.length === 1 ? '' : 's'} scanned)`);
