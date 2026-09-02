import { readFileSync } from 'node:fs';

export interface GatewayConfig {
  readonly port: number;
  readonly openaiApiKey: string;
  readonly shopDomain: string | undefined;
  readonly agentProfile: string;
  readonly models: { classify: string; workhorse: string; escalation: string };
  readonly allowedOrigins: readonly string[];
}

/** Load `.env` if present. Real deployments use the process environment. */
export function loadEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
        .filter(([k, v]) => k !== '' && v !== ''),
    );
  } catch {
    return {};
  }
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const apiKey = env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Put it in .env (gitignored) or the process environment.',
    );
  }
  return {
    port: Number(env['PORT'] ?? 8787),
    openaiApiKey: apiKey,
    // Absent → demo mode with the fixture catalog. See tool-executor.ts.
    shopDomain: env['SHOP_DOMAIN'] ?? env['DEV_SHOP_DOMAIN'],
    agentProfile: env['AGENT_PROFILE'] ?? 'https://storeagent.dev/ucp-profile.json',
    models: {
      classify: env['MODEL_CLASSIFY'] ?? 'gpt-5.6-luna',
      workhorse: env['MODEL_WORKHORSE'] ?? 'gpt-5.6-terra',
      escalation: env['MODEL_ESCALATION'] ?? 'gpt-5.6-sol',
    },
    allowedOrigins: (env['ALLOWED_ORIGINS'] ?? '*').split(',').map((s) => s.trim()),
  };
}
