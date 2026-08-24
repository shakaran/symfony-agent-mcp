// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Output Sanitizer — DLP gate for all tool responses
 *
 * Applies the full sanitization pipeline to every tool result
 * before it is sent to the MCP client:
 *
 *  1. DLP structural redaction  (JWTs, API keys, credit cards, PEM blocks…)
 *  2. Keyword-based redaction   (passwords, tokens, secrets by field name)
 *  3. Error message sanitization (strip stack traces, absolute paths)
 *  4. Privacy mode              (data minimization for strict/paranoid levels)
 *
 * This is the single choke-point that all tool outputs pass through,
 * regardless of which internal function produced them.
 *
 * Wire-up: called at the end of executeWithSecurity() in server.ts.
 */

import * as path from 'path';
import { redactText } from './dlp-detector.js';
import { sanitizeLogOutput } from './security.js';
import { applyPrivacyMode, ToolResultLike } from './privacy-mode.js';
import { incDlpRedaction } from './security-metrics.js';
import { redactInjections } from './prompt-injection-detector.js';

// ─── Error message sanitization ──────────────────────────────────────────────

// Patterns that identify dangerous content in error messages
const ABSOLUTE_PATH_RE = /(?:^|[\s"'`(])(\/(home|var|usr|etc|root|tmp|opt|srv|proc|sys|dev|run|mnt)[^\s"'`):,]*)/g;
const STACK_TRACE_LINE_RE = /^\s+at\s+.+$/gm;
const NODE_MODULE_PATH_RE = /\/node_modules\/[^\s"'`),]*/g;
const WIN_ABSOLUTE_PATH_RE = /[A-Za-z]:\\[^\s"'`),]*/g;

/**
 * Strips dangerous content from error messages before they reach the client:
 *  - Absolute filesystem paths (home dirs, system paths)
 *  - Node.js stack trace lines (`at Function.xxx (file:line:col)`)
 *  - Windows absolute paths
 *  - Applies DLP on the cleaned message
 */
export function sanitizeErrorMessage(message: string): string {
  let out = message;

  // Strip stack trace lines (keep only the first line = the actual error message)
  out = out.replace(STACK_TRACE_LINE_RE, '');

  // Strip absolute system paths — replace with just the filename
  out = out.replace(ABSOLUTE_PATH_RE, (match, p1) => {
    const basename = path.basename(p1);
    return match.slice(0, match.length - p1.length) + `[PATH]/${basename}`;
  });

  // Strip node_modules paths
  out = out.replace(NODE_MODULE_PATH_RE, '[node_modules/...]');

  // Strip Windows paths
  out = out.replace(WIN_ABSOLUTE_PATH_RE, '[PATH]');

  // Collapse multiple blank lines left by stack trace removal
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  // Apply DLP to catch any keys/tokens in error strings
  out = redactText(out);

  return out;
}

// ─── Content text pipeline ────────────────────────────────────────────────────

/**
 * Runs the full sanitization pipeline on a single text string.
 * Used for both success responses and error messages.
 */
function sanitizeText(text: string, isError: boolean): string {
  if (!text) return text;

  // Step 1: DLP structural scan
  const dlpResult = redactText(text);

  // Step 2: keyword + URL credential redaction (only on non-error content
  //         to avoid double-processing — error paths use sanitizeErrorMessage)
  const sanitized = isError ? sanitizeErrorMessage(dlpResult) : sanitizeLogOutput(dlpResult);

  // Step 3: Prompt injection redaction — strips LLM hijack instructions from
  //         tool outputs before they reach the AI client (Q)
  return isError ? sanitized : redactInjections(sanitized);
}

// ─── Metrics helper ────────────────────────────────────────────────────────────

function trackDlpChanges(before: string, after: string): void {
  if (before === after) return;

  // Count REDACTED:TYPE markers added
  const added = after.match(/\[REDACTED:[A-Z_]+(?::[0-9a-f]+)?\]/g);
  if (added) {
    const counts = new Map<string, number>();
    for (const match of added) {
      const type = (match.match(/\[REDACTED:([A-Z_]+)/) ?? [])[1] ?? 'UNKNOWN';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    for (const [type, count] of counts) {
      incDlpRedaction(type);
      void count; // already counted by incDlpRedaction(type) * count — call N times
    }
  }
}

// ─── Output size cap (N) ─────────────────────────────────────────────────────

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

function getMaxOutputBytes(): number {
  const raw = parseInt(process.env['SYMFONY_MCP_MAX_OUTPUT_BYTES'] ?? '', 10);
  return isNaN(raw) || raw <= 0 ? DEFAULT_MAX_OUTPUT_BYTES : raw;
}

/**
 * Truncates text to at most maxBytes UTF-8 bytes, walking back to the last
 * valid UTF-8 start byte to avoid splitting multi-byte characters.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  // Walk back to the last valid UTF-8 start byte
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xC0) === 0x80) end--;

  return (
    buf.slice(0, end).toString('utf8') +
    `\n[OUTPUT TRUNCATED: ${buf.length} bytes exceeded limit of ${maxBytes} bytes. ` +
    `Set SYMFONY_MCP_MAX_OUTPUT_BYTES to adjust.]`
  );
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Applies the full output sanitization pipeline to a tool result.
 *
 * This is the single choke-point for all tool outputs. Call it
 * at the end of executeWithSecurity() before returning to the client.
 *
 * @param result   - Raw tool result from the handler
 * @param toolName - Name of the tool (used for privacy mode)
 */
export function sanitizeToolResult(
  result: ToolResultLike,
  toolName: string
): ToolResultLike {
  // Step 0: Size cap — truncate before DLP to avoid processing oversized strings
  const maxBytes = getMaxOutputBytes();
  const content0 = result.content.map((item) => {
    if (typeof item.text !== 'string') return item;
    return { ...item, text: truncateToBytes(item.text, maxBytes) };
  });

  // Step 1–3: DLP + keyword + error sanitization on every content item
  const sanitized: ToolResultLike = {
    ...result,
    content: content0.map((item) => {
      if (typeof item.text !== 'string') return item;

      const before = item.text;
      const after = sanitizeText(before, result.isError === true);

      trackDlpChanges(before, after);

      return { ...item, text: after };
    }),
  };

  // Step 4: Privacy mode (data minimization)
  return applyPrivacyMode(sanitized, toolName);
}

/**
 * Returns the configured max output size in bytes (for testing/inspection).
 */
export function getMaxOutputBytesConfig(): number {
  return getMaxOutputBytes();
}

/**
 * Sanitizes only a string (for error message paths in server.ts catch blocks).
 */
export { sanitizeErrorMessage as sanitizeError };
