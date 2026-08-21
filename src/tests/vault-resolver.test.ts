import { isVaultRef, resolveSecret, getVaultStatus, clearVaultCache } from '../utils/vault-resolver';

beforeEach(() => {
  clearVaultCache();
  delete process.env['SYMFONY_MCP_VAULT_TOKEN'];
  delete process.env['SYMFONY_MCP_VAULT_ADDR'];
  delete process.env['SYMFONY_MCP_VAULT_ROLE_ID'];
  delete process.env['SYMFONY_MCP_VAULT_SECRET_ID'];
  delete process.env['AWS_REGION'];
  delete process.env['AWS_ACCESS_KEY_ID'];
  delete process.env['AWS_SECRET_ACCESS_KEY'];
});

afterEach(() => {
  clearVaultCache();
});

describe('isVaultRef', () => {
  test('recognizes vault: references', () => {
    expect(isVaultRef('vault:secret/data/myapp#db_password')).toBe(true);
    expect(isVaultRef('vault:secret/data/myapp')).toBe(true);
  });

  test('recognizes ssm: references', () => {
    expect(isVaultRef('ssm:/myapp/prod/db_password')).toBe(true);
    expect(isVaultRef('ssm:/path/to/param')).toBe(true);
  });

  test('recognizes aws-secret: references', () => {
    expect(isVaultRef('aws-secret:myapp/credentials#db_pass')).toBe(true);
    expect(isVaultRef('aws-secret:myapp/credentials')).toBe(true);
  });

  test('does not match plain values', () => {
    expect(isVaultRef('my-plain-password')).toBe(false);
    expect(isVaultRef('mysql://user:pass@localhost/db')).toBe(false);
    expect(isVaultRef('')).toBe(false);
    expect(isVaultRef('vault')).toBe(false); // no colon
    expect(isVaultRef('ssm')).toBe(false); // no colon
  });
});

describe('resolveSecret — passthrough', () => {
  test('returns plain value unchanged', async () => {
    const result = await resolveSecret('my-plain-password');
    expect(result).toBe('my-plain-password');
  });

  test('returns empty string unchanged', async () => {
    const result = await resolveSecret('');
    expect(result).toBe('');
  });
});

describe('resolveSecret — vault: (error paths)', () => {
  test('throws when vault: ref but no token configured', async () => {
    await expect(
      resolveSecret('vault:secret/data/myapp#db_password')
    ).rejects.toThrow(/Vault: no token/);
  });

  test('throws when vault server is unreachable', async () => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'http://127.0.0.1:19999'; // nothing listening here

    await expect(
      resolveSecret('vault:secret/data/myapp#db_password')
    ).rejects.toThrow(); // connection refused
  }, 10000);
});

describe('resolveSecret — ssm: (error paths)', () => {
  test('throws when AWS_REGION is not set', async () => {
    await expect(
      resolveSecret('ssm:/myapp/prod/db_password')
    ).rejects.toThrow(/AWS_REGION not set/);
  });

  test('throws when AWS credentials are not set', async () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    // No AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY

    await expect(
      resolveSecret('ssm:/myapp/prod/db_password')
    ).rejects.toThrow(/credentials not found/);
  });
});

describe('resolveSecret — aws-secret: (error paths)', () => {
  test('throws when AWS_REGION is not set', async () => {
    await expect(
      resolveSecret('aws-secret:myapp/credentials#db_pass')
    ).rejects.toThrow(/AWS_REGION not set/);
  });
});

describe('getVaultStatus', () => {
  test('returns unconfigured state by default', () => {
    const status = getVaultStatus();
    expect(status.vaultConfigured).toBe(false);
    expect(status.awsConfigured).toBe(false);
    expect(status.cacheSize).toBe(0);
    expect(status.vaultAddr).toBe('http://127.0.0.1:8200');
  });

  test('reports vault as configured when token is set', () => {
    process.env['SYMFONY_MCP_VAULT_TOKEN'] = 'test-token';
    const status = getVaultStatus();
    expect(status.vaultConfigured).toBe(true);
  });

  test('reports appRole as configured when both role_id and secret_id are set', () => {
    process.env['SYMFONY_MCP_VAULT_ROLE_ID'] = 'my-role-id';
    process.env['SYMFONY_MCP_VAULT_SECRET_ID'] = 'my-secret-id';
    const status = getVaultStatus();
    expect(status.appRoleConfigured).toBe(true);
    expect(status.vaultConfigured).toBe(true);
  });

  test('reports AWS as configured when key is set', () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE';
    const status = getVaultStatus();
    expect(status.awsConfigured).toBe(true);
  });

  test('uses custom SYMFONY_MCP_VAULT_ADDR', () => {
    process.env['SYMFONY_MCP_VAULT_ADDR'] = 'https://vault.example.com:8200';
    const status = getVaultStatus();
    expect(status.vaultAddr).toBe('https://vault.example.com:8200');
  });
});
