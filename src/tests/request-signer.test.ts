import { signRequest, verifyRequest, getSigningStatus, clearNonceCache } from '../utils/request-signer';

beforeEach(() => {
  clearNonceCache();
  delete process.env['SYMFONY_MCP_SIGNING_SECRET'];
  delete process.env['SYMFONY_MCP_SIGN_STRICT'];
  delete process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'];
});

afterEach(() => {
  clearNonceCache();
  delete process.env['SYMFONY_MCP_SIGNING_SECRET'];
  delete process.env['SYMFONY_MCP_SIGN_STRICT'];
  delete process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'];
});

describe('signRequest', () => {
  test('returns null when SYMFONY_MCP_SIGNING_SECRET is not set', () => {
    const result = signRequest('list_routes', { app_path: '/app' });
    expect(result).toBeNull();
  });

  test('returns a SignResult with ts, nonce, sig when secret is set', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const result = signRequest('list_routes', { app_path: '/app' });
    expect(result).not.toBeNull();
    expect(typeof result!.ts).toBe('number');
    expect(typeof result!.nonce).toBe('string');
    expect(result!.nonce).toHaveLength(8); // 4 bytes hex
    expect(result!.sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('verifyRequest', () => {
  test('allows all requests when no secret is configured', () => {
    const result = verifyRequest('list_routes', { app_path: '/app' });
    expect(result.valid).toBe(true);
  });

  test('allows valid signed request', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const args = { app_path: '/app' };
    const sig = signRequest('list_routes', args)!;
    const argsWithSig = { ...args, _signature: sig };

    const result = verifyRequest('list_routes', argsWithSig);
    expect(result.valid).toBe(true);
  });

  test('rejects unsigned request in strict mode', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    process.env['SYMFONY_MCP_SIGN_STRICT'] = 'true';

    const result = verifyRequest('list_routes', { app_path: '/app' });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('missing a _signature');
  });

  test('warns but allows unsigned request in non-strict mode', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    // SYMFONY_MCP_SIGN_STRICT not set = non-strict

    const result = verifyRequest('list_routes', { app_path: '/app' });
    expect(result.valid).toBe(true);
  });

  test('rejects tampered signature', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const args = { app_path: '/app' };
    const sig = signRequest('list_routes', args)!;
    const tampered = { ...sig, sig: 'sha256=' + 'a'.repeat(64) };
    const argsWithSig = { ...args, _signature: tampered };

    const result = verifyRequest('list_routes', argsWithSig);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string; fatal: boolean }).fatal).toBe(true);
  });

  test('rejects expired signature', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'] = '1000'; // 1 second window

    const args = { app_path: '/app' };
    // Manually create a signature with a very old timestamp
    const oldTs = Date.now() - 5000; // 5 seconds ago
    const argsWithSig = { ...args, _signature: { ts: oldTs, nonce: 'aabbccdd', sig: 'sha256=' + 'a'.repeat(64) } };

    const result = verifyRequest('list_routes', argsWithSig);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('too old');
  });

  test('rejects replayed nonce', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const args = { app_path: '/app' };
    const sig = signRequest('list_routes', args)!;
    const argsWithSig = { ...args, _signature: sig };

    // First request: valid
    const first = verifyRequest('list_routes', argsWithSig);
    expect(first.valid).toBe(true);

    // Second request with same nonce: replay attack
    const second = verifyRequest('list_routes', argsWithSig);
    expect(second.valid).toBe(false);
    expect((second as { valid: false; reason: string }).reason).toContain('Replay');
  });

  test('rejects future timestamp', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const args = { app_path: '/app' };
    const futureTs = Date.now() + 100_000;
    const argsWithSig = { ...args, _signature: { ts: futureTs, nonce: 'future00', sig: 'sha256=' + 'a'.repeat(64) } };

    const result = verifyRequest('list_routes', argsWithSig);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toContain('future');
  });

  test('ignores _signature field when computing canonical string', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    const args = { app_path: '/app' };
    const sig = signRequest('list_routes', args)!;
    // Adding _signature to args should not affect canonical computation
    const argsWithSig = { ...args, _signature: sig };

    const result = verifyRequest('list_routes', argsWithSig);
    expect(result.valid).toBe(true);
  });
});

describe('getSigningStatus', () => {
  test('returns enabled=false when no secret configured', () => {
    const status = getSigningStatus();
    expect(status.enabled).toBe(false);
    expect(status.strict).toBe(false);
    expect(status.replayWindowMs).toBe(30000);
  });

  test('returns enabled=true when secret is configured', () => {
    process.env['SYMFONY_MCP_SIGNING_SECRET'] = 'test-secret-32-chars-long-enough!!';
    process.env['SYMFONY_MCP_SIGN_STRICT'] = 'true';
    process.env['SYMFONY_MCP_REPLAY_WINDOW_MS'] = '60000';

    const status = getSigningStatus();
    expect(status.enabled).toBe(true);
    expect(status.strict).toBe(true);
    expect(status.replayWindowMs).toBe(60000);
  });
});
