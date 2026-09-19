import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const codePattern = /^[A-Z][A-Z_0-9]+$/;

// Inventory of the current error protocol, not a proof that a recovery command can execute.
// Keep unresolved expressions visible: silently ignoring them would defeat the coverage check.
export function inventorySources(sources) {
  const sites = [], dynamic = [];
  let invariants = 0;
  for (const { file, text } of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const bindings = new Map();
    const invariantNames = new Set(['invariant']);
    const errorNames = new Set(['PipelineError']);
    const namespaces = new Set();
    const collect = n => {
      if (ts.isImportSpecifier(n)) {
        const original = (n.propertyName ?? n.name).text;
        if (original === 'invariant') invariantNames.add(n.name.text);
        if (original === 'PipelineError') errorNames.add(n.name.text);
      }
      if (ts.isNamespaceImport(n)) namespaces.add(n.name.text);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const values = bindings.get(n.name.text) ?? [];
        values.push(n.initializer); bindings.set(n.name.text, values);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const named = (n, names) => ts.isIdentifier(n) ? names.has(n.text) :
      ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && namespaces.has(n.expression.text) && names.has(n.name.text);
    const values = (expr, site, seen = new Set()) => {
      if (ts.isStringLiteralLike(expr)) {
        if (codePattern.test(expr.text)) sites.push({ ...site, code: expr.text });
        else dynamic.push({ ...site, expression: expr.getText(sf) });
      } else if (ts.isConditionalExpression(expr)) {
        values(expr.whenTrue, site, seen); values(expr.whenFalse, site, seen);
      } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
        values(expr.expression, site, seen);
      } else if (ts.isIdentifier(expr) && bindings.get(expr.text)?.length === 1 && !seen.has(expr.text)) {
        values(bindings.get(expr.text)[0], site, new Set([...seen, expr.text]));
      } else {
        dynamic.push({ ...site, expression: expr.getText(sf).replace(/\s+/g, ' ') });
      }
    };
    const visit = n => {
      let expr, kind;
      if (ts.isCallExpression(n) && named(n.expression, invariantNames)) {
        invariants++; expr = n.arguments[1]; kind = 'invariant';
      } else if (ts.isNewExpression(n) && named(n.expression, errorNames)) {
        expr = n.arguments?.[0]; kind = 'error';
      } else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
          (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'code') {
        expr = ts.isPropertyAssignment(n) ? n.initializer : n.name; kind = 'code-field';
        // JSON-RPC uses a different, numeric error protocol.
        if (ts.isNumericLiteral(expr) || ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) expr = undefined;
      }
      if (expr) values(expr, { file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, kind });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { invariants, codes: [...new Set(sites.map(s => s.code))].sort(), sites, dynamic };
}

export function sourceInventory() {
  return inventorySources(readdirSync(resolve(root, 'src'), { recursive: true })
    .filter(file => file.endsWith('.ts')).sort()
    .map(file => ({ file: `src/${file}`, text: readFileSync(resolve(root, 'src', file), 'utf8') })));
}

export function coverageErrors(inventory, catalog) {
  const errors = [], declared = new Set();
  for (const group of catalog.groups) {
    for (const field of ['id', 'operatorAction', 'currentGuidance', 'gap']) {
      if (typeof group[field] !== 'string' || !group[field].trim()) errors.push(`Missing ${field}: ${group.id}`);
    }
    if (!['yes', 'conditional', 'maintainer'].includes(group.operator)) errors.push(`Invalid operator: ${group.id}`);
    for (const code of group.codes) {
      if (declared.has(code)) errors.push(`Duplicate code: ${code}`);
      declared.add(code);
      if (!inventory.codes.includes(code)) errors.push(`Obsolete code: ${code}`);
    }
  }
  for (const code of inventory.codes) if (!declared.has(code)) errors.push(`Undeclared recovery disposition: ${code}`);
  const key = x => `${x.file}:${x.kind}:${x.expression}`;
  const actual = new Map();
  for (const item of inventory.dynamic) actual.set(key(item), (actual.get(key(item)) ?? 0) + 1);
  for (const item of catalog.forwarding) {
    if (!item.reason?.trim() || actual.get(key(item)) !== item.count) errors.push(`Changed dynamic code expression: ${key(item)}`);
    actual.delete(key(item));
  }
  for (const entry of actual.keys()) errors.push(`Unreviewed dynamic code expression: ${entry}`);
  return errors;
}

export function audit() {
  const inventory = sourceInventory();
  const catalog = JSON.parse(readFileSync(resolve(root, 'scripts/error-recovery.json'), 'utf8'));
  return { inventory, catalog, errors: coverageErrors(inventory, catalog) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { inventory, catalog, errors } = audit();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ invariants: inventory.invariants, distinctCodes: inventory.codes.length,
      codes: inventory.codes.map(code => ({ code, ...Object.fromEntries(Object.entries(catalog.groups.find(g => g.codes.includes(code)) ?? {}).filter(([k]) => k !== 'codes')),
        sites: inventory.sites.filter(s => s.code === code) })), forwarding: inventory.dynamic, errors }, null, 2));
  } else {
    console.log(`${inventory.invariants} invariants; ${inventory.codes.length} distinct emitted codes; ${inventory.sites.length} literal occurrences.`);
    for (const group of catalog.groups) console.log(`${group.id} (${group.codes.length}): ${group.codes.join(', ')}`);
    console.log(errors.length ? errors.join('\n') : 'All emitted codes have an audited disposition. This is not a runtime recovery guarantee.');
  }
  process.exitCode = errors.length ? 1 : 0;
}
