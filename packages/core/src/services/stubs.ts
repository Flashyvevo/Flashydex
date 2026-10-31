import type { BackupCreate, Input, RestoreCommit, RestoreDryRun, Empty } from '@flashydex/schemas';
import { UnsupportedCapabilityError } from '../errors';
import type { ServiceContext } from './context';

const unsupported = <T>(): Promise<T> => Promise.reject(new UnsupportedCapabilityError());

/** Not implemented yet: every method throws UNSUPPORTED_CAPABILITY ("Not implemented yet"); no placeholder data. */

export type BackupCapabilities = { fdxCreate: boolean; fdxRestore: boolean; optionalCatalogPayload: boolean; reason: string | null };

export class BackupServiceStub {
  constructor(_ctx: ServiceContext) { void _ctx; }
  async capabilities(_input: Input<typeof Empty> = {}): Promise<BackupCapabilities> {
    return { fdxCreate: false, fdxRestore: false, optionalCatalogPayload: false, reason: 'Backup files arrive in a later build' };
  }
  create(_input: Input<typeof BackupCreate>): Promise<never> { return unsupported(); }
  previewRestore(_input: Input<typeof RestoreDryRun>): Promise<never> { return unsupported(); }
  restore(_input: Input<typeof RestoreCommit>): Promise<never> { return unsupported(); }
}
