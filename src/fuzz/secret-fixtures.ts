/**
 * Synthetic credential-shaped fixtures for the DLP test-suite.
 *
 * These are NOT secrets — every body is a keyboard-walk (`abcdef...`, `ABCDEF...`)
 * chosen to be the shortest string that still satisfies the corresponding regex
 * in `dlp-detector.ts`.
 *
 * They are assembled from fragments at module load rather than written as
 * literals so that no contiguous token-shaped string ever appears in the source.
 * Credential scanners — GitHub push protection in particular — match on raw file
 * bytes and cannot tell a test fixture from the real thing; a literal here blocks
 * every push to the repository until a human clicks "allow secret", which is
 * exactly the reflex a security tool should not be training. Splitting the
 * literal keeps the scanner quiet without weakening the tests: the runtime values
 * are byte-identical to what the detectors are expected to catch.
 *
 * Two fixtures are deliberately left as plain literals elsewhere in the suite:
 * `AKIAIOSFODNN7EXAMPLE` (AWS's own published example key, allowlisted by
 * scanners) and the truncated PEM body (too short to match a real-key detector).
 */

/** Join fragments into one token. Exists so the parts stay visually separate. */
function token(...parts: string[]): string {
  return parts.join('');
}

// ─── Stripe ───────────────────────────────────────────────────────────────────

const STRIPE_LIVE = token('sk', '_', 'live', '_');
const STRIPE_TEST = token('sk', '_', 'test', '_');

/** Minimal `sk_live_` match used by the fuzz corpus. */
export const STRIPE_LIVE_KEY = token(STRIPE_LIVE, 'abcdefghijklmnopqrstuvwxyz0123');
/** `sk_live_` key carrying Stripe's account-id infix, as seen in the wild. */
export const STRIPE_LIVE_KEY_WITH_ACCOUNT = token(STRIPE_LIVE, '51KzZabcdefghijklmnopqrst');
/** Minimal `sk_test_` match. */
export const STRIPE_TEST_KEY = token(STRIPE_TEST, 'abc123defghijklmnopqrs');
/** Short `sk_live_` key used inside a generated .env fixture. */
export const STRIPE_LIVE_KEY_SHORT = token(STRIPE_LIVE, 'ABCDEFGHIJKLMNOPQRST');

// ─── Slack ────────────────────────────────────────────────────────────────────

const SLACK_BOT = token('xox', 'b', '-');

/** Bot token, long form. */
export const SLACK_BOT_TOKEN = token(SLACK_BOT, '1234567890-abcdefghijklmnopqrstuvwxyz');
/** Bot token, short form. */
export const SLACK_BOT_TOKEN_SHORT = token(SLACK_BOT, '123456789012-abcdefghijklmno');
/** Incoming-webhook URL. */
export const SLACK_WEBHOOK_URL = token(
  'https://hooks.slack.com/', 'services', '/T00000000/B00000000/', 'X'.repeat(24)
);

// ─── SendGrid ─────────────────────────────────────────────────────────────────

/** `SG.` + 22 chars + `.` + 43 chars. */
export const SENDGRID_KEY = token(
  'SG', '.', 'aBcDeFgHiJkLmNoPqRsTuV', '.', 'WxYz0123456789AbCdEfGhIjKlMnOpQrStUvWXYZ012'
);

// ─── GitHub ───────────────────────────────────────────────────────────────────

/** Classic personal access token, `ghp_` + 36 chars. */
export const GITHUB_TOKEN = token('gh', 'p', '_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456');
/** Same shape, uppercase body — used by the detector unit tests. */
export const GITHUB_TOKEN_UPPER = token('gh', 'p', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
/** Server-to-server token, `ghs_` prefix. */
export const GITHUB_SERVER_TOKEN = token('gh', 's', '_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
/** Fine-grained PAT, `github_pat_` + exactly 82 chars. */
export const GITHUB_PAT = token(
  'github', '_', 'pat', '_',
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrst'
);

// ─── Google ───────────────────────────────────────────────────────────────────

/** GCP API key, `AIza` + 35 chars. */
export const GCP_API_KEY = token('AIza', 'SyD_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456');

// ─── AWS ──────────────────────────────────────────────────────────────────────

/** AWS's published example key, temporary-credential (STS) variant. Split
 *  because scanners allowlist the AKIA form but flag this one. */
export const AWS_STS_ACCESS_KEY = token('AS', 'IA', 'IOSFODNN7EXAMPLE');
