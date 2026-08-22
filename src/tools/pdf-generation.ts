import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface PdfGenerationInfo {
  file: string;
  type: 'library' | 'template' | 'security' | 'performance' | 'config';
  pattern: string;
  issues: string[];
}

function buildPdfGenerationInfos(appPath: string): PdfGenerationInfo[] {
  const results: PdfGenerationInfo[] = [];

  let pdfLibrary = '';
  const composerPath = path.join(appPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as Record<string, unknown>;
      const req = (composer['require'] ?? {}) as Record<string, string>;
      if (req['dompdf/dompdf']) pdfLibrary = 'dompdf';
      else if (req['tecnickcom/tcpdf']) pdfLibrary = 'tcpdf';
      else if (req['mpdf/mpdf']) pdfLibrary = 'mpdf';
      else if (req['barryvdh/laravel-dompdf'] || req['knplabs/knp-snappy-bundle']) pdfLibrary = 'snappy/wkhtmltopdf';
    } catch { /* ignore */ }
  }

  if (pdfLibrary) {
    results.push({ file: 'composer.json', type: 'library', pattern: `PDF library: ${pdfLibrary}`, issues: [] });
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
            if (!content.includes('Dompdf') && !content.includes('TCPDF') && !content.includes('Mpdf') && !content.includes('Snappy') && !content.includes('pdf') && !content.includes('PDF')) return;

            const relFile = path.relative(appPath, full);
            const issues: string[] = [];

            const hasUserHtml = content.includes('loadHtml(') || content.includes('writeHTML(') || content.includes('SetContent(');
            const hasSanitization = content.includes('htmlspecialchars') || content.includes('strip_tags') || content.includes('sanitize') || content.includes('htmlentities') || content.includes('|e') || content.includes('escape');
            if (hasUserHtml && !hasSanitization) {
              issues.push(`PDF generation from HTML in "${relFile}" without sanitization — if HTML contains user input, XSS via PDF objects is possible; sanitize HTML content before passing to PDF renderer`);
            }

            const hasExternalUrl = content.includes('http://') || content.includes('https://');
            const hasDomPdfUrlEnabled = content.includes('enable_remote') || content.includes('isRemoteEnabled') || content.includes('DOMPDF_ENABLE_REMOTE');
            if (hasExternalUrl && hasDomPdfUrlEnabled) {
              issues.push(`PDF generator in "${relFile}" with remote URL loading enabled — DOMPDF/mPDF with remote content can be used for SSRF (fetching internal services); disable remote loading or restrict to trusted CDN domains`);
            }

            const hasLargeQuery = content.includes('findAll()') || (content.includes('getResult()') && !content.includes('setMaxResults'));
            if (hasLargeQuery && (content.includes('pdf') || content.includes('Pdf') || content.includes('PDF'))) {
              issues.push(`PDF generation in "${relFile}" with unbounded query — generating PDFs from findAll() results exhausts memory; paginate the query or use generators to stream large datasets`);
            }

            const hasSyncGeneration = content.includes('Content-Disposition: attachment') || content.includes('setResponseHeaders');
            if (hasSyncGeneration && content.includes('findAll()')) {
              issues.push(`PDF served synchronously in "${relFile}" with large data set — PDF generation blocks the web request; dispatch PDF generation to Messenger and serve download link via polling or email`);
            }

            results.push({ file: relFile, type: 'security', pattern: 'PDF generation', issues });
          }
        }
      } catch { /* skip */ }
    };
    checkFiles(srcDir);
  }

  return results;
}

export function listPdfGeneration(appPath: string): McpToolResult {
  try {
    const infos = buildPdfGenerationInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No PDF generation patterns found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `PDF Generation Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.pattern}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPdfGenerationStats(appPath: string): McpToolResult {
  try {
    const infos = buildPdfGenerationInfos(appPath);
    let text = `PDF Generation Statistics\n${'='.repeat(40)}\n\n`;
    text += `Libraries:  ${infos.filter((i) => i.type === 'library').length}\n`;
    text += `Security:   ${infos.filter((i) => i.type === 'security').length}\n`;
    text += `Issues:     ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getPdfGenerationTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_pdf_generation', description: 'Analyze PDF generation (dompdf/tcpdf/mpdf/snappy); warns on unsanitized HTML content from user input, SSRF via remote URL loading, unbounded findAll() for PDF data, synchronous generation blocking web requests', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_pdf_generation_stats', description: 'Statistics for PDF generation: library/security count, issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
