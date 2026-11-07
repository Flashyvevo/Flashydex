/**
 * ONE conservative SQL classifier shared by the client's write latch and the update-handoff write gate (Sol S6-05, S7-02).
 * It lexes the statement ONCE (strings, quoted identifiers and comments are tokens, so comment markers inside a string never hide
 * anything and keywords inside a literal never count) and then only looks at the leading shape (the worker rejects multi-statement
 * input). It errs towards "write":
 *
 *  - leading `;` / whitespace / comments are skipped before the verb (SQLite accepts empty statements);
 *  - `WITH ...` is a write whenever INSERT/UPDATE/DELETE/REPLACE appears as a bare word token;
 *  - `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` are transaction control (an outermost SAVEPOINT opens a transaction, RELEASE may commit it);
 *  - `PRAGMA [schema.]name = value` and `PRAGMA name(value)` assign (write), `PRAGMA name` reads; the name may be bare, "quoted",
 *    `quoted`, [quoted] or 'quoted'. A fixed list of introspection pragmas takes an argument without assigning. `foreign_keys` is
 *    connection-local (never touches the file) and core issues it on every open/recover, so it is the one assignment treated as a read
 *    (INTENTIONAL recovery policy, quoted or not);
 *  - anything that is not provably a read (SELECT / VALUES / EXPLAIN / bare PRAGMA / WITH without DML / nothing at all) is a write, and
 *    so is any input the lexer cannot tokenize (unterminated string or quoted identifier).
 */
export type SqlKind = 'read' | 'write' | 'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollback_to';

export interface SqlClass {
  kind: SqlKind;
  /** SAVEPOINT / RELEASE / ROLLBACK TO: the (unquoted, lower-cased) savepoint name when parseable. */
  name?: string;
}

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'VACUUM', 'REINDEX', 'ANALYZE', 'ATTACH', 'DETACH']);
const READ_VERBS = new Set(['SELECT', 'VALUES', 'EXPLAIN']);
/** Pragmas that take an argument WITHOUT assigning anything. */
const ARGUMENT_READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check',
  'integrity_check', 'quick_check', 'database_list', 'collation_list', 'compile_options', 'function_list', 'module_list', 'pragma_list'
]);
/** Bare pragmas (no `=`/argument) that still act on the database. */
const ACTION_PRAGMAS = new Set(['optimize', 'wal_checkpoint', 'incremental_vacuum']);
/** Connection-local settings that never change the database file. */
const CONNECTION_LOCAL_PRAGMAS = new Set(['foreign_keys']);

type Token = { t: 'word' | 'string' | 'ident' | 'num' | 'punct'; v: string };

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c > '\u007f';
const isWordPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c > '\u007f';

/** Reads a quoted run starting at `i` (the opening quote); a doubled closing quote is an escape. Returns the text and the next index, or null when unterminated. */
function readQuoted(sql: string, i: number, close: string, doubled: boolean): { text: string; next: number } | null {
  let out = '';
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (doubled && sql[j + 1] === close) {
        out += close;
        j += 2;
        continue;
      }
      return { text: out, next: j + 1 };
    }
    out += sql[j];
    j += 1;
  }
  return null;
}

/** One pass over the statement. `null` = not confidently tokenizable (unterminated string / identifier). Comments and whitespace produce no token. */
function tokenize(sql: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2; // an unterminated block comment runs to the end of the input, as in SQLite
    } else if (c === "'" || c === '"' || c === '`') {
      const q = readQuoted(sql, i, c, true);
      if (!q) return null;
      tokens.push({ t: c === "'" ? 'string' : 'ident', v: q.text });
      i = q.next;
    } else if (c === '[') {
      const q = readQuoted(sql, i, ']', false);
      if (!q) return null;
      tokens.push({ t: 'ident', v: q.text });
      i = q.next;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < sql.length && isWordPart(sql[j] as string)) j += 1;
      tokens.push({ t: 'word', v: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j] as string)) j += 1;
      tokens.push({ t: 'num', v: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ t: 'punct', v: c });
      i += 1;
    }
  }
  return tokens;
}

const WRITE: SqlClass = { kind: 'write' };
const nameOf = (token: Token | undefined): string | undefined =>
  token && (token.t === 'word' || token.t === 'ident' || token.t === 'string') && token.v !== '' ? token.v.toLowerCase() : undefined;
const isWord = (token: Token | undefined, value: string): boolean => token?.t === 'word' && token.v.toUpperCase() === value;
const isPunct = (token: Token | undefined, value: string): boolean => token?.t === 'punct' && token.v === value;

export function classifySql(sql: string): SqlClass {
  const lexed = tokenize(sql);
  if (!lexed) return WRITE;
  let at = 0;
  while (isPunct(lexed[at], ';')) at += 1; // leading empty statements
  const tokens = lexed.slice(at);
  if (tokens.length === 0) return { kind: 'read' }; // nothing executes
  const first = tokens[0] as Token;
  if (first.t !== 'word') return WRITE;
  const verb = first.v.toUpperCase();
  switch (verb) {
    case 'BEGIN': return { kind: 'begin' };
    case 'COMMIT':
    case 'END': return { kind: 'commit' };
    case 'SAVEPOINT': {
      const name = nameOf(tokens[1]);
      return name === undefined ? WRITE : { kind: 'savepoint', name };
    }
    case 'RELEASE': {
      const name = nameOf(isWord(tokens[1], 'SAVEPOINT') ? tokens[2] : tokens[1]);
      return name === undefined ? WRITE : { kind: 'release', name };
    }
    case 'ROLLBACK': {
      let k = 1;
      if (isWord(tokens[k], 'TRANSACTION')) k += 1;
      if (!isWord(tokens[k], 'TO')) return { kind: 'rollback' };
      k += 1;
      if (isWord(tokens[k], 'SAVEPOINT')) k += 1;
      const name = nameOf(tokens[k]);
      return name === undefined ? WRITE : { kind: 'rollback_to', name };
    }
    case 'WITH': {
      for (let k = 1; k < tokens.length; k += 1) {
        const token = tokens[k] as Token;
        if (token.t !== 'word') continue;
        const word = token.v.toUpperCase();
        if (word === 'INSERT' || word === 'UPDATE' || word === 'DELETE') return WRITE;
        if (word === 'REPLACE' && !isPunct(tokens[k + 1], '(')) return WRITE; // replace() the function is fine
      }
      return { kind: 'read' };
    }
    case 'PRAGMA': {
      let k = 1;
      let name = nameOf(tokens[k]);
      if (isPunct(tokens[k + 1], '.')) {
        k += 2; // schema qualifier
        name = nameOf(tokens[k]);
      }
      if (name === undefined) return WRITE;
      const next = tokens[k + 1];
      if (next === undefined || (isPunct(next, ';') && tokens.length === k + 2)) return ACTION_PRAGMAS.has(name) ? WRITE : { kind: 'read' };
      const op = next.t === 'punct' ? next.v : undefined;
      if (op !== '=' && op !== '(') return WRITE; // unexpected shape
      if (op === '(' && ARGUMENT_READ_PRAGMAS.has(name)) return { kind: 'read' };
      if (CONNECTION_LOCAL_PRAGMAS.has(name)) return { kind: 'read' };
      return WRITE;
    }
    default:
      if (WRITE_VERBS.has(verb)) return WRITE;
      return READ_VERBS.has(verb) ? { kind: 'read' } : WRITE;
  }
}

/** Kinds a latched / closed / read-only handle must refuse: new work that can change the database (ROLLBACK and ROLLBACK TO stay allowed). */
export function isMutationKind(kind: SqlKind): boolean {
  return kind === 'write' || kind === 'begin' || kind === 'commit' || kind === 'savepoint' || kind === 'release';
}
