import {
  sanitizeConfig,
  sanitizeEnvironment,
  sanitizeDatabaseUrl,
  sanitizeLogOutput,
  isPathSafe,
} from '../utils/security';

describe('sanitizeConfig', () => {
  test('redacts password fields', () => {
    const config = { database_password: 'secret123', host: 'localhost' };
    const result = sanitizeConfig(config) as Record<string, unknown>;
    expect(result['database_password']).toBe('[REDACTED]');
    expect(result['host']).toBe('localhost');
  });

  test('redacts token fields', () => {
    const config = { api_token: 'abc123xyz', name: 'test' };
    const result = sanitizeConfig(config) as Record<string, unknown>;
    expect(result['api_token']).toBe('[REDACTED]');
    expect(result['name']).toBe('test');
  });

  test('recursively sanitizes nested objects', () => {
    const config = { db: { password: 'secret', host: 'localhost' } };
    const result = sanitizeConfig(config) as Record<string, Record<string, unknown>>;
    expect(result['db']['password']).toBe('[REDACTED]');
    expect(result['db']['host']).toBe('localhost');
  });

  test('sanitizes arrays', () => {
    const config = { items: [{ secret: 'abc', value: 'ok' }] };
    const result = sanitizeConfig(config) as Record<string, Array<Record<string, unknown>>>;
    expect(result['items'][0]['secret']).toBe('[REDACTED]');
    expect(result['items'][0]['value']).toBe('ok');
  });

  test('handles null and undefined gracefully', () => {
    expect(sanitizeConfig(null)).toBeNull();
    expect(sanitizeConfig(undefined)).toBeUndefined();
  });

  test('passes through safe string values', () => {
    const config = { name: 'myapp', version: '1.0.0' };
    const result = sanitizeConfig(config) as Record<string, unknown>;
    expect(result['name']).toBe('myapp');
    expect(result['version']).toBe('1.0.0');
  });
});

describe('sanitizeEnvironment', () => {
  test('redacts DATABASE_URL', () => {
    const env = { DATABASE_URL: 'mysql://user:pass@localhost/db', APP_ENV: 'dev' };
    const result = sanitizeEnvironment(env);
    expect(result['DATABASE_URL']).toBe('[REDACTED]');
    expect(result['APP_ENV']).toBe('dev');
  });

  test('redacts SECRET_KEY', () => {
    const env = { APP_SECRET: 'mysupersecretkey123456', APP_ENV: 'prod' };
    const result = sanitizeEnvironment(env);
    expect(result['APP_SECRET']).toBe('[REDACTED]');
  });

  test('keeps non-sensitive values', () => {
    const env = { APP_ENV: 'dev', APP_DEBUG: 'true', PORT: '8080' };
    const result = sanitizeEnvironment(env);
    expect(result['APP_ENV']).toBe('dev');
    expect(result['APP_DEBUG']).toBe('true');
    expect(result['PORT']).toBe('8080');
  });
});

describe('sanitizeDatabaseUrl', () => {
  test('redacts MySQL password', () => {
    const url = 'mysql://user:secretpass@localhost:3306/mydb';
    const result = sanitizeDatabaseUrl(url);
    expect(result).not.toContain('secretpass');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('localhost');
    expect(result).toContain('mydb');
  });

  test('redacts PostgreSQL password', () => {
    const url = 'postgresql://appuser:pgpass123@db.example.com/appdb';
    const result = sanitizeDatabaseUrl(url);
    expect(result).not.toContain('pgpass123');
    expect(result).toContain('[REDACTED]');
  });

  test('handles URL without password', () => {
    const url = 'sqlite:///var/data.db';
    const result = sanitizeDatabaseUrl(url);
    expect(result).toBe('sqlite:///var/data.db');
  });

  test('returns empty string unchanged', () => {
    expect(sanitizeDatabaseUrl('')).toBe('');
  });
});

describe('sanitizeLogOutput', () => {
  test('redacts email addresses', () => {
    const log = '[2024-01-01] user logged in: john@example.com from 127.0.0.1';
    const result = sanitizeLogOutput(log);
    expect(result).not.toContain('john@example.com');
    expect(result).toContain('[REDACTED:EMAIL]');
  });

  test('redacts API keys in log lines', () => {
    const log = 'API call with token=abcdefghijklmnopqrstuvwxyz12345';
    const result = sanitizeLogOutput(log);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz12345');
  });

  test('preserves safe log content', () => {
    const log = '[2024-01-01 10:00:00] INFO Request GET /api/users 200 OK';
    const result = sanitizeLogOutput(log);
    expect(result).toContain('GET /api/users');
    expect(result).toContain('200 OK');
  });
});

describe('isPathSafe', () => {
  test('allows paths within base directory', () => {
    expect(isPathSafe('/app', 'var/log/dev.log')).toBe(true);
    expect(isPathSafe('/app', 'config/services.yaml')).toBe(true);
  });

  test('blocks directory traversal', () => {
    expect(isPathSafe('/app', '../etc/passwd')).toBe(false);
    expect(isPathSafe('/app', '../../root/.ssh/id_rsa')).toBe(false);
  });

  test('blocks absolute paths outside base', () => {
    expect(isPathSafe('/app', '/etc/passwd')).toBe(false);
  });
});
