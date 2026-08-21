/**
 * Symfony VarDumper Custom Caster Inspector
 *
 * Scans src/**\/*.php for Symfony VarDumper custom caster patterns:
 *   - AbstractCloner::$defaultCasters extension without proper array merge += [...]
 *   - Caster returning non-array (must return array)
 *   - Missing Caster::PREFIX_PROTECTED / Caster::PREFIX_PRIVATE for visibility prefixes
 *   - VirtualValue usage without stub
 *   - Caster registered in services.yaml with wrong tag (data_collector instead of no tag)
 *   - dump() / dd() calls left in production code (non-test, non-debug files)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface VarDumperCasterInfo {
  file: string;
  line: number;
  pattern: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function collectFiles(dir: string, base: string, exts: string[]): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) continue;
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) results.push(...collectFiles(full, base, exts));
    else if (exts.some((e) => entry.endsWith(e))) results.push(full);
  }
  return results;
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  return /[/\\]tests?[/\\]|Test\.php$|Spec\.php$/.test(filePath);
}

function isDebugFile(filePath: string): boolean {
  return /[Dd]ebug|[Cc]ommand[/\\]Debug|DataCollector/.test(filePath);
}

// ─── PHP file analysis ─────────────────────────────────────────────────────────

function analyzePhpFile(filePath: string, base: string): VarDumperCasterInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: VarDumperCasterInfo[] = [];
  const isTest = isTestFile(filePath);
  const isDebug = isDebugFile(filePath);

  // Track caster method context for return type checking
  let inCasterMethod = false;
  let casterMethodStart = 0;
  let casterDepth = 0;
  let casterHasReturnArray = false;
  let casterHasReturn = false;
  let casterMethodName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    // Pattern 1: dump() / dd() in non-test, non-debug production code
    if (!isTest && !isDebug) {
      if (/\bdump\s*\(/.test(line) && !/[/]{2}.*dump\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'dump-in-production',
          issue: 'dump() call found in non-test, non-debug code — remove before deploying to production; use a logger instead: $this->logger->debug(...)',
          severity: 'high',
        });
      }
      if (/\bdd\s*\(/.test(line) && !/[/]{2}.*\bdd\s*\(/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'dd-in-production',
          issue: 'dd() (dump and die) call found in non-test, non-debug code — remove before deploying to production; this will halt request execution and expose debug output',
          severity: 'high',
        });
      }
    }

    // Pattern 2: AbstractCloner::$defaultCasters modification without += merge
    if (/AbstractCloner\s*::\s*\$defaultCasters/.test(line)) {
      if (/=\s*\[|=\s*array\s*\(/.test(line) && !/\+=/.test(line)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'default-casters-overwrite',
          issue: 'AbstractCloner::$defaultCasters is being assigned (=) instead of merged (+=) — this overwrites all built-in casters and will break dumping of core PHP/Symfony types; use: AbstractCloner::$defaultCasters += [YourClass::class => [YourCaster::class, \'castYour\']]',
          severity: 'high',
        });
      }
    }

    // Pattern 3: VirtualValue without stub
    if (/\bVirtualValue\s*\(/.test(line) || /new\s+VirtualValue\s*\(/.test(line)) {
      const contextWindow = lines.slice(Math.max(0, i - 2), i + 5).join('\n');
      if (!/->withStub\s*\(|stub\s*=|VirtualStub/.test(contextWindow)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'virtual-value-no-stub',
          issue: 'VirtualValue() used without a stub — VarDumper VirtualValue requires a stub (VirtualStub) to define how the value is displayed; add ->withStub(new VirtualStub(...))',
          severity: 'medium',
        });
      }
    }

    // Pattern 4: Caster method detection — track for return type and prefix checks
    const casterMethodMatch = /function\s+(cast\w+)\s*\(/.exec(line);
    if (casterMethodMatch) {
      inCasterMethod = true;
      casterMethodStart = lineNum;
      casterDepth = 0;
      casterHasReturnArray = false;
      casterHasReturn = false;
      casterMethodName = casterMethodMatch[1];
    }

    if (inCasterMethod) {
      for (const ch of line) {
        if (ch === '{') casterDepth++;
        else if (ch === '}') casterDepth--;
      }

      if (/\breturn\s+/.test(line)) {
        casterHasReturn = true;
        if (/\breturn\s+\[|\breturn\s+array\s*\(|\breturn\s+\$\w+\s*\+\s*\[/.test(line)) {
          casterHasReturnArray = true;
        }
      }

      // Check for missing PREFIX_PROTECTED / PREFIX_PRIVATE when accessing object properties
      if (/Caster::EXCLUDE_|Stub::|PREFIX_/.test(line)) {
        // They're using the Caster API — check for missing prefix constants
        if (!/PREFIX_PROTECTED|PREFIX_PRIVATE|PREFIX_VIRTUAL/.test(content)) {
          if (/protected\s+\$|private\s+\$/.test(content)) {
            results.push({
              file: relFile,
              line: lineNum,
              pattern: 'caster-missing-prefix',
              issue: 'Caster method uses Caster:: constants but does not reference PREFIX_PROTECTED or PREFIX_PRIVATE — VarDumper requires these prefixes (\\0 bytes) on array keys to represent property visibility; use Caster::PREFIX_PROTECTED and Caster::PREFIX_PRIVATE as key prefixes',
              severity: 'medium',
            });
          }
        }
      }

      // End of caster method
      if (casterDepth <= 0 && casterMethodStart > 0 && lineNum > casterMethodStart) {
        if (casterHasReturn && !casterHasReturnArray) {
          results.push({
            file: relFile,
            line: casterMethodStart,
            pattern: 'caster-non-array-return',
            issue: `Caster method "${casterMethodName}" (starting at line ${casterMethodStart}) has a return statement that does not clearly return an array — VarDumper casters MUST return an array; returning non-array causes a fatal error`,
            severity: 'high',
          });
        }
        inCasterMethod = false;
        casterMethodStart = 0;
      }
    }
  }

  return results;
}

// ─── YAML file analysis ───────────────────────────────────────────────────────

function analyzeYamlFile(filePath: string, base: string): VarDumperCasterInfo[] {
  const content = safeRead(filePath, base);
  if (content === null) return [];

  const relFile = path.relative(base, filePath);
  const lines = content.split('\n');
  const results: VarDumperCasterInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect caster services tagged as data_collector (wrong tag)
    if (/[Cc]aster/.test(line) || /cast\w+/.test(line)) {
      const lookahead = lines.slice(i, i + 10).join('\n');
      if (/tag[s]?\s*:\s*data_collector|name\s*:\s*data_collector/.test(lookahead)) {
        results.push({
          file: relFile,
          line: lineNum,
          pattern: 'caster-wrong-tag',
          issue: 'VarDumper caster service tagged with "data_collector" — casters are NOT registered via service tags; they are registered in PHP using AbstractCloner::$defaultCasters += [...]; remove the tag and add the caster registration in a compiler pass or bundle boot method',
          severity: 'medium',
        });
      }
    }
  }

  return results;
}

function loadAll(appPath: string): VarDumperCasterInfo[] {
  const srcDir = path.join(appPath, 'src');
  const configDir = path.join(appPath, 'config');
  const results: VarDumperCasterInfo[] = [];

  if (fs.existsSync(srcDir)) {
    for (const f of collectFiles(srcDir, appPath, ['.php'])) {
      results.push(...analyzePhpFile(f, appPath));
    }
  }
  if (fs.existsSync(configDir)) {
    for (const f of collectFiles(configDir, appPath, ['.yaml', '.yml'])) {
      results.push(...analyzeYamlFile(f, appPath));
    }
  }

  return results.sort((a, b) => {
    const sev: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || a.file.localeCompare(b.file) || a.line - b.line;
  });
}

// ─── Tool functions ───────────────────────────────────────────────────────────

export function listSymfonyVarDumperCasters(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);
    if (items.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No VarDumper caster issues found in src/ or config/.\n\n' +
            'Checked: dump()/dd() in production code, AbstractCloner::$defaultCasters overwrite, ' +
            'caster returning non-array, missing PREFIX_PROTECTED/PRIVATE, VirtualValue without stub, ' +
            'caster tagged as data_collector in services.yaml.',
        }],
      };
    }

    const high = items.filter((i) => i.severity === 'high');
    const medium = items.filter((i) => i.severity === 'medium');
    const low = items.filter((i) => i.severity === 'low');

    let text = `Symfony VarDumper Caster Analysis\n${'='.repeat(55)}\n\n`;
    text += `  Total findings:  ${items.length}\n`;
    text += `  High:            ${high.length}\n`;
    text += `  Medium:          ${medium.length}\n`;
    text += `  Low:             ${low.length}\n`;
    text += `  Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;

    for (const item of items) {
      text += `[${item.severity.toUpperCase()}] ${item.file}:${item.line}  [${item.pattern}]\n`;
      text += `  ${item.issue}\n\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getSymfonyVarDumperCastersStats(appPath: string): McpToolResult {
  try {
    const items = loadAll(appPath);

    const byPattern: Record<string, number> = {};
    for (const item of items) {
      byPattern[item.pattern] = (byPattern[item.pattern] ?? 0) + 1;
    }

    let text = `Symfony VarDumper Caster Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total:           ${items.length}\n`;
    text += `High:            ${items.filter((i) => i.severity === 'high').length}\n`;
    text += `Medium:          ${items.filter((i) => i.severity === 'medium').length}\n`;
    text += `Low:             ${items.filter((i) => i.severity === 'low').length}\n`;
    text += `Files affected:  ${new Set(items.map((i) => i.file)).size}\n\n`;
    text += `By pattern:\n`;
    for (const [pat, count] of Object.entries(byPattern)) {
      text += `  ${pat}: ${count}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getSymfonyVarDumperCastersTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_symfony_var_dumper_casters',
      description: 'Scan src/**/*.php and config/**/*.yaml for VarDumper caster issues: dump()/dd() in production code, AbstractCloner::$defaultCasters overwrite instead of +=, caster returning non-array (fatal), missing PREFIX_PROTECTED/PRIVATE, VirtualValue without stub, caster tagged as data_collector',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_symfony_var_dumper_casters_stats',
      description: 'Statistics for Symfony VarDumper caster findings: total count, breakdown by severity (high/medium/low) and pattern, files affected',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
