// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Prompt Injection Detector (Q)
 *
 * Scans tool outputs for text patterns that could instruct an LLM to change
 * its behaviour. A malicious Symfony application (or compromised data source)
 * could embed "Ignore all previous instructions" in a log entry or DB value,
 * causing the AI assistant consuming tool output to be hijacked.
 *
 * Only HIGH-confidence patterns are redacted to minimise false positives.
 * Every matched pattern is replaced with [FILTERED:PROMPT_INJECTION:<name>].
 *
 * Configuration:
 *   SYMFONY_MCP_PROMPT_INJECTION=false  — disable detection (not recommended)
 */

export interface InjectionMatch {
  pattern: string;
  start: number;
  end: number;
  matched: string;
}

interface InjectionPattern {
  name: string;
  regex: RegExp;
}

// Only patterns with very low false-positive rates are included.
// Patterns requiring "act as X" or "you are X" are intentionally omitted —
// they appear in legitimate Symfony documentation and log content.
const PATTERNS: InjectionPattern[] = [
  // ── Direct instruction override ──────────────────────────────────────────
  {
    name: 'IGNORE_INSTRUCTIONS',
    regex: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/gi,
  },
  {
    name: 'DISREGARD_INSTRUCTIONS',
    regex: /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context|rules?|constraints?)\b/gi,
  },
  {
    name: 'OVERRIDE_INSTRUCTIONS',
    regex: /\boverride\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions?|rules?|restrictions?|constraints?)\b/gi,
  },
  {
    name: 'FORGET_INSTRUCTIONS',
    regex: /\bforget\s+(?:everything|all)\s+(?:you\s+(?:have\s+been\s+)?told|the\s+(?:above|previous|prior)\s+(?:instructions?|context))\b/gi,
  },
  {
    name: 'NEW_INSTRUCTIONS',
    regex: /\byour\s+(?:new|updated|actual|real)\s+instructions?\s+(?:are|is|follow)\b/gi,
  },

  // ── LLM system message injection markers ─────────────────────────────────
  {
    name: 'SYSTEM_MARKER',
    // Matches [SYSTEM], <<SYS>>, [INST] at the start of a line
    regex: /(?:^|\n)\s*(?:\[SYSTEM\]|<<SYS>>|\[INST\])\s*[:：]?[ \t]*/gim,
  },
  {
    name: 'XML_SYSTEM_TAG',
    // Matches <system>...</system> blocks (common in Llama/Claude prompt templates)
    regex: /<\s*system\s*>[\s\S]{0,500}<\s*\/\s*system\s*>/gi,
  },

  // ── Role/persona injection (only when combined with "unrestricted" framing) ─
  {
    name: 'UNRESTRICTED_ROLE',
    regex: /\byou\s+are\s+now\s+(?:a|an|the)\s+(?:unrestricted|unfiltered|uncensored|free|jailbroken|DAN)\b/gi,
  },

  // ── Jailbreak keywords ───────────────────────────────────────────────────
  {
    name: 'JAILBREAK',
    regex: /\b(?:DAN\s+mode|jailbroken?|jailbreak(?:ed)?|do\s+anything\s+now|no[\s-]restrictions?\s+mode|developer\s+mode\s+(?:is\s+)?enabled|evil\s+mode)\b/gi,
  },

  // ── Prompt delimiter injection ────────────────────────────────────────────
  {
    name: 'PROMPT_DELIMITER',
    // Common delimiters used to escape prompt context in various LLM frameworks
    regex: /(?:^|\n)\s*(?:###\s*(?:System|Instruction)|<\|(?:system|im_start)\|>|\[\/INST\]|<\|endoftext\|>)\s*/gim,
  },
];

function isDetectionEnabled(): boolean {
  return process.env['SYMFONY_MCP_PROMPT_INJECTION'] !== 'false';
}

/**
 * Scans text for prompt injection patterns. Returns all matches found.
 */
export function scanForInjection(text: string): InjectionMatch[] {
  if (!isDetectionEnabled() || !text) return [];

  const matches: InjectionMatch[] = [];

  for (const def of PATTERNS) {
    def.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.regex.exec(text)) !== null) {
      matches.push({
        pattern: def.name,
        start: m.index,
        end: m.index + m[0].length,
        matched: m[0],
      });
    }
  }

  // Sort by start position; longer matches win on overlap
  return matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}

/**
 * Redacts all detected prompt injection patterns from text.
 * Each match is replaced with [FILTERED:PROMPT_INJECTION:<PATTERN_NAME>].
 */
export function redactInjections(text: string): string {
  if (!isDetectionEnabled() || !text) return text;

  const matches = scanForInjection(text);
  if (matches.length === 0) return text;

  let result = '';
  let cursor = 0;

  for (const match of matches) {
    if (match.start < cursor) continue; // skip overlapping
    result += text.slice(cursor, match.start);
    result += `[FILTERED:PROMPT_INJECTION:${match.pattern}]`;
    cursor = match.end;
  }

  result += text.slice(cursor);
  return result;
}

/**
 * Returns whether prompt injection detection is currently enabled.
 */
export function isPromptInjectionEnabled(): boolean {
  return isDetectionEnabled();
}
