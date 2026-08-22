import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

interface ExcelGenerationInfo {
  file: string;
  type: 'library' | 'injection' | 'performance' | 'security' | 'memory';
  pattern: string;
  issues: string[];
}


function buildExcelGenerationInfos(appPath: string): ExcelGenerationInfo[] {
  const results: ExcelGenerationInfo[] = [];

  let excelLibrary = '';
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['phpoffice/phpspreadsheet']) excelLibrary = 'phpspreadsheet';
      else if (req['phpoffice/phpexcel']) excelLibrary = 'phpexcel (deprecated)';
      else if (req['rap2hpoutre/fast-excel']) excelLibrary = 'fast-excel';
      else if (req['maatwebsite/excel']) excelLibrary = 'maatwebsite/excel';

      if (excelLibrary === 'phpexcel (deprecated)') {
        results.push({ file: 'composer.json', type: 'library', pattern: 'phpoffice/phpexcel (deprecated)', issues: ['phpoffice/phpexcel is abandoned — migrate to phpoffice/phpspreadsheet which is the maintained successor with PHP 8.x support'] });
      } else if (excelLibrary) {
        results.push({ file: 'composer.json', type: 'library', pattern: `Excel library: ${excelLibrary}`, issues: [] });
      }
    } catch { /* ignore */ }
  }

  const srcDir = path.join(appPath, 'src');
  if (fs.existsSync(srcDir)) {
    const checkFiles = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) checkFiles(full);
          else if (e.name.endsWith('.php')) {
            let content = '';
            try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }
            if (!content.includes('Spreadsheet') && !content.includes('PhpSpreadsheet') && !content.includes('PHPExcel') && !content.includes('FastExcel') && !content.includes('setCellValue') && !content.includes('.xlsx') && !content.includes('.csv')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasCsvOutput = content.includes('.csv') || content.includes('fputcsv') || content.includes('setCsvWriter');
            if (hasCsvOutput) {
              const hasFormulaInjectionCheck = content.includes('ltrim') || content.includes('sanitize') || content.includes('=') === false || content.includes('formula');
              if (!hasFormulaInjectionCheck) {
                issues.push(`CSV/Excel export in "${relFile}" without formula injection protection — user-supplied values starting with =, +, -, @ are interpreted as formulas in Excel; prefix with single quote or validate values to prevent CSV injection`);
              }
            }

            const hasAllDataInMemory = content.includes('findAll()') || (content.includes('getResult()') && !content.includes('setMaxResults'));
            if (hasAllDataInMemory) {
              issues.push(`Excel generation in "${relFile}" loads all rows into memory — for large exports use streaming writer (ChunkReadFilter, spreadsheet->setActiveSheetIndex with chunked queries) or AsyncExcel to avoid OOM`);
            }

            const hasUserFilenameControl = content.includes('getClientOriginalName') || content.includes('$_GET[') || content.includes('$request->get(') && content.includes('filename');
            if (hasUserFilenameControl) {
              issues.push(`Excel download filename in "${relFile}" from user input — normalize filename to alphanumeric and sanitize to prevent Content-Disposition header injection`);
            }

            const hasLargeExport = content.includes('1000') || content.includes('10000') || content.includes('findBy([], null)');
            if (hasLargeExport && !content.includes('dispatch') && !content.includes('async')) {
              issues.push(`Large Excel export in "${relFile}" generated synchronously — generating large Excel files blocks the request; dispatch generation as async Messenger job and notify user when ready`);
            }

            results.push({ file: relFile, type: 'security', pattern: 'Excel generation', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listExcelGeneration(appPath: string): McpToolResult {
  try {
    const infos = buildExcelGenerationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Excel generation patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Excel Generation Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getExcelGenerationStats(appPath: string): McpToolResult {
  try {
    const infos = buildExcelGenerationInfos(appPath);
    let text = `Excel Generation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Libraries:  ${infos.filter((i) => i.type === 'library').length}\n`;
    text += `Security:   ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getExcelGenerationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_excel_generation', description: 'Analyze Excel/CSV generation (phpspreadsheet/phpexcel/fast-excel); warns on deprecated phpexcel, CSV injection via formula prefix, loading all rows into memory, user-controlled filename in headers, large synchronous export blocking requests', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_excel_generation_stats', description: 'Statistics for Excel generation: library/security count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
