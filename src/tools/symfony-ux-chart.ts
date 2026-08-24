// SPDX-FileCopyrightText: 2026 Ángel Guzmán Maeso <angel@guzmanmaeso.com>
// SPDX-License-Identifier: MIT
/**
 * Symfony UX Chart.js Inspector
 *
 * Checks composer.json for symfony/ux-chartjs.
 * Scans src/ PHP for Chart class, ChartBuilderInterface, ChartType usage.
 * Scans Twig templates for render_chart(), ux_chart().
 *
 * Warnings:
 *   - Chart without label for datasets (unlabeled chart)
 *   - ChartBuilder without ->setData() (empty chart)
 *   - Large dataset array hardcoded in PHP (should be from DB)
 *   - render_chart() without aria DataTable attribute (accessibility)
 *   - chart without responsive: true option (fixed size in responsive layout)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface UxChartInfo {
  file: string;
  class?: string;
  chartType: string;
  hasData: boolean;
  hasLabels: boolean;
  isRenderedInTwig: boolean;
  issues: string[];
}

function getAllPhpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getAllPhpFiles(full));
      else if (e.name.endsWith('.php')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function getTwigFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) files.push(...getTwigFiles(full));
      else if (e.name.endsWith('.twig') || e.name.endsWith('.html.twig')) files.push(full);
    }
  } catch { /* skip */ }
  return files;
}

function checkComposerForUxChart(appPath: string): boolean {
  try {
    const content = fs.readFileSync(path.join(appPath, 'composer.json'), 'utf-8');
    return content.includes('symfony/ux-chartjs');
  } catch { return false; }
}

function getTwigChartUsages(appPath: string): Map<string, number> {
  const usages = new Map<string, number>();
  const templateDirs = [
    path.join(appPath, 'templates'),
    path.join(appPath, 'src'),
  ];

  for (const dir of templateDirs) {
    for (const f of getTwigFiles(dir)) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const hasRenderChart = content.includes('render_chart(') || content.includes('ux_chart(');
        if (hasRenderChart) {
          const hasAriaDataTable = content.includes('aria') || content.includes('data-table') ||
            content.includes('DataTable') || content.includes('role=');
          usages.set(f, hasAriaDataTable ? 1 : 0);
        }
      } catch { /* skip */ }
    }
  }
  return usages;
}

function parseChartFile(filePath: string): UxChartInfo | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasChart = content.includes('ChartBuilderInterface') ||
    content.includes('new Chart(') ||
    content.includes('ChartType::') ||
    (content.includes('Chart') && content.includes('createChart'));

  if (!hasChart) return null;

  const classM = /class\s+(\w{1,100})/.exec(content);

  // Detect chart type
  let chartType = 'unknown';
  const chartTypePatterns = [
    /ChartType::(\w{1,50})/,
    /createChart\s*\(\s*['"](\w{1,50})['"]/,
    /'type'\s*=>\s*['"](\w{1,50})['"]/,
  ];
  for (const p of chartTypePatterns) {
    const m = p.exec(content);
    if (m) { chartType = m[1].toLowerCase(); break; }
  }

  const hasData = content.includes('->setData(') ||
    content.includes("'data'") ||
    content.includes('"data"') ||
    content.includes('datasets');

  const hasLabels = content.includes("'labels'") ||
    content.includes('"labels"') ||
    content.includes('->setLabels(') ||
    content.includes('label:') ||
    content.includes("'label'");

  const isRenderedInTwig = false; // Determined separately via Twig scan

  const issues: string[] = [];

  // Chart without setData()
  if (!hasData && content.includes('ChartBuilderInterface')) {
    issues.push('ChartBuilder used without ->setData() call — chart will be empty');
  }

  // Dataset without labels
  if (hasData && !hasLabels) {
    issues.push('Chart datasets without labels — chart legend will be empty');
  }

  // Large hardcoded dataset (more than 20 array entries)
  const arrayEntryCount = (content.match(/=>/g) ?? []).length;
  if (arrayEntryCount > 20 && !content.includes('->findAll(') && !content.includes('$repository') &&
    !content.includes('createQueryBuilder') && !content.includes('$em->')) {
    issues.push('Large dataset array hardcoded in PHP (>20 entries) — consider fetching from database');
  }

  // No responsive option
  if (content.includes('ChartBuilder') && !content.includes('responsive')) {
    issues.push('Chart options without responsive: true — may render as fixed size in responsive layouts');
  }

  return {
    file: path.basename(filePath),
    class: classM ? classM[1] : undefined,
    chartType,
    hasData,
    hasLabels,
    isRenderedInTwig,
    issues,
  };
}

export function listUxChart(appPath: string): McpToolResult {
  try {
    const hasUxChart = checkComposerForUxChart(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: UxChartInfo[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseChartFile(f);
      if (info) results.push(info);
    }

    // Get Twig usages
    const twigUsages = getTwigChartUsages(appPath);
    const twigCount = twigUsages.size;
    const twigWithoutAria = [...twigUsages.values()].filter((v) => v === 0).length;

    if (results.length === 0 && !hasUxChart) {
      return { content: [{ type: 'text', text: 'symfony/ux-chartjs not installed and no Chart usage found.' }] };
    }

    const totalIssues = results.reduce((s, r) => s + r.issues.length, 0) + twigWithoutAria;

    let text = `Symfony UX Chart.js Analysis\n${'='.repeat(55)}\n`;
    text += `\nux-chartjs installed: ${hasUxChart ? 'yes' : 'no'}  PHP files: ${results.length}  Twig usages: ${twigCount}  Issues: ${totalIssues}\n`;

    for (const r of results) {
      const cls = r.class ? r.class : path.basename(r.file, '.php');
      text += `\n  ${cls.padEnd(45)} (${r.file})\n`;
      text += `    type: ${r.chartType}  data: ${r.hasData}  labels: ${r.hasLabels}\n`;
      for (const issue of r.issues) text += `    ! ${issue}\n`;
    }

    if (twigWithoutAria > 0) {
      text += `\nTwig render_chart() without aria/DataTable accessibility attribute: ${twigWithoutAria} file(s)\n`;
      for (const [f, hasAria] of twigUsages) {
        if (hasAria === 0) {
          text += `  ! ${path.basename(f)} — add aria-label or data-table for accessibility\n`;
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

export function getUxChartStats(appPath: string): McpToolResult {
  try {
    const hasUxChart = checkComposerForUxChart(appPath);
    const srcDir = path.join(appPath, 'src');
    const results: UxChartInfo[] = [];

    for (const f of getAllPhpFiles(srcDir)) {
      const info = parseChartFile(f);
      if (info) results.push(info);
    }

    const twigUsages = getTwigChartUsages(appPath);
    const twigWithoutAria = [...twigUsages.values()].filter((v) => v === 0).length;

    const byType = new Map<string, number>();
    for (const r of results) {
      byType.set(r.chartType, (byType.get(r.chartType) ?? 0) + 1);
    }

    let text = `UX Chart.js Statistics\n${'='.repeat(40)}\n\n`;
    text += `symfony/ux-chartjs installed:   ${hasUxChart ? 'yes' : 'no'}\n`;
    text += `PHP chart builder files:        ${results.length}\n`;
    text += `Twig render_chart() usages:     ${twigUsages.size}\n`;
    text += `Without aria attribute:         ${twigWithoutAria}\n`;
    text += `With datasets:                  ${results.filter((r) => r.hasData).length}\n`;
    text += `With labels:                    ${results.filter((r) => r.hasLabels).length}\n`;
    text += `Total issues:                   ${results.reduce((s, r) => s + r.issues.length, 0) + twigWithoutAria}\n`;
    if (byType.size > 0) {
      text += `\nChart types:\n`;
      for (const [type, count] of byType) {
        text += `  ${type.padEnd(20)} ${count}\n`;
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

export function getUxChartTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_ux_chart',
      description: 'Inspect Symfony UX Chart.js usage: ChartBuilderInterface calls, ChartType detection, dataset/label checks, Twig render_chart() accessibility; warns on empty charts, unlabeled datasets, hardcoded large datasets, missing responsive option, missing aria attributes',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_ux_chart_stats',
      description: 'Get UX Chart.js statistics: chart builder file count, Twig usage count, chart types breakdown, accessibility coverage, total issues',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
