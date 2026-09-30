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
  /**
   * Language the microphone listens in. An ISO-639-1 code, or 'auto'.
   *
   * Not derivable from the storefront, which is why it is a setting a
   * merchant sets rather than something we detect. An Indian store renders
   * `<html lang="en">` and its shoppers speak Hindi; a Dubai store is
   * English and its shoppers speak Arabic. Following the page language
   * would transcribe both as English and return nonsense, confidently.
   *
   * Auto-detection is not the answer either: from a second of quiet audio
   * the decoder guesses, and it guessed Urdu and then Turkish for the same
   * English sentence on this store. Hindi and Urdu are the same spoken
   * language in two scripts, so no amount of listening can separate them —
   * only the merchant knows.
   *
   * Defaults to English because a wrong pin is recoverable by the shopper
   * repeating themselves, while a wrong guess is answered out loud.
   */
  voiceLanguage: string;
  /**
   * Whether the browser may recognise speech on the shopper's own device.
   *
   * This is about the LIVE CAPTION and the endpointer, not the answer. The
   * authoritative transcript is still produced server-side and the audio is
   * still uploaded — what changes is where the interim text comes from while
   * the shopper is still talking, and interim text is what tells the endpointer
   * whether a pause is the end of a question or the middle of a thought.
   *
   * Three values, because there are three genuinely different behaviours and a
   * boolean would hide the one that costs the shopper bandwidth:
   *
   * - `off`      — always use the browser's cloud recogniser. A merchant who
   *                wants every shopper treated identically picks this.
   * - `auto`     — use the on-device model only if the browser ALREADY has the
   *                language pack. Never triggers a download. The default,
   *                because it is free in both bandwidth and privacy.
   * - `on`       — also install the language pack when it is missing. Better
   *                captions and no audio leaving the device, paid for with a
   *                one-time download the browser manages.
   *
   * Every value degrades to the cloud recogniser, and then to loudness-only
   * endpointing, so no setting here can leave a shopper unable to speak.
   */
  onDeviceSpeech: 'off' | 'auto' | 'on';
  updatedAt: number;
}

/**
 * The accepted values, and the labels the merchant reads.
 *
 * A closed list for the same reason `VOICE_LANGUAGES` is one: the value reaches
 * a browser API, and a free-text field is both a validation problem and a
 * support problem.
 */
export const ON_DEVICE_SPEECH_OPTIONS: readonly (readonly [string, string])[] = [
  ['auto', 'Use it when the browser already has it'],
  ['on', 'Install it on the shopper’s device when missing'],
  ['off', 'Off — always use the cloud recogniser'],
];

/**
 * Read a stored value back, falling to the default for anything unexpected.
 *
 * A row written before the column existed reads NULL, and the widget branches
 * on this string — an unrecognised value must land on the behaviour that
 * downloads nothing rather than on whatever `if` happens to catch it.
 */
export function normaliseOnDeviceSpeech(value: unknown): 'off' | 'auto' | 'on' {
  return value === 'off' || value === 'on' || value === 'auto'
    ? value
    : DEFAULT_SETTINGS.onDeviceSpeech;
}

export const DEFAULT_SETTINGS: Omit<ShopSettings, 'shop' | 'updatedAt'> = {
  accentColor: '#1b3a34',
  cornerRadius: 16,
  position: 'right',
  greeting: '',
  enabled: true,
  holdoutFraction: 0.2,
  voiceLanguage: 'en',
  // Free in bandwidth and in privacy: it uses what the browser already has and
  // downloads nothing. A merchant has to opt in before a shopper pays for a
  // language pack.
  onDeviceSpeech: 'auto',
};

/**
 * Languages offered in the admin, and the only values accepted.
 *
 * A closed list, because the value is sent to the transcription API and a
 * free-text field is both a validation problem and a support problem. Add
 * a code here and it appears in the dropdown.
 */
export const VOICE_LANGUAGES: readonly (readonly [string, string])[] = [
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['ar', 'Arabic'],
  ['ur', 'Urdu'],
  ['bn', 'Bengali'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['mr', 'Marathi'],
  ['gu', 'Gujarati'],
  ['pa', 'Punjabi'],
  ['tr', 'Turkish'],
  ['ru', 'Russian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['id', 'Indonesian'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
  ['pl', 'Polish'],
  ['sv', 'Swedish'],
  // Last on purpose. It is the behaviour that produced Urdu and Turkish
  // transcripts of an English sentence, so it is a choice, not a default.
  ['auto', 'Detect automatically'],
];

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

  const voiceLanguage = String(input['voiceLanguage'] ?? DEFAULT_SETTINGS.voiceLanguage).trim();
  if (!VOICE_LANGUAGES.some(([code]) => code === voiceLanguage)) {
    errors.push('voiceLanguage must be one of the supported languages');
  }

  const onDeviceSpeech = String(input['onDeviceSpeech'] ?? DEFAULT_SETTINGS.onDeviceSpeech).trim();
  if (!ON_DEVICE_SPEECH_OPTIONS.some(([code]) => code === onDeviceSpeech)) {
    errors.push('onDeviceSpeech must be off, auto, or on');
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
      voiceLanguage,
      onDeviceSpeech: onDeviceSpeech as 'off' | 'auto' | 'on',
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
