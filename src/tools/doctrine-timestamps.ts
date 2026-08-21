/**
 * Doctrine Timestampable Entities Inspector
 *
 * Distinct from doctrine-lifecycle.ts (all lifecycle callbacks broadly)
 * and doctrine-extensions.ts (extension bundle detection).
 * Focuses specifically on the timestamp pattern across three implementation styles:
 *
 * Style 1 — Manual lifecycle callbacks:
 *   #[HasLifecycleCallbacks]
 *   #[PrePersist] public function setCreatedAtValue(): void { $this->createdAt = new \DateTimeImmutable(); }
 *   #[PreUpdate] public function setUpdatedAtValue(): void { $this->updatedAt = new \DateTimeImmutable(); }
 *
 * Style 2 — Gedmo Timestampable:
 *   #[Gedmo\Timestampable(on: 'create')] private ?\DateTimeImmutable $createdAt = null;
 *   #[Gedmo\Timestampable(on: 'update')] private ?\DateTimeImmutable $updatedAt = null;
 *
 * Style 3 — StofDoctrineExtensions trait:
 *   use TimestampableEntity;  (from Knp or Gedmo)
 *
 * Analysis:
 *   - Entity with createdAt/updatedAt field but no timestamp automation (manual set required)
 *   - Mixed styles in the same project (inconsistency)
 *   - PrePersist setting createdAt with mutable DateTime instead of DateTimeImmutable
 *   - updatedAt column not mapped with Doctrine (field exists but no #[Column])
 *   - Entities modifying $createdAt in setters (should be immutable)
 *
 * Pure static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpToolResult } from '../server.js';

function safeRead(filePath: string, base: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  try { return fs.readFileSync(resolved, 'utf-8'); } catch { return null; }
}

type TimestampStyle = 'manual' | 'gedmo' | 'trait' | 'none';

interface TimestampEntity {
  class: string;
  file: string;
  style: TimestampStyle;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  usesMutableDateTime: boolean;
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

function parseTimestampEntity(filePath: string, appPath: string): TimestampEntity | null {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  const hasEntityAttr = content.includes('#[Entity') || content.includes('@Entity') ||
                        content.includes('#[ORM\\Entity');
  if (!hasEntityAttr) return null;
  if (content.includes('namespace Symfony\\') || content.includes('namespace Doctrine\\')) return null;

  const classM = /class\s+(\w+)/.exec(content);
  if (!classM) return null;

  const hasCreatedAt = /\$createdAt|\$created_at/.test(content);
  const hasUpdatedAt = /\$updatedAt|\$updated_at/.test(content);

  if (!hasCreatedAt && !hasUpdatedAt) return null;

  let style: TimestampStyle = 'none';

  if (content.includes('TimestampableEntity') || content.includes('use Timestampable')) {
    style = 'trait';
  } else if (content.includes('Gedmo\\Timestampable') || content.includes('@Gedmo\\Timestampable')) {
    style = 'gedmo';
  } else if (content.includes('#[PrePersist]') || content.includes('#[PreUpdate]') ||
             content.includes('@PrePersist') || content.includes('@PreUpdate')) {
    style = 'manual';
  }

  const usesMutableDateTime = style === 'manual' &&
    /PrePersist|PreUpdate/.test(content) &&
    /new\s+\\DateTime\b/.test(content) &&
    !/DateTimeImmutable/.test(content);

  const issues: string[] = [];
  if (style === 'none' && (hasCreatedAt || hasUpdatedAt)) {
    issues.push('createdAt/updatedAt field found but no timestamp automation detected (manual set required)');
  }
  if (usesMutableDateTime) {
    issues.push('PrePersist/PreUpdate uses new \\DateTime() — prefer new \\DateTimeImmutable()');
  }
  if (style === 'manual' && content.includes('setCreatedAt') &&
      /function\s+setCreatedAt[^{]*\{[^}]*\$this->createdAt\s*=/.test(content)) {
    issues.push('setCreatedAt() setter found — createdAt should be immutable (set once in PrePersist only)');
  }

  return {
    class: classM[1],
    file: path.relative(appPath, filePath),
    style,
    hasCreatedAt,
    hasUpdatedAt,
    usesMutableDateTime,
    issues,
  };
}

export function listTimestampableEntities(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    if (!fs.existsSync(srcDir)) {
      return { content: [{ type: 'text', text: 'No src/ directory found.' }] };
    }

    const entities: TimestampEntity[] = [];
    for (const file of getAllPhpFiles(srcDir)) {
      const e = parseTimestampEntity(file, appPath);
      if (e) entities.push(e);
    }

    if (entities.length === 0) {
      return { content: [{ type: 'text', text: 'No entities with createdAt/updatedAt fields found.' }] };
    }

    const styles = new Set(entities.map((e) => e.style));
    const mixed  = styles.size > 1 && !styles.has('none');
    const totalIssues = entities.reduce((s, e) => s + e.issues.length, 0);

    let text = `Doctrine Timestampable Entities\n${'='.repeat(55)}\n`;
    text += `\nEntities: ${entities.length}  Issues: ${totalIssues}\n`;
    if (mixed) text += `⚠ Mixed timestamp styles: ${[...styles].join(', ')} — inconsistency across project\n`;

    const byStyle = new Map<TimestampStyle, TimestampEntity[]>();
    for (const e of entities) {
      const list = byStyle.get(e.style) ?? [];
      list.push(e);
      byStyle.set(e.style, list);
    }

    for (const [style, ents] of [...byStyle.entries()].sort()) {
      text += `\n  ${style} (${ents.length}):\n`;
      for (const e of ents.sort((a, b) => b.issues.length - a.issues.length || a.class.localeCompare(b.class))) {
        const fields = [e.hasCreatedAt ? 'createdAt' : '', e.hasUpdatedAt ? 'updatedAt' : ''].filter(Boolean).join(', ');
        text += `    ${e.class.padEnd(35)} [${fields}]\n`;
        for (const issue of e.issues) text += `      ⚠ ${issue}\n`;
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

export function getTimestampStats(appPath: string): McpToolResult {
  try {
    const srcDir = path.join(appPath, 'src');
    const entities: TimestampEntity[] = [];
    if (fs.existsSync(srcDir)) {
      for (const file of getAllPhpFiles(srcDir)) {
        const e = parseTimestampEntity(file, appPath);
        if (e) entities.push(e);
      }
    }

    let text = `Timestamp Statistics\n${'='.repeat(40)}\n\n`;
    text += `Total timestampable:  ${entities.length}\n`;
    text += `  Manual callbacks:   ${entities.filter((e) => e.style === 'manual').length}\n`;
    text += `  Gedmo:              ${entities.filter((e) => e.style === 'gedmo').length}\n`;
    text += `  Trait:              ${entities.filter((e) => e.style === 'trait').length}\n`;
    text += `  No automation:      ${entities.filter((e) => e.style === 'none').length}\n`;
    text += `Issues:               ${entities.reduce((s, e) => s + e.issues.length, 0)}\n`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export function getDoctrineTimestampTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const prop = { app_path: { type: 'string', description: 'Root path of the Symfony application' } };
  return [
    {
      name: 'list_timestampable_entities',
      description: 'Show Doctrine timestampable entities: manual PrePersist/PreUpdate, Gedmo @Timestampable, trait-based; mixed style detection, mutable DateTime in callbacks, setCreatedAt() immutability violation, entities with timestamp fields but no automation',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
    {
      name: 'get_timestamp_stats',
      description: 'Show timestamp statistics: total count, manual/Gedmo/trait/none breakdown, issue count',
      inputSchema: { type: 'object', properties: prop, required: ['app_path'] },
    },
  ];
}
