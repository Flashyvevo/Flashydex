/**
 * Typed seam to Sonnet A (web-sqlite) + B (prepareStorage, role store). One import point for the shell.
 */
import { Capacitor } from '@capacitor/core';
import type { LanguageRoles, WebSqliteClient } from '../platform/web-storage/contract';
import type { CatalogInstallPort } from '@flashydex/core';
import { prepareStorage } from '../platform/app-database';
import { getWebSqliteClient } from '../platform/web-sqlite';
import { getRoleStore } from '../platform/web-storage/role-store';

export { prepareStorage };

/** The singleton SQL worker client (web only; null on native). */
export function webSqliteClient(): WebSqliteClient | null {
  return Capacitor.getPlatform() === 'web' ? getWebSqliteClient() : null;
}

/** Active catalog refs per language (pool paths: no personal data), or null off web. */
export async function catalogRoles(): Promise<Record<'en' | 'ja', LanguageRoles> | null> {
  if (Capacitor.getPlatform() !== 'web') return null;
  return (await getRoleStore().load()).languages;
}

let lastMetrics: Record<string, unknown> | null = null;

/** Last full-pack install metrics (from the installer's stage result), or null when none was run in this page. */
export function lastPackMetrics(): Record<string, unknown> | null {
  return lastMetrics;
}

/** Wraps the install port so the device metrics returned by `stage()` stay observable for Diagnostics (core persists them too). */
export function withMetricsRecording(port: CatalogInstallPort): CatalogInstallPort {
  const wrapped = Object.create(port) as CatalogInstallPort;
  wrapped.stage = async (entry, options) => {
    const result = await port.stage(entry, options);
    const m = result.metrics;
    if (m && typeof m === 'object') lastMetrics = m as Record<string, unknown>;
    return result;
  };
  return wrapped;
}
