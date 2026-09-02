/**
 * Per-shop widget settings.
 *
 * Store-shaped like everything else so Postgres can replace the Map without
 * touching call sites. Values are merchant-supplied and end up in CSS and HTML,
 * so every one is validated on the way in rather than on the way out —
 * sanitising at render time means one missed call site is an injection.
 */

export interface ShopSettings {
  readonly shop: string;
  /** CSS colour, validated as a hex triple/sextet. */
  accentColor: string;
  cornerRadius: number;
  position: 'right' | 'left';
  greeting: string;
  enabled: boolean;
  /**
   * Fraction of sessions held out of seeing the assistant, 0–0.5.
   *
   * The price of a trustworthy number. Defaults higher than the 5% in
   * ARCHITECTURE §10 because 5% is statistically unaffordable for most stores —
   * the holdout arm is the bottleneck, so at 5% you need ~20x total traffic to
   * fill it. See `recommendedHoldout`.
   */
  holdoutFraction: number;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Omit<ShopSettings, 'shop' | 'updatedAt'> = {
  accentColor: '#1b3a34',
  cornerRadius: 16,
  position: 'right',
  greeting: '',
  enabled: true,
  holdoutFraction: 0.2,
};

export interface SettingsStore {
  get(shop: string): Promise<ShopSettings>;
  put(settings: ShopSettings): Promise<void>;
}

export class MemorySettingsStore implements SettingsStore {
  private readonly map = new Map<string, ShopSettings>();

  async get(shop: string): Promise<ShopSettings> {
    return this.map.get(shop) ?? { shop, ...DEFAULT_SETTINGS, updatedAt: 0 };
  }
  async put(settings: ShopSettings): Promise<void> {
    this.map.set(settings.shop, { ...settings, updatedAt: Date.now() });
  }
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly settings?: ShopSettings;
  readonly errors: readonly string[];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Validate a settings payload.
 *
 * `accentColor` is interpolated into a CSS custom property, so anything other
 * than a strict hex literal is rejected. A value like
 * `red;} body{display:none` would otherwise escape the declaration.
 */
export function validateSettings(shop: string, input: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  const accentColor = String(input['accentColor'] ?? DEFAULT_SETTINGS.accentColor).trim();
  if (!HEX.test(accentColor)) errors.push('accentColor must be a hex colour like #1b3a34');

  const radiusRaw = Number(input['cornerRadius'] ?? DEFAULT_SETTINGS.cornerRadius);
  const cornerRadius = Number.isFinite(radiusRaw) ? Math.round(radiusRaw) : NaN;
  if (!Number.isFinite(cornerRadius) || cornerRadius < 0 || cornerRadius > 28) {
    errors.push('cornerRadius must be between 0 and 28');
  }

  const position = String(input['position'] ?? DEFAULT_SETTINGS.position);
  if (position !== 'right' && position !== 'left') errors.push('position must be right or left');

  const greeting = String(input['greeting'] ?? '').trim();
  if (greeting.length > 120) errors.push('greeting must be 120 characters or fewer');

  const enabled = input['enabled'] === undefined ? true : Boolean(input['enabled']);

  const holdoutRaw = Number(input['holdoutFraction'] ?? DEFAULT_SETTINGS.holdoutFraction);
  const holdoutFraction = Number.isFinite(holdoutRaw) ? Math.round(holdoutRaw * 100) / 100 : NaN;
  // Capped at 0.5: beyond an even split you are withholding the product from
  // most shoppers to measure it, which is no longer a reasonable trade.
  if (!Number.isFinite(holdoutFraction) || holdoutFraction < 0 || holdoutFraction > 0.5) {
    errors.push('holdoutFraction must be between 0 and 0.5');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    settings: {
      shop,
      accentColor: accentColor.toLowerCase(),
      cornerRadius,
      position: position as 'right' | 'left',
      greeting,
      enabled,
      holdoutFraction,
      updatedAt: Date.now(),
    },
  };
}

/**
 * Relative luminance contrast against white, per WCAG.
 *
 * The widget puts white text on the accent colour, so a merchant picking a pale
 * accent produces unreadable buttons. `EXPERIENCE-CONTRACT §7` says we reject
 * such a colour rather than ship an inaccessible widget — this is the check
 * that backs that promise.
 */
export function contrastWithWhite(hex: string): number {
  const full =
    hex.length === 4 ? `#${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}${hex[3]!}${hex[3]!}` : hex;
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return 1.05 / (L + 0.05);
}

export function accentIsAccessible(hex: string): boolean {
  return contrastWithWhite(hex) >= 4.5;
}
