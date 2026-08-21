import { scanText, redactText, containsDlpViolation, dlpSanitize, getDlpPatternInfo } from '../utils/dlp-detector';
import {
  STRIPE_LIVE_KEY_WITH_ACCOUNT,
  STRIPE_TEST_KEY,
  GITHUB_TOKEN_UPPER,
  GITHUB_SERVER_TOKEN,
  GCP_API_KEY,
  SLACK_BOT_TOKEN_SHORT,
  SLACK_WEBHOOK_URL,
} from '../fuzz/secret-fixtures';


beforeEach(() => {
  delete process.env['SYMFONY_MCP_DLP'];
  delete process.env['SYMFONY_MCP_DLP_HASH'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_DLP'];
  delete process.env['SYMFONY_MCP_DLP_HASH'];
});

describe('JWT detection', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  test('detects a JWT token', () => {
    const matches = scanText(JWT);
    expect(matches.some((m) => m.type === 'JWT_TOKEN')).toBe(true);
  });

  test('redacts JWT in a log line', () => {
    const log = `Authorization: Bearer ${JWT}`;
    const result = redactText(log);
    expect(result).not.toContain('eyJ');
    expect(result).toContain('[REDACTED:JWT_TOKEN]');
  });
});

describe('AWS key detection', () => {
  test('detects AWS access key ID', () => {
    const matches = scanText('AKIAIOSFODNN7EXAMPLE');
    expect(matches.some((m) => m.type === 'AWS_ACCESS_KEY')).toBe(true);
  });

  test('detects ASIA (STS) key prefix', () => {
    const matches = scanText('ASIAIOSFODNN7EXAMPLE');
    expect(matches.some((m) => m.type === 'AWS_ACCESS_KEY')).toBe(true);
  });

  test('redacts AWS key embedded in text', () => {
    const result = redactText('access_key=AKIAIOSFODNN7EXAMPLE was used');
    expect(result).not.toContain('AKIA');
    expect(result).toContain('[REDACTED:AWS_ACCESS_KEY]');
  });
});

describe('Private key detection', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4\n-----END RSA PRIVATE KEY-----';

  test('detects RSA private key PEM block', () => {
    const matches = scanText(PEM);
    expect(matches.some((m) => m.type === 'PRIVATE_KEY_PEM')).toBe(true);
  });

  test('redacts PEM block', () => {
    const result = redactText(PEM);
    expect(result).toContain('[REDACTED:PRIVATE_KEY_PEM]');
    expect(result).not.toContain('MIIE');
  });
});

describe('Stripe key detection', () => {
  test('detects live secret key', () => {
    const matches = scanText(STRIPE_LIVE_KEY_WITH_ACCOUNT);
    expect(matches.some((m) => m.type === 'STRIPE_KEY')).toBe(true);
  });

  test('detects test key', () => {
    const matches = scanText(STRIPE_TEST_KEY);
    expect(matches.some((m) => m.type === 'STRIPE_KEY')).toBe(true);
  });
});

describe('GitHub token detection', () => {
  test('detects ghp_ prefix token', () => {
    const matches = scanText(GITHUB_TOKEN_UPPER);
    expect(matches.some((m) => m.type === 'GITHUB_TOKEN')).toBe(true);
  });

  test('detects ghs_ prefix (server-to-server)', () => {
    const matches = scanText(GITHUB_SERVER_TOKEN);
    expect(matches.some((m) => m.type === 'GITHUB_TOKEN')).toBe(true);
  });
});

describe('Google GCP key detection', () => {
  test('detects AIza prefixed key', () => {
    const matches = scanText(GCP_API_KEY);
    expect(matches.some((m) => m.type === 'GCP_API_KEY')).toBe(true);
  });
});

describe('Slack token detection', () => {
  test('detects xoxb- bot token', () => {
    const matches = scanText(SLACK_BOT_TOKEN_SHORT);
    expect(matches.some((m) => m.type === 'SLACK_TOKEN')).toBe(true);
  });

  test('detects Slack webhook URL', () => {
    const matches = scanText(SLACK_WEBHOOK_URL);
    expect(matches.some((m) => m.type === 'SLACK_WEBHOOK')).toBe(true);
  });
});

describe('Credit card detection', () => {
  test('detects valid Visa card number (passes Luhn)', () => {
    // 4532015112830366 is a test Visa number that passes Luhn
    const matches = scanText('4532015112830366');
    expect(matches.some((m) => m.type === 'CREDIT_CARD')).toBe(true);
  });

  test('does not flag invalid credit card (fails Luhn)', () => {
    // 1234567890123456 is not a valid card number
    const matches = scanText('1234567890123456');
    expect(matches.some((m) => m.type === 'CREDIT_CARD')).toBe(false);
  });

  test('detects formatted card number', () => {
    // 4532 0151 1283 0366
    const matches = scanText('4532 0151 1283 0366');
    expect(matches.some((m) => m.type === 'CREDIT_CARD_FORMATTED')).toBe(true);
  });
});

describe('URL with credentials', () => {
  test('detects database URL with password', () => {
    const matches = scanText('mysql://user:secretpass@localhost:3306/mydb');
    expect(matches.some((m) => m.type === 'CREDENTIALS_IN_URL')).toBe(true);
  });

  test('redacts only the password part', () => {
    const result = redactText('DATABASE_URL=postgresql://admin:p@ssw0rd@db.example.com/app');
    expect(result).not.toContain('p@ssw0rd');
    expect(result).toContain('[REDACTED:CREDENTIALS_IN_URL]');
  });
});

describe('SSN detection', () => {
  test('detects US SSN format', () => {
    const matches = scanText('SSN: 123-45-6789');
    expect(matches.some((m) => m.type === 'SSN_US')).toBe(true);
  });

  test('does not flag invalid SSN starting with 000', () => {
    const matches = scanText('000-45-6789');
    expect(matches.some((m) => m.type === 'SSN_US')).toBe(false);
  });
});

describe('Email detection', () => {
  test('detects email address', () => {
    const matches = scanText('user@example.com');
    expect(matches.some((m) => m.type === 'EMAIL')).toBe(true);
  });
});

describe('redactText', () => {
  test('returns original text when no matches', () => {
    const text = 'Hello, this is a normal log line.';
    expect(redactText(text)).toBe(text);
  });

  test('handles overlapping matches gracefully', () => {
    // JWT inside a Bearer header line
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const text = `Bearer ${jwt} and something after`;
    const result = redactText(text);
    expect(result).not.toContain('eyJ');
    // The text after should survive
    expect(result).toContain('and something after');
  });

  test('SYMFONY_MCP_DLP=false disables detection', () => {
    process.env['SYMFONY_MCP_DLP'] = 'false';
    const result = redactText('AKIAIOSFODNN7EXAMPLE');
    expect(result).toBe('AKIAIOSFODNN7EXAMPLE'); // not redacted
  });

  test('DLP_HASH=true adds sha256 fingerprint', () => {
    process.env['SYMFONY_MCP_DLP_HASH'] = 'true';
    const result = redactText('AKIAIOSFODNN7EXAMPLE');
    expect(result).toMatch(/\[REDACTED:AWS_ACCESS_KEY:[0-9a-f]{8}\]/);
  });
});

describe('containsDlpViolation', () => {
  test('returns true for string with AWS key', () => {
    expect(containsDlpViolation('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  test('returns false for clean string', () => {
    expect(containsDlpViolation('hello world')).toBe(false);
  });

  test('scans nested objects recursively', () => {
    expect(containsDlpViolation({ key: 'AKIAIOSFODNN7EXAMPLE' })).toBe(true);
    expect(containsDlpViolation({ nested: { val: 'clean' } })).toBe(false);
  });

  test('scans arrays', () => {
    expect(containsDlpViolation(['clean', 'AKIAIOSFODNN7EXAMPLE'])).toBe(true);
  });
});

describe('dlpSanitize', () => {
  test('sanitizes nested object', () => {
    const result = dlpSanitize({ token: GITHUB_TOKEN_UPPER, name: 'test' });
    expect((result as Record<string, string>).name).toBe('test');
    expect((result as Record<string, string>).token).toContain('[REDACTED:GITHUB_TOKEN]');
  });
});

describe('getDlpPatternInfo', () => {
  test('returns a list of patterns with type and severity', () => {
    const info = getDlpPatternInfo();
    expect(info.length).toBeGreaterThan(5);
    expect(info.every((p) => p.type && p.severity)).toBe(true);
    expect(info.some((p) => p.severity === 'CRITICAL')).toBe(true);
  });
});
