/**
 * Pure statement executor over an OO1 database (WEB-STORAGE §3 table). No worker, no OPFS: runs in the SQL worker and in Node tests.
 *
 *  - prepare / bind / step / finalize (always in `finally`), positional rows (`stmt.get([])`), column order and duplicate names preserved.
 *  - exactly ONE statement per call: the SQLite prepare TAIL decides (never semicolon splitting).
 *  - get -> first row or []; read statements stop after it, write/RETURNING statements are drained to DONE.
 *  - run -> [] except DML RETURNING, which returns its rows like the native plugin's `changes.values` normalization.
 */
import { WebStorageError } from '../web-storage/contract';
import { sanitizeMessage, type ProxyMethod } from './protocol';

/** Structural slice of the OO1 / capi surface this module needs (the real package types are far larger). */
export interface Oo1Stmt {
  readonly columnCount: number;
  readonly parameterCount: number;
  readonly pointer: number;
  bind(values: unknown[]): unknown;
  step(): boolean;
  get(target: unknown[]): unknown[];
  finalize(): unknown;
}

export interface Oo1Db {
  readonly pointer: number;
  prepare(sql: string): Oo1Stmt;
  exec(sql: string | Record<string, unknown>): unknown;
  selectValue(sql: string): unknown;
  close(): void;
  isOpen(): boolean;
}

export interface Sqlite3Api {
  version: { libVersion: string };
  oo1: { DB: new (filename: string, flags?: string) => unknown };
  capi: {
    sqlite3_get_autocommit(db: unknown): number;
    sqlite3_prepare_v3(db: unknown, sql: number, len: number, flags: number, ppStmt: number, pzTail: number): number;
    sqlite3_finalize(stmt: number): number;
    sqlite3_stmt_readonly(stmt: number): number;
    sqlite3_errmsg(db: unknown): string;
    sqlite3_js_db_export(db: unknown): Uint8Array;
    sqlite3_deserialize(db: unknown, schema: string, data: number, dbSize: number, bufSize: number, flags: number): number;
    SQLITE_DESERIALIZE_FREEONCLOSE: number;
    SQLITE_DESERIALIZE_RESIZEABLE: number;
  };
  wasm: {
    alloc(bytes: number): number;
    dealloc(ptr: number): void;
    allocFromTypedArray(data: Uint8Array): number;
    heap8u(): Uint8Array;
    poke8(ptr: number, value: number): void;
    pokePtr(ptr: number | number[], value: number): void;
    peekPtr(ptr: number): number;
    pstack: { pointer: number; alloc(bytes: number): number; restore(ptr: number): void };
    ptr: { size: number };
  };
}

const WRITE_RETURNING_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

export function sqlVerb(statement: string): string {
  const stripped = statement.replace(/^(?:\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
  return (/^[A-Za-z]+/.exec(stripped)?.[0] ?? '').toUpperCase();
}

/** Engine error -> sanitized WebStorageError. The message keeps SQLite's own constraint text (core's translateSqliteError reads it). */
export function mapSqliteError(error: unknown, commitState: 'not_started' | 'rolled_back' | 'unknown' = 'not_started'): WebStorageError {
  if (error instanceof WebStorageError) return error;
  const e = error as { name?: string; message?: string; resultCode?: number } | null;
  const message = sanitizeMessage(String(e?.message ?? 'SQLite error'));
  const name = e?.name ?? '';
  if (name === 'QuotaExceededError') return new WebStorageError('QUOTA', 'Storage quota exceeded', { commitState });
  const rc = typeof e?.resultCode === 'number' ? e.resultCode : undefined;
  const primary = rc === undefined ? undefined : rc & 0xff;
  if (primary === 13) return new WebStorageError('QUOTA', 'The storage is full', { sqliteCode: rc, commitState });
  if (primary === 10) return new WebStorageError('IO', 'Storage I/O error', { sqliteCode: rc, commitState: commitState === 'not_started' ? 'unknown' : commitState });
  if (name === 'WasmAllocError') return new WebStorageError('SQLITE', 'SQLite ran out of memory', { commitState });
  return new WebStorageError('SQLITE', message, { sqliteCode: rc, retryable: primary === 5 || primary === 6, commitState });
}

/** Throws unless `sql` is exactly one statement (+ whitespace/comments/semicolons). Uses the prepare tail; fast path when no `;` exists. */
function assertSingleStatement(sqlite3: Sqlite3Api, db: Oo1Db, sql: string): void {
  const withoutEnd = sql.replace(/(?:\s|;)+$/, '');
  if (!withoutEnd.includes(';')) return; // a statement without any ';' cannot have a trailing second statement
  const { capi, wasm } = sqlite3;
  const bytes = new TextEncoder().encode(sql);
  const pSql = wasm.allocFromTypedArray(new Uint8Array([...bytes, 0]));
  const stack = wasm.pstack.pointer;
  try {
    const pp = wasm.pstack.alloc(2 * wasm.ptr.size);
    const pTail = pp + wasm.ptr.size;
    wasm.pokePtr([pp, pTail], 0);
    const rc1 = capi.sqlite3_prepare_v3(db.pointer, pSql, bytes.length, 0, pp, pTail);
    if (rc1 !== 0) throw new WebStorageError('SQLITE', 'The statement could not be prepared', { sqliteCode: rc1 });
    const first = wasm.peekPtr(pp);
    const tail = wasm.peekPtr(pTail);
    if (first) capi.sqlite3_finalize(first);
    const remaining = pSql + bytes.length - tail;
    if (remaining > 0) {
      wasm.pokePtr([pp, pTail], 0);
      const rc2 = capi.sqlite3_prepare_v3(db.pointer, tail, remaining, 0, pp, pTail);
      const second = wasm.peekPtr(pp);
      if (second) capi.sqlite3_finalize(second);
      if (rc2 !== 0 || second) throw new WebStorageError('SQLITE', 'Only a single SQL statement is allowed per call');
    }
  } finally {
    wasm.pstack.restore(stack);
    wasm.dealloc(pSql);
  }
}

function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Execute one statement; returns positional rows per the method table. Throws WebStorageError (sanitized). */
export function runStatement(sqlite3: Sqlite3Api, db: Oo1Db, sql: string, params: readonly unknown[], method: ProxyMethod): unknown[] {
  let stmt: Oo1Stmt | undefined;
  try {
    assertSingleStatement(sqlite3, db, sql);
    stmt = db.prepare(sql);
    if (params.length > stmt.parameterCount) throw new WebStorageError('SQLITE', 'Too many bind values for this statement');
    if (params.length > 0) stmt.bind(params.map(normalizeParam));
    const columns = stmt.columnCount;
    const readonly = sqlite3.capi.sqlite3_stmt_readonly(stmt.pointer) !== 0;
    const verb = sqlVerb(sql);
    const returnsRows =
      columns > 0 && (method === 'all' || method === 'values' || method === 'get' || WRITE_RETURNING_VERBS.has(verb) || (verb === 'WITH' && /\bRETURNING\b/i.test(sql)));
    // `run` of a plain read (SELECT/PRAGMA) discards its output; only DML RETURNING keeps rows.
    const keepRows = method !== 'run' || WRITE_RETURNING_VERBS.has(verb) || (verb === 'WITH' && /\bRETURNING\b/i.test(sql));
    const rows: unknown[][] = [];
    while (stmt.step()) {
      if (returnsRows && keepRows) {
        if (method === 'get' && rows.length > 0) {
          if (readonly) break; // reads stop at the first row; writes drain to DONE below
          continue;
        }
        rows.push(stmt.get([]));
        if (method === 'get' && readonly) break;
      } else if (columns === 0) {
        continue;
      }
    }
    return method === 'get' ? (rows[0] ?? []) : rows;
  } catch (error) {
    throw mapSqliteError(error);
  } finally {
    stmt?.finalize();
  }
}

/** True while the connection is inside an explicit transaction (sqlite3_get_autocommit() === 0). */
export function inTransaction(sqlite3: Sqlite3Api, db: Oo1Db): boolean {
  return sqlite3.capi.sqlite3_get_autocommit(db) === 0;
}
