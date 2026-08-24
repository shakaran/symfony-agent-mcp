// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * PHP Interface Contract Test Inspector
 *
 * Detects interface contract test patterns:
 * abstract test classes, @dataProvider returning implementations,
 * testInterface* methods, classes extending abstract*Test.
 *
 * Warns on: interface with >3 implementations but no contract test,
 * abstract contract test not extended, contract test not covering all methods.
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface ContractCoverage {
  interface: string;
  implementations: number;
  hasContractTest: boolean;
  contractTestFile: string;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (entry.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

interface InterfaceInfo {
  name: string;
  file: string;
  methods: string[];
}

interface ImplementationInfo {
  className: string;
  interfaces: string[];
}

interface ContractTestInfo {
  className: string;
  file: string;
  isAbstract: boolean;
  interfaceNames: string[];
  testedMethods: string[];
  isExtended: boolean;
}

function parseInterfaces(srcDir: string): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const ifaceM = /\binterface\s+(\w{1,80})/m.exec(content);
    if (!ifaceM) continue;
    const name = ifaceM[1];
    const methodMatches = content.match(/\bpublic\s+function\s+(\w{1,80})\s*\(/gm) ?? [];
    const methods = methodMatches.map((m) => {
      const nm = /\bfunction\s+(\w{1,80})/.exec(m);
      return nm ? nm[1] : '';
    }).filter(Boolean);
    interfaces.push({ name, file, methods });
  }
  return interfaces;
}

function parseImplementations(srcDir: string): ImplementationInfo[] {
  const impls: ImplementationInfo[] = [];
  for (const file of getAllPhpFiles(srcDir)) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const classM = /\bclass\s+(\w{1,80})/m.exec(content);
    if (!classM) continue;
    const className = classM[1];
    const implM = /\bimplements\s+([^{]{1,300})/m.exec(content);
    if (!implM) continue;
    const interfaces = implM[1].split(',').map((i) => i.trim().split('\\').pop() ?? i.trim()).filter(Boolean);
    impls.push({ className, interfaces });
  }
  return impls;
}

function parseContractTests(testDirs: string[], appPath: string): ContractTestInfo[] {
  const tests: ContractTestInfo[] = [];
  const allTestFiles: string[] = [];
  for (const dir of testDirs) allTestFiles.push(...getAllPhpFiles(dir));

  const allAbstractTestClasses = new Set<string>();

  for (const file of allTestFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

    const classM = /\bclass\s+(\w{1,80})/m.exec(content);
    if (!classM) continue;
    const className = classM[1];

    const isAbstract = /\babstract\s+class\b/m.test(content);
    if (isAbstract) allAbstractTestClasses.add(className);

    // Detect if this is a contract test:
    // - abstract test class, OR
    // - has testInterface* methods, OR
    // - extends Abstract*Test, OR
    // - has @dataProvider returning implementations
    const hasTestInterfaceMethods = /\bfunction\s+testInterface\w{1,80}\s*\(/.test(content);
    const extendsAbstractTest = /\bextends\s+Abstract\w{0,80}Test\b/.test(content);
    const hasDataProvider = /@dataProvider\s+\w{1,80}/m.test(content);

    if (!isAbstract && !hasTestInterfaceMethods && !extendsAbstractTest && !hasDataProvider) continue;

    // Find which interface this contract test covers
    const interfaceNames: string[] = [];
    // Look for interface name in class name: FooInterfaceTest, FooContractTest
    const contractNameM = /(\w{1,80})(?:Interface|Contract)Test/.exec(className);
    if (contractNameM) interfaceNames.push(contractNameM[1] + 'Interface');

    // Also detect from dataProvider usage or class body
    const interfaceHints = content.match(/\b(\w{1,80}Interface)\b/gm) ?? [];
    for (const hint of interfaceHints) {
      if (!interfaceNames.includes(hint)) interfaceNames.push(hint);
    }

    const testedMethodMatches = content.match(/\bfunction\s+(test\w{1,80})\s*\(/gm) ?? [];
    const testedMethods = testedMethodMatches.map((m) => {
      const nm = /\bfunction\s+(test\w{1,80})/.exec(m);
      return nm ? nm[1] : '';
    }).filter(Boolean);

    tests.push({
      className,
      file: path.relative(appPath, file),
      isAbstract,
      interfaceNames,
      testedMethods,
      isExtended: false,
    });
  }

  // Mark abstract tests that are extended
  for (const file of allTestFiles) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const t of tests) {
      if (t.isAbstract && new RegExp(`\\bextends\\s+${t.className}\\b`).test(content)) {
        t.isExtended = true;
      }
    }
  }

  return tests;
}

export function listPhpContractTests(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const testDirs: string[] = [];
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) testDirs.push(p);
    }

    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const interfaces = parseInterfaces(srcDir);
    const implementations = parseImplementations(srcDir);
    const contractTests = parseContractTests(testDirs, appPath);

    if (interfaces.length === 0) {
      return { content: [{ type: 'text', text: 'No PHP interfaces found in src/.' }] };
    }

    const coverages: ContractCoverage[] = [];

    for (const iface of interfaces) {
      const implCount = implementations.filter((i) => i.interfaces.includes(iface.name)).length;
      if (implCount === 0) continue;

      // Check if contract test exists for this interface
      const contractTest = contractTests.find((t) => t.interfaceNames.some((n) => n === iface.name || n === iface.name + 'Interface'));
      const hasContractTest = Boolean(contractTest);
      const contractTestFile = contractTest?.file ?? '';

      const issues: string[] = [];

      if (implCount > 3 && !hasContractTest) {
        issues.push(`${iface.name}: ${implCount} implementations but no contract test`);
      }

      if (contractTest?.isAbstract && !contractTest.isExtended) {
        issues.push(`${iface.name}: abstract contract test '${contractTest.className}' not extended by any concrete test`);
      }

      if (hasContractTest && contractTest && iface.methods.length > 0) {
        const testedMethodNames = contractTest.testedMethods.map((m) => m.replace(/^test/, '').toLowerCase());
        const untestedMethods = iface.methods.filter((m) => !testedMethodNames.includes(m.toLowerCase()));
        if (untestedMethods.length > 0) {
          issues.push(`${iface.name}: contract test missing coverage for: ${untestedMethods.join(', ')}`);
        }
      }

      coverages.push({
        interface: iface.name,
        implementations: implCount,
        hasContractTest,
        contractTestFile,
        issues,
      });
    }

    if (coverages.length === 0) {
      return { content: [{ type: 'text', text: 'No interfaces with multiple implementations found.' }] };
    }

    const covered = coverages.filter((c) => c.hasContractTest).length;
    const uncovered = coverages.filter((c) => !c.hasContractTest).length;
    const totalIssues = coverages.reduce((s, c) => s + c.issues.length, 0);

    let text = `PHP Interface Contract Test Coverage\n${'='.repeat(55)}\n`;
    text += `\nInterfaces: ${coverages.length}  Covered: ${covered}  Uncovered: ${uncovered}  Issues: ${totalIssues}\n`;

    for (const c of coverages.sort((a, b) => b.issues.length - a.issues.length || a.interface.localeCompare(b.interface))) {
      const covTag = c.hasContractTest ? 'has-contract-test' : 'NO contract test';
      text += `\n  ${c.interface.padEnd(40)} impls: ${c.implementations}  ${covTag}\n`;
      if (c.contractTestFile) text += `    contract: ${c.contractTestFile}\n`;
      for (const issue of c.issues) text += `    ! ${issue}\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpContractTestStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const testDirs: string[] = [];
    for (const d of ['test', 'tests', 'Test', 'Tests']) {
      const p = path.join(appPath, d);
      if (fs.existsSync(p)) testDirs.push(p);
    }

    const interfaces = fs.existsSync(srcDir) ? parseInterfaces(srcDir) : [];
    const implementations = fs.existsSync(srcDir) ? parseImplementations(srcDir) : [];
    const contractTests = parseContractTests(testDirs, appPath);

    let covered = 0;
    let uncovered = 0;
    let totalIssues = 0;

    for (const iface of interfaces) {
      const implCount = implementations.filter((i) => i.interfaces.includes(iface.name)).length;
      if (implCount === 0) continue;
      const hasContractTest = contractTests.some((t) => t.interfaceNames.some((n) => n === iface.name || n === iface.name + 'Interface'));
      if (hasContractTest) covered++;
      else {
        uncovered++;
        if (implCount > 3) totalIssues++;
      }
    }

    const abstractTests = contractTests.filter((t) => t.isAbstract);
    const unextendedAbstract = abstractTests.filter((t) => !t.isExtended).length;

    let text = `PHP Contract Test Statistics\n${'='.repeat(40)}\n\n`;
    text += `Interfaces with impls:   ${covered + uncovered}\n`;
    text += `  Covered:               ${covered}\n`;
    text += `  Uncovered:             ${uncovered}\n`;
    text += `Contract tests:          ${contractTests.length}\n`;
    text += `  Abstract:              ${abstractTests.length}\n`;
    text += `  Unextended abstract:   ${unextendedAbstract}\n`;
    text += `Total issues:            ${totalIssues + unextendedAbstract}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getPhpContractTestTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_php_contract_tests',
      description: 'List PHP interface contract test coverage: interfaces with >3 implementations missing contract test, unextended abstract contract tests, contract tests not covering all interface methods',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_php_contract_test_stats',
      description: 'Statistics for PHP interface contract tests: total interfaces, covered, uncovered, abstract contract tests, unextended abstract tests',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
