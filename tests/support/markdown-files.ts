import { readdirSync } from 'node:fs';
import path from 'node:path';

// Every markdown file under a docs folder, without the VitePress `public` and `.vitepress` folders.
export function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return ['public', '.vitepress'].includes(e.name) ? [] : markdownFiles(f);
    return f.endsWith('.md') ? [f] : [];
  });
}
