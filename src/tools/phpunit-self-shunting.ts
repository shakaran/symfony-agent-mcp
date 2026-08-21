/**
 * PHPUnit Self-Shunting Pattern Static Analyzer
 *
 * Scans tests/**\/*.php for PHPUnit self-shunting test pattern issues:
 *
 * - Test class implementing the interface it is testing (self-shunting pattern)
 * - Test class extending the class under test (fragile inheritance in tests)
 * - Test doubles defined as inner classes within the test file
 * - $this->getMockBuilder(get_class($this)) — mocking the test class itself
 * - Partial mock of class under test with setMethods/onlyMethods
 * - Test inheriting from production class AND TestCase via multiple traits
 *
 * Pure static analysis — no execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface PhpunitSelfShuntingInfo {
  file: string;
  type: 'implements' | 'extends' | 'inner-class' | 'self-mock' | 'partial-mock' | 'multi-inherit';
  issues: string[];
}

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

function scanDirRecursive(dir: string, ext: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...scanDirRecursive(full, ext));
      else if (entry.isFile() && entry.name.endsWith(ext)) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function analyzeSelfShuntingFile(filePath: string, appPath: string): PhpunitSelfShuntingInfo[] {
  const content = safeRead(filePath, appPath);
  if (content === null) return [];

  const relFile = path.relative(appPath, filePath);
  const results: PhpunitSelfShuntingInfo[] = [];
  const lines = content.split('\n');

  // implements — test class implementing an interface other than TestCase-related
  const implementsIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const m = /class\s+\w+Test\b[^{]*\bimplements\b([^{]+)/.exec(line);
    if (m) {
      const implemented = (m[1] ?? '').split(',').map((s) => s.trim());
      for (const iface of implemented) {
        if (!iface.includes('TestCase') && !iface.includes('Fixture') && iface.length > 0) {
          implementsIssues.push(`Line ${lineNo}: ${relFile.replace(/\.php$/, '')} implements ${iface} — self-shunting pattern, test class acts as its own test double`);
        }
      }
    }
  }
  if (implementsIssues.length > 0) {
    results.push({ file: relFile, type: 'implements', issues: implementsIssues });
  }

  // extends — test class extending something other than known test base classes
  const extendsIssues: string[] = [];
  const testBaseClasses = ['TestCase', 'KernelTestCase', 'WebTestCase', 'ApiTestCase', 'BrowserKitTestCase', 'DatabaseTestCase'];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const m = /class\s+\w+Test\b[^{]*\bextends\b\s+([\w\\]+)/.exec(line);
    if (m) {
      const parent = (m[1] ?? '').split('\\').pop() ?? '';
      const isKnownBase = testBaseClasses.some((base) => parent === base || parent.endsWith(base));
      if (!isKnownBase && parent.length > 0) {
        extendsIssues.push(`Line ${lineNo}: Test extends ${m[1] ?? ''} — extending production class in test creates fragile inheritance`);
      }
    }
  }
  if (extendsIssues.length > 0) {
    results.push({ file: relFile, type: 'extends', issues: extendsIssues });
  }

  // inner-class — anonymous class mocks or inline MockXxx class definitions
  const innerClassIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/\bnew\s+class\b/.test(line)) {
      innerClassIssues.push(`Line ${lineNo}: Anonymous class (new class) used as test double — consider using getMockBuilder() instead`);
    }
    if (/^class\s+Mock\w+/.test(line.trim()) || /^class\s+Stub\w+/.test(line.trim()) || /^class\s+Fake\w+/.test(line.trim())) {
      innerClassIssues.push(`Line ${lineNo}: Mock/Stub/Fake class defined in test file — move to a dedicated test double class`);
    }
  }
  if (innerClassIssues.length > 0) {
    results.push({ file: relFile, type: 'inner-class', issues: innerClassIssues });
  }

  // self-mock — getMockBuilder(get_class($this))
  const selfMockIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/getMockBuilder\s*\(\s*get_class\s*\(\s*\$this\s*\)/.test(line)) {
      selfMockIssues.push(`Line ${lineNo}: getMockBuilder(get_class($this)) — mocking the test class itself is a self-shunting anti-pattern`);
    }
  }
  if (selfMockIssues.length > 0) {
    results.push({ file: relFile, type: 'self-mock', issues: selfMockIssues });
  }

  // partial-mock — getMockBuilder with setMethods/onlyMethods
  const partialMockIssues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (/getMockBuilder\s*\(/.test(line) && (/setMethods\s*\(/.test(line) || /onlyMethods\s*\(/.test(line))) {
      partialMockIssues.push(`Line ${lineNo}: Partial mock with setMethods()/onlyMethods() on single line — same instance is both mock and SUT`);
    }
    if (/->setMethods\s*\(/.test(line) || /->onlyMethods\s*\(/.test(line)) {
      // look for surrounding getMockBuilder context (within 5 lines above)
      let foundBuilder = false;
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (/getMockBuilder\s*\(/.test(lines[j] ?? '')) {
          foundBuilder = true;
          break;
        }
      }
      if (foundBuilder) {
        partialMockIssues.push(`Line ${lineNo}: setMethods()/onlyMethods() on getMockBuilder — partial mock may be same instance as SUT`);
      }
    }
  }
  // deduplicate by line content
  const seenPartial = new Set<string>();
  const deduped = partialMockIssues.filter((msg) => {
    if (seenPartial.has(msg)) return false;
    seenPartial.add(msg);
    return true;
  });
  if (deduped.length > 0) {
    results.push({ file: relFile, type: 'partial-mock', issues: deduped });
  }

  // multi-inherit — test class using multiple traits where more than one looks like a TestCase-like trait
  const multiInheritIssues: string[] = [];
  const usedTraits: string[] = [];
  for (const line of lines) {
    const m = /^\s*use\s+([\w,\s\\]+);/.exec(line);
    if (m) {
      const traits = (m[1] ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0);
      usedTraits.push(...traits);
    }
  }
  const testLikeTraits = usedTraits.filter((t) => {
    const name = t.split('\\').pop() ?? '';
    return name.includes('TestCase') || name.includes('Kernel') || name.includes('WebTest') || name.includes('Sensitive');
  });
  if (testLikeTraits.length > 1) {
    multiInheritIssues.push(`Multiple TestCase-like traits used: ${testLikeTraits.join(', ')} — may indicate production class mixed into test via trait workaround`);
  }
  if (multiInheritIssues.length > 0) {
    results.push({ file: relFile, type: 'multi-inherit', issues: multiInheritIssues });
  }

  return results;
}

export function listPhpunitSelfShunting(appPath: string): McpToolResult {
  try {
    const testsDir = path.join(appPath, 'tests');
    const phpFiles = scanDirRecursive(testsDir, '.php');

    if (phpFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP test files found in tests/.' }] };
    }

    const allIssues: PhpunitSelfShuntingInfo[] = [];
    for (const file of phpFiles) {
      allIssues.push(...analyzeSelfShuntingFile(file, appPath));
    }

    if (allIssues.length === 0) {
      return {
        content: [{ type: 'text', text: `No self-shunting pattern issues found in ${phpFiles.length} test file(s). ✓` }],
      };
    }

    const byFile = new Map<string, PhpunitSelfShuntingInfo[]>();
    for (const issue of allIssues) {
      const existing = byFile.get(issue.file) ?? [];
      existing.push(issue);
      byFile.set(issue.file, existing);
    }

    let text = `PHPUnit Self-Shunting Pattern Issues\n${'='.repeat(50)}\n`;
    text += `\nTest files scanned: ${phpFiles.length}  Files with issues: ${byFile.size}  Total: ${allIssues.length}\n`;

    for (const [file, issues] of byFile) {
      text += `\n${file} (${issues.length}):\n`;
      for (const info of issues) {
        text += `  [${info.type}]\n`;
        for (const issue of info.issues) {
          text += `    - ${issue}\n`;
        }
      }
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpunitSelfShuntingStats(appPath: string): McpToolResult {
  try {
    const testsDir = path.join(appPath, 'tests');
    const phpFiles = scanDirRecursive(testsDir, '.php');

    const allIssues: PhpunitSelfShuntingInfo[] = [];
    for (const file of phpFiles) {
      allIssues.push(...analyzeSelfShuntingFile(file, appPath));
    }

    const counts: Record<string, number> = {
      implements: 0,
      extends: 0,
      'inner-class': 0,
      'self-mock': 0,
      'partial-mock': 0,
      'multi-inherit': 0,
    };
    for (const info of allIssues) {
      counts[info.type] = (counts[info.type] ?? 0) + 1;
    }

    const totalIssues = allIssues.reduce((sum, info) => sum + info.issues.length, 0);

    let text = `PHPUnit Self-Shunting Statistics\n${'='.repeat(45)}\n\n`;
    text += `Test files scanned:       ${phpFiles.length}\n`;
    text += `Total issue groups:       ${allIssues.length}\n`;
    text += `Total individual issues:  ${totalIssues}\n\n`;
    text += `By pattern type:\n`;
    text += `  implements (self-shunting):   ${counts['implements']}\n`;
    text += `  extends (prod class):         ${counts['extends']}\n`;
    text += `  inner-class (anonymous/mock): ${counts['inner-class']}\n`;
    text += `  self-mock (get_class($this)): ${counts['self-mock']}\n`;
    text += `  partial-mock (setMethods):    ${counts['partial-mock']}\n`;
    text += `  multi-inherit (mixed traits): ${counts['multi-inherit']}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpunitSelfShuntingTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_phpunit_self_shunting',
      description: 'Scan tests/**/*.php for PHPUnit self-shunting anti-patterns: test implements its own interface, extends production class, anonymous class doubles, getMockBuilder(get_class($this)), partial mocks on SUT, and multiple TestCase-like traits',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_phpunit_self_shunting_stats',
      description: 'Show statistics for PHPUnit self-shunting pattern issues grouped by type: implements/extends/inner-class/self-mock/partial-mock/multi-inherit counts and total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
