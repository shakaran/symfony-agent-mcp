import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';


interface DoctrineColumnDefaultInfo {
  file: string;
  type: 'missing-default' | 'boolean' | 'datetime' | 'enum' | 'nullable';
  entity: string;
  column: string;
  issues: string[];
}

function buildDoctrineColumnDefaultInfos(appPath: string): DoctrineColumnDefaultInfo[] {
  const results: DoctrineColumnDefaultInfo[] = [];

  const srcDir = path.join(appPath, 'src');
  if (!fs.existsSync(srcDir)) return results;

  const checkFiles = (dir: string): void => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) checkFiles(full);
        else if (e.name.endsWith('.php')) {
          let content = '';
          try { content = fs.readFileSync(full, 'utf-8'); } catch { return; }

          if (!content.includes('#[Column') && !content.includes('@Column') && !content.includes('ORM\\Column')) return;

          const relFile = path.relative(appPath, full);
          const entityNameMatch = /class\s+(\w+)/.exec(content);
          const entityName = entityNameMatch ? entityNameMatch[1] : path.basename(full, '.php');

          const columnRegex = /#\[(?:ORM\\)?Column\(([^)]+)\)\]\s*(?:#\[[^\]]+\]\s*)*(?:private|protected|public)\s+[^$]*\$(\w+)/g;
          let match: RegExpExecArray | null;

          while ((match = columnRegex.exec(content)) !== null) {
            const attrs = match[1];
            const columnName = match[2];

            const hasDefault = attrs.includes('default') || attrs.includes("'default'") || attrs.includes('"default"');
            const isNullable = attrs.includes('nullable: true') || attrs.includes("nullable: true") || attrs.includes('nullable:true');
            const typeMatch = /type:\s*['"]?([^,'")\s]+)['"]?/.exec(attrs) ||
              /Types::(\w+)/.exec(attrs);
            const columnType = typeMatch ? typeMatch[1].toLowerCase() : '';

            if (columnType === 'boolean' && !hasDefault && !isNullable) {
              results.push({
                file: relFile,
                type: 'boolean',
                entity: entityName,
                column: columnName,
                issues: [
                  `Boolean column '${columnName}' without default value — generates a NOT NULL column without a default; add options: ['default' => false] or make nullable`,
                ],
              });
            } else if ((columnType === 'datetime' || columnType === 'datetime_immutable') && !hasDefault && !isNullable) {
              results.push({
                file: relFile,
                type: 'datetime',
                entity: entityName,
                column: columnName,
                issues: [
                  `DateTime column '${columnName}' is NOT NULL without a default value — inserting records without this field will fail; add nullable: true or provide a default`,
                ],
              });
            } else if (columnType === 'string' && !hasDefault && !isNullable) {
              results.push({
                file: relFile,
                type: 'missing-default',
                entity: entityName,
                column: columnName,
                issues: [
                  `String column '${columnName}' is NOT NULL without a default value — adding records without this field will fail; add default or nullable: true`,
                ],
              });
            }

            if (attrs.includes('enumType') && !hasDefault) {
              results.push({
                file: relFile,
                type: 'enum',
                entity: entityName,
                column: columnName,
                issues: [
                  `Enum column '${columnName}' without default value — migrations will fail on existing data; add options: ['default' => 'value']`,
                ],
              });
            }
          }
        }
      }
    } catch { /* skip */ }
  };
  checkFiles(srcDir);

  return results;
}

export function listDoctrineColumnDefaults(appPath: string): McpToolResult {
  try {
    const infos = buildDoctrineColumnDefaultInfos(appPath);
    if (infos.length === 0) {
      return { content: [{ type: 'text', text: 'No Doctrine column default issues found.' }] };
    }
    const totalIssues = infos.reduce((s, i) => s + i.issues.length, 0);
    let text = `Doctrine Column Defaults Analysis\n${'='.repeat(55)}\n\nPatterns: ${infos.length}  Issues: ${totalIssues}\n`;
    for (const info of infos) {
      text += `\n  [${info.type.toUpperCase()}] ${info.entity}.${info.column}  (${info.file})\n`;
      for (const issue of info.issues) text += `    WARNING: ${issue}\n`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineColumnDefaultStats(appPath: string): McpToolResult {
  try {
    const infos = buildDoctrineColumnDefaultInfos(appPath);
    let text = `Doctrine Column Default Statistics\n${'='.repeat(40)}\n\n`;
    text += `Missing-default: ${infos.filter((i) => i.type === 'missing-default').length}\n`;
    text += `Boolean:         ${infos.filter((i) => i.type === 'boolean').length}\n`;
    text += `Datetime:        ${infos.filter((i) => i.type === 'datetime').length}\n`;
    text += `Enum:            ${infos.filter((i) => i.type === 'enum').length}\n`;
    text += `Nullable:        ${infos.filter((i) => i.type === 'nullable').length}\n`;
    text += `Issues:          ${infos.reduce((s, i) => s + i.issues.length, 0)}\n`;
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

export function getDoctrineColumnDefaultTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    { name: 'list_doctrine_column_defaults', description: 'Analyze Doctrine entity columns for missing defaults; warns on boolean/datetime/string NOT NULL columns without defaults, enum columns without defaults', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
    { name: 'get_doctrine_column_default_stats', description: 'Statistics for Doctrine column defaults: counts by type (missing-default/boolean/datetime/enum/nullable), issue count', inputSchema: { type: 'object', properties: prop, required: ['app_path'] } },
  ];
}
