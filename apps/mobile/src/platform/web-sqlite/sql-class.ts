/**
 * ONE conservative SQL classifier shared by the client's write latch and the update-handoff write gate (Sol S6-05).
 * It only looks at the statement's leading shape (the worker rejects multi-statement input), and errs towards "write":
 *
 *  - `WITH ...` is a write whenever INSERT/UPDATE/DELETE/REPLACE appears anywhere outside literals/comments/quoted identifiers;
 *  - `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` are transaction control (an outermost SAVEPOINT opens a transaction, RELEASE may commit it);
 *  - `PRAGMA name = value` and `PRAGMA name(value)` assign (write), `PRAGMA name` reads. A fixed list of introspection pragmas takes an
 *    argument without assigning. `foreign_keys` is connection-local (never touches the file) and core issues it on every open/recover, so it
 *    is the one assignment treated as a read;
 *  - anything that is not provably a read (SELECT / VALUES / EXPLAIN / bare PRAGMA) is a write.
 */
export type SqlKind = 'read' | 'write' | 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback_to';

export interface SqlClass {
  kind: SqlKind;
  /** SAVEPOINT / RELEASE / ROLLBACK TO: the (unquoted, lower-cased) savepoint name when parseable. */
  name?: string;
}

const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/;
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'VACUUM', 'REINDEX', 'ANALYZE', 'ATTACH', 'DETACH']);
const READ_VERBS = new Set(['SELECT', 'VALUES', 'EXPLAIN', '']);
/** Pragmas that take an argument WITHOUT assigning anything. */
const ARGUMENT_READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check',
  'integrity_check', 'quick_check', 'database_list', 'collation_list', 'compile_options', 'function_list', 'module_list', 'pragma_list'
]);
/** Bare pragmas (no `=`/argument) that still act on the database. */
const ACTION_PRAGMAS = new Set(['optimize', 'wal_checkpoint', 'incremental_vacuum']);
/** Connection-local settings that never change the database file. */
const CONNECTION_LOCAL_PRAGMAS = new Set(['foreign_keys']);

/** Remove comments, string literals and quoted identifiers so keyword scans cannot be fooled (or tripped) by their contents. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]');
}

const unquote = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const t = raw.trim().replace(/^["'`[]/, '').replace(/["'`\]]$/, '');
  return t === '' ? undefined : t.toLowerCase();
};

export function classifySql(sql: string): SqlClass {
  const body = sql.replace(LEADING, '');
  const verb = (/^[A-Za-z]+/.exec(body)?.[0] ?? '').toUpperCase();
  const rest = body.slice(verb.length);
  switch (verb) {
    case 'BEGIN': return { kind: 'begin' };
    case 'COMMIT':
    case 'END': return { kind: 'commit' };
    case 'SAVEPOINT': return { kind: 'savepoint', name: unquote(/^\s+("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|'[^']*'|[^\s;]+)/.exec(rest)?.[1]) };
    case 'RELEASE': return { kind: 'release', name: unquote(/^\s+(?:SAVEPOINT\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|'[^']*'|[^\s;]+)/i.exec(rest)?.[1]) };
    case 'ROLLBACK': {
      const to = /^\s+(?:TRANSACTION\s+)?TO\s+(?:SAVEPOINT\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|'[^']*'|[^\s;]+)/i.exec(rest);
      return to ? { kind: 'rollback_to', name: unquote(to[1]) } : { kind: 'rollback' };
    }
    case 'WITH': {
      const scan = stripLiterals(body);
      return /\b(?:INSERT|UPDATE|DELETE)\b|\bREPLACE\b(?!\s*\()/i.test(scan) ? { kind: 'write' } : { kind: 'read' };
    }
    case 'PRAGMA': {
      const scan = stripLiterals(rest);
      const m = /^\s*(?:[A-Za-z_][\w]*\s*\.\s*)?([A-Za-z_][\w]*)\s*([=(])?/.exec(scan);
      const name = (m?.[1] ?? '').toLowerCase();
      if (m?.[2] === undefined) return ACTION_PRAGMAS.has(name) ? { kind: 'write' } : { kind: 'read' };
      if (m[2] === '(' && ARGUMENT_READ_PRAGMAS.has(name)) return { kind: 'read' };
      if (CONNECTION_LOCAL_PRAGMAS.has(name)) return { kind: 'read' };
      return { kind: 'write' };
    }
    default:
      if (WRITE_VERBS.has(verb)) return { kind: 'write' };
      return READ_VERBS.has(verb) ? { kind: 'read' } : { kind: 'write' };
  }
}

/** Kinds a latched / closed / read-only handle must refuse: new work that can change the database (ROLLBACK and ROLLBACK TO stay allowed). */
export function isMutationKind(kind: SqlKind): boolean {
  return kind === 'write' || kind === 'begin' || kind === 'commit' || kind === 'savepoint' || kind === 'release';
}
