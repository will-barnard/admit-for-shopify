#!/usr/bin/env node
/**
 * Static check: every query touching a tenant-owned table must reference shop_id.
 *
 * A missing `WHERE shop_id = $n` is a cross-tenant data leak, and it fails
 * silently - the query returns another merchant's rows rather than erroring.
 * This is deliberately a dumb textual check: it extracts each db.query(...)
 * call and asserts that a statement naming a tenant table also names shop_id.
 *
 * migrations/ is excluded: schema work runs once and legitimately spans tenants.
 *
 * Run: npm run check:tenancy
 *
 * If a query is genuinely shop-agnostic (a system-level operation, or one that
 * is scoped via a join to an already-scoped table), add an eslint-style comment
 * on the line above:  // tenancy-ok: <reason>
 */

const fs = require('fs');
const path = require('path');

const TENANT_TABLES = ['tickets', 'events', 'ticket_scans', 'settings', 'webhook_logs', 'email_send_log'];
const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : walk(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

// Pull out balanced db.query( ... ) / client.query( ... ) calls.
function extractQueryCalls(src) {
  const calls = [];
  const re = /\b(?:db|client|pool)\.query\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    let quote = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      const prev = src[i - 1];
      if (quote) {
        if (c === quote && prev !== '\\') quote = null;
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
      } else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    calls.push({ text: src.slice(m.index, i), index: m.index });
  }
  return calls;
}

const problems = [];
const files = walk(SRC).sort();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  for (const call of extractQueryCalls(src)) {
    const line = src.slice(0, call.index).split('\n').length;
    const preceding = (lines[line - 2] || '') + (lines[line - 1] || '');
    if (/tenancy-ok:/.test(preceding)) continue;

    const touched = TENANT_TABLES.filter((t) =>
      new RegExp(`\\b(FROM|INTO|UPDATE|JOIN|DELETE FROM)\\s+${t}\\b`, 'i').test(call.text)
    );
    if (touched.length === 0) continue;
    if (/shop_id/.test(call.text)) continue;

    problems.push({
      file: path.relative(path.join(__dirname, '..'), file),
      line,
      tables: touched.join(', '),
      snippet: call.text.replace(/\s+/g, ' ').slice(0, 110),
    });
  }
}

if (problems.length === 0) {
  console.log(`tenancy check: OK - every tenant-table query in ${files.length} files references shop_id`);
  process.exit(0);
}

console.error(`tenancy check: ${problems.length} unscoped quer${problems.length === 1 ? 'y' : 'ies'}\n`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  [${p.tables}]`);
  console.error(`    ${p.snippet}\n`);
}
process.exit(1);
