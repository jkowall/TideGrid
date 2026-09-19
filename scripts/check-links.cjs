#!/usr/bin/env node
'use strict';
// Checks relative links in tracked Markdown files, including heading anchors.
// Usage: node scripts/check-links.cjs   (exit 1 when any link is broken)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const files = execSync('git ls-files -c -o --exclude-standard -- "*.md"', { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter(f => fs.existsSync(path.join(root, f)));

const slug = text => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_~]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const headings = new Map();
const anchorsFor = file => {
  if (!headings.has(file)) {
    const seen = new Map(); const set = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line); if (!m) continue;
      const base = slug(m[1]); const n = seen.get(base) || 0; seen.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
    headings.set(file, set);
  }
  return headings.get(file);
};

const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
let broken = 0;
for (const rel of files) {
  const file = path.join(root, rel); const dir = path.dirname(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1]; if (target.startsWith('<')) target = target.slice(1, -1);
    if (/^(https?:|mailto:|tel:)/i.test(target)) continue;
    const [p, fragment] = target.split('#');
    const resolved = p ? path.resolve(dir, decodeURI(p)) : file;
    if (p && !fs.existsSync(resolved)) { console.log(`BROKEN  ${rel}: ${target}`); broken++; continue; }
    if (fragment && resolved.endsWith('.md') && !anchorsFor(resolved).has(fragment.toLowerCase())) {
      console.log(`ANCHOR  ${rel}: ${target}`); broken++;
    }
  }
}
console.log(broken ? `${broken} broken link(s)` : `All relative links resolve across ${files.length} Markdown files.`);
process.exit(broken ? 1 : 0);
