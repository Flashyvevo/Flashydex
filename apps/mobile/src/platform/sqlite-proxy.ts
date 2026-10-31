/**
 * Drizzle `sqlite-proxy` callback over a @capacitor-community/sqlite connection.
 *
 * Routing is by SQL verb, not only by Drizzle's `method` (capacitor-plugins.md):
 *  - DDL / PRAGMA / transaction control  -> connection.execute (no bind values)
 *  - bound DML                            -> connection.run
 *  - SELECT / WITH / read PRAGMA          -> connection.query
 *  - DML ... RETURNING                    -> connection.run(returnMode 'all'); rows come from `changes.values`
 *
 * Core must NOT depend on RETURNING (DATA-MODEL); the mapping exists so a stray `.returning()` does
 * not silently yield zero rows.
 *
 * Result shape: Drizzle's query builder maps rows positionally, so every read returns rows as
 * arrays of column values (plugin returns objects; iOS prepends a `{ios_columns: [...]}` pseudo-row).
 */

/** Minimal slice of SQLiteDBConnection the adapter needs (also implemented by test fakes). */
export interface ProxyConnection {
  execute(statements: string, transaction?: boolean): Promise<{ changes?: { changes?: number; lastId?: number; values?: unknown[] } }>;
  run(
    statement: string,
    values?: unknown[],
    transaction?: boolean,
    returnMode?: string
  ): Promise<{ changes?: { changes?: number; lastId?: number; values?: unknown[] } }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
}

export type ProxyMethod = 'run' | 'all' | 'values' | 'get';
export type ProxyCallback = (sql: string, params: unknown[], method: ProxyMethod) => Promise<{ rows: unknown[] }>;

const READ_VERBS = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);
const EXECUTE_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'PRAGMA', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'VACUUM', 'ATTACH', 'DETACH', 'REINDEX', 'ANALYZE']);

export function sqlVerb(statement: string): string {
  const stripped = statement.replace(/^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  return (/^[A-Za-z]+/.exec(stripped)?.[0] ?? '').toUpperCase();
}

function hasReturning(statement: string): boolean {
  return /\bRETURNING\b/i.test(statement);
}

/** Convert plugin rows (objects, possibly with the iOS `ios_columns` header row) to positional arrays. */
export function normalizeRows(values: readonly unknown[] | undefined): unknown[][] {
  if (!values?.length) return [];
  let columns: string[] | undefined;
  let rows: readonly unknown[] = values;
  const first = values[0];
  if (first && typeof first === 'object' && !Array.isArray(first) && 'ios_columns' in first) {
    columns = (first as { ios_columns: string[] }).ios_columns;
    rows = values.slice(1);
  }
  return rows.map((row) => {
    if (Array.isArray(row)) return row;
    const record = row as Record<string, unknown>;
    return columns ? columns.map((name) => record[name]) : Object.values(record);
  });
}

/**
 * The plugin (web/jeep and Android) returns rows as OBJECTS keyed by column name, so two projected columns with the same
 * name (`c.name`, `s.name`) collapse into one key and every later column shifts left (C1). To make EVERY query safe we
 * rewrite the outermost projection of a plain SELECT so each item gets a unique alias (`"__c0"`, `"__c1"`, ...) and read
 * the object back by those aliases in projection order. Statements the splitter cannot handle with certainty
 * (WITH / compound / `*` projections) are returned unchanged and fall back to `Object.values`.
 */
export interface AliasedSelect {
  sql: string;
  keys: string[];
}

const ALIAS_PREFIX = '__c';
const COMPOUND = ['UNION', 'INTERSECT', 'EXCEPT'];

function keywordAt(sql: string, i: number, keyword: string): boolean {
  if (sql.slice(i, i + keyword.length).toUpperCase() !== keyword) return false;
  const before = sql[i - 1];
  const after = sql[i + keyword.length];
  return !(before && /[A-Za-z0-9_]/.test(before)) && !(after && /[A-Za-z0-9_]/.test(after));
}

/** Visit every character at paren depth 0 outside quotes; the visitor returns true to stop. */
function scanTopLevel(sql: string, from: number, visit: (index: number) => boolean | void): void {
  let depth = 0;
  for (let i = from; i < sql.length; i += 1) {
    const ch = sql[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2; // doubled-quote escape
          else break;
        } else i += 1;
      }
      continue;
    }
    if (ch === '[') {
      const end = sql.indexOf(']', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && visit(i) === true) return;
  }
}

export function aliasProjection(statement: string): AliasedSelect | null {
  if (sqlVerb(statement) !== 'SELECT') return null;
  const lead = /^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(statement)?.[0].length ?? 0;
  let start = lead + 'SELECT'.length;
  let prefix = statement.slice(0, start);
  const modifier = /^\s+(?:DISTINCT|ALL)\b/i.exec(statement.slice(start));
  if (modifier) {
    prefix += modifier[0];
    start += modifier[0].length;
  }
  let fromAt = -1;
  let compound = false;
  const commas: number[] = [];
  scanTopLevel(statement, start, (i) => {
    if (COMPOUND.some((k) => keywordAt(statement, i, k))) {
      compound = true;
      return true;
    }
    if (fromAt === -1) {
      if (statement[i] === ',') commas.push(i);
      else if (keywordAt(statement, i, 'FROM')) fromAt = i;
    }
    return undefined;
  });
  if (compound) return null;
  const end = fromAt === -1 ? statement.length : fromAt;
  const bounds = [start - 1, ...commas, end];
  const items: string[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) items.push(statement.slice((bounds[i] as number) + 1, bounds[i + 1] as number).trim());
  if (items.some((item) => item === '' || item === '*' || /\.\*$/.test(item))) return null;
  // Explicit aliases (`expr AS name`) stay as written: ORDER BY / GROUP BY may reference them. Only unaliased items (and
  // colliding aliases) get a generated unique alias.
  const seen = new Set<string>();
  const keys: string[] = [];
  const projected = items.map((item, index) => {
    const alias = /^([\s\S]*?)\s+AS\s+(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_]*))\s*$/i.exec(item);
    const name = alias ? (alias[2] ?? alias[3] ?? alias[4] ?? alias[5] ?? '') : '';
    if (alias && name !== '' && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      keys.push(name);
      return item;
    }
    const key = `${ALIAS_PREFIX}${index}`;
    seen.add(key.toLowerCase());
    keys.push(key);
    return `(${alias ? (alias[1] as string) : item}) AS "${key}"`;
  });
  return { sql: `${prefix} ${projected.join(', ')} ${statement.slice(end)}`, keys };
}

/** Rows keyed by our unique aliases -> positional arrays; anything unexpected falls back to `normalizeRows`. */
function rowsFromAliased(values: readonly unknown[] | undefined, keys: readonly string[]): unknown[][] {
  if (!values?.length) return [];
  const first = values[0];
  const usable = first !== null && typeof first === 'object' && !Array.isArray(first) && keys.every((key) => key in (first as object));
  if (!usable) return normalizeRows(values);
  return values.map((row) => keys.map((key) => (row as Record<string, unknown>)[key]));
}

export function createProxyCallback(connection: ProxyConnection): ProxyCallback {
  let inTransaction = false;

  return async (statement, params, method) => {
    const verb = sqlVerb(statement);

    if (EXECUTE_VERBS.has(verb)) {
      // PRAGMA reads (e.g. `PRAGMA user_version`) must come back as rows.
      if (verb === 'PRAGMA' && method !== 'run' && !/=/.test(statement)) {
        const result = await connection.query(statement, params);
        return { rows: normalizeRows(result.values) };
      }
      if (params.length > 0) throw new Error(`sqlite adapter: ${verb} cannot take bind values`);
      await connection.execute(statement, false);
      if (verb === 'BEGIN') inTransaction = true;
      if (verb === 'COMMIT' || verb === 'END' || verb === 'ROLLBACK') inTransaction = false;
      return { rows: [] };
    }

    if (READ_VERBS.has(verb) && !hasReturning(statement)) {
      const aliased = aliasProjection(statement);
      const result = await connection.query(aliased ? aliased.sql : statement, params);
      const rows = aliased ? rowsFromAliased(result.values, aliased.keys) : normalizeRows(result.values);
      return { rows: method === 'get' ? (rows[0] ?? []) : rows } as { rows: unknown[] };
    }

    // INSERT / UPDATE / DELETE / REPLACE
    const returning = hasReturning(statement);
    const changes = await connection.run(statement, params, !inTransaction, returning ? 'all' : undefined);
    if (!returning) return { rows: [] };
    const rows = normalizeRows(changes.changes?.values);
    return { rows: method === 'get' ? (rows[0] ?? []) : rows } as { rows: unknown[] };
  };
}
