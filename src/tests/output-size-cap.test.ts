import { sanitizeToolResult, getMaxOutputBytesConfig } from '../utils/output-sanitizer';

beforeEach(() => {
  delete process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'];
});

afterEach(() => {
  delete process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'];
});

describe('output size cap — default limit', () => {
  test('small output passes through unchanged', () => {
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: 'hello world' }] },
      'list_routes'
    );
    expect(result.content[0]!.text).toBe('hello world');
  });

  test('default limit is 1 MB', () => {
    expect(getMaxOutputBytesConfig()).toBe(1_048_576);
  });
});

describe('output size cap — configurable limit', () => {
  test('output over limit is truncated', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '50';
    const big = 'a'.repeat(200);
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: big }] },
      'list_routes'
    );
    const text = result.content[0]!.text ?? '';
    expect(text).toContain('[OUTPUT TRUNCATED');
  });

  test('truncation message includes byte counts', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '50';
    const big = 'a'.repeat(200);
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: big }] },
      'list_routes'
    );
    expect(result.content[0]!.text).toMatch(/\d+ bytes exceeded limit of \d+ bytes/);
  });

  test('truncation message includes env var hint', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '50';
    const big = 'a'.repeat(200);
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: big }] },
      'list_routes'
    );
    expect(result.content[0]!.text).toContain('SYMFONY_MCP_MAX_OUTPUT_BYTES');
  });

  test('truncates to at most the configured limit', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '100';
    const big = 'a'.repeat(500);
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text: big }] },
      'list_routes'
    );
    const text = result.content[0]!.text ?? '';
    // Split on the '\n' separator that precedes the truncation marker
    const prefix = text.split('\n[OUTPUT TRUNCATED')[0] ?? '';
    expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(100);
  });

  test('output exactly at limit is not truncated', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '50';
    const text = 'a'.repeat(50);
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text }] },
      'list_routes'
    );
    expect(result.content[0]!.text).not.toContain('[OUTPUT TRUNCATED');
  });

  test('SYMFONY_MCP_MAX_OUTPUT_BYTES=0 falls back to 1 MB default', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '0';
    expect(getMaxOutputBytesConfig()).toBe(1_048_576);
  });

  test('getMaxOutputBytesConfig reflects env var', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '512000';
    expect(getMaxOutputBytesConfig()).toBe(512000);
  });
});

describe('output size cap — multi-item content', () => {
  test('each content item is capped independently', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '10';
    const result = sanitizeToolResult(
      {
        content: [
          { type: 'text', text: 'short' },
          { type: 'text', text: 'x'.repeat(200) },
        ],
      },
      'list_routes'
    );
    expect(result.content[0]!.text).toBe('short');
    expect(result.content[1]!.text).toContain('[OUTPUT TRUNCATED');
  });

  test('non-text items are not affected', () => {
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '5';
    const item = { type: 'image', url: 'https://example.com/img.png' };
    const result = sanitizeToolResult(
      { content: [item as unknown as { type: string; text: string }] },
      'list_routes'
    );
    expect(result.content[0]).toEqual(item);
  });
});

describe('output size cap — UTF-8 boundary', () => {
  test('truncation does not split a multi-byte character', () => {
    // '€' is 3 bytes in UTF-8; set limit to 4 bytes (fits 1 '€' cleanly)
    process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] = '4';
    const text = '€€€€'; // 12 bytes total
    const result = sanitizeToolResult(
      { content: [{ type: 'text', text }] },
      'list_routes'
    );
    const truncated = result.content[0]!.text ?? '';
    // The prefix before the truncation marker must be valid UTF-8
    const prefix = truncated.split('\n[OUTPUT TRUNCATED')[0] ?? '';
    expect(prefix).not.toContain('�');
  });
});
