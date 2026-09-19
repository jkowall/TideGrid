'use strict';
// Source lint for the published prototype. The production CSP forbids inline styles, inline scripts, on*= handlers and
// javascript: URLs; the operator prototype must avoid out-of-scope vocabulary; index.html must not carry ?v= query strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const runtimeScripts = ['app.js', 'domain.js', 'waiver.js', 'operator.js', 'weather.js', 'trip-cards.js'];
const sources = ['index.html', ...runtimeScripts];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lines = (text, pattern) => text.split('\n').map((line, index) => ({ line: index + 1, text: line })).filter(item => pattern.test(item.text));

test('no inline style, inline script, on*= handler or javascript: URL reaches the published markup', () => {
  const forbidden = /\sstyle=|<script(?!\ssrc)|\son[a-z]+=|javascript:/i;
  for (const file of sources) {
    const hits = lines(read(file), forbidden);
    assert.deepEqual(hits, [], `${file} would break under the CSP: ${JSON.stringify(hits)}`);
  }
});

test('stylesheets load nothing from other origins, data URLs, imports or web fonts', () => {
  const forbidden = /url\(\s*["']?(?:data:|https?:|\/\/)|@import|@font-face/i;
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.css'))) {
    const hits = lines(read(file), forbidden);
    assert.deepEqual(hits, [], `${file} would break under the CSP: ${JSON.stringify(hits)}`);
  }
});

test('index.html loads every runtime script without cache-busting query strings and only from this origin', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /\?v=/);
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...scripts].sort(), [...runtimeScripts].sort());
  const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(match => match[1]);
  assert.ok(styles.length > 0);
  for (const href of [...scripts, ...styles]) {
    assert.doesNotMatch(href, /^(https?:)?\/\//, href);
    assert.ok(fs.existsSync(path.join(root, href)), `${href} is missing`);
  }
});

test('check-in, manifest and boarding appear only in the roster footnote that rules them out', () => {
  const vocabulary = /\bcheck-?in\b|\bmanifest\b|\bboarding\b/i;
  const footnote = /<p class="op-footnote">This roster is a booking-management view\. It is not a manifest, check-in record, or boarding record\.<\/p>/;
  const operator = read('operator.js');
  assert.match(operator, footnote);
  for (const file of sources) {
    const text = file === 'operator.js' ? operator.replace(footnote, '') : read(file);
    const hits = lines(text, vocabulary);
    assert.deepEqual(hits, [], `${file} uses out-of-scope vocabulary: ${JSON.stringify(hits)}`);
  }
});

test('the published allowlist covers exactly the runtime assets the page loads', () => {
  const allow = fs.readFileSync(path.join(root, '.assetsignore'), 'utf8').split('\n').filter(line => line.startsWith('!')).map(line => line.slice(1).trim());
  const html = read('index.html');
  const loaded = ['index.html', ...[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1])];
  assert.deepEqual([...new Set(loaded)].sort(), [...allow].sort());
});
