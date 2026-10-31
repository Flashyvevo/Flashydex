import { timed } from '../perf';
import { migrate } from '../db/migrator';
import { USER_MIGRATIONS } from '../db/migrations.generated';
import { DatabaseSet, type CatalogSource } from '../db/database-set';
import { Db, type SqlDriver } from '../db/sql';
import type { Environment } from '../platform/platform';
import { CatalogRepo } from './catalog';
import { CatalogInstallService, type CatalogConfig, type CatalogInstallPort } from './catalog-install';
import { CollectionRepo } from './collection';
import type { ServiceContext } from './context';
import { PortfolioService } from './portfolio';
import { SettingsRepo } from './settings';
import { BackupService } from '../backup/service';
import { StorageService } from './storage';
import { SyncService, type SyncOptions } from './sync';
import { TransferService } from '../transfer/service';
import type { Platform } from '../platform/platform';

export interface Services {
  databases: DatabaseSet;
  settings: SettingsRepo;
  catalog: CatalogRepo;
  collection: CollectionRepo;
  portfolio: PortfolioService;
  install: CatalogInstallService;
  transfer: TransferService;
  sync: SyncService;
  backup: BackupService;
  storage: StorageService;
}

/** Open the user DB: FK ON verified, user chain migrated (idempotent). Throws StorageError MIGRATION_FAILED and leaves data untouched on drift. */
export async function openUserDb(driver: SqlDriver, env: Environment): Promise<Db> {
  const db = new Db(driver);
  await db.initialize();
  await timed('fdx:migrate-user', () => migrate(db, USER_MIGRATIONS, env.clock.now));
  return db;
}

export interface CreateServicesOptions {
  userDriver: SqlDriver;
  catalogSource: CatalogSource;
  env: Environment;
  installPort: CatalogInstallPort;
  platform: Platform;
  appVersion?: string;
  sync?: SyncOptions;
  /** D46: manifest source + trusted origins (configuration from the app; core does all semantic validation). */
  catalog?: CatalogConfig;
  /** D42: the page does not own the writer lock -> every personal write is refused with INSTANCE_LOCK. */
  userWriteBlock?: { reason: 'instance_lock'; message: string };
}

/** Compose every service. Runs boot recovery of interrupted catalog jobs before any catalog is opened. */
export async function createServices(options: CreateServicesOptions): Promise<Services> {
  const user = await openUserDb(options.userDriver, options.env);
  if (options.userWriteBlock) user.setInstanceLock({ message: options.userWriteBlock.message });
  const databases = new DatabaseSet(user, options.catalogSource);
  const ctx: ServiceContext = { databases, env: options.env };
  const install = new CatalogInstallService(ctx, options.installPort, options.catalog);
  if (!options.userWriteBlock) await timed('fdx:recover-install', () => install.recover());
  const sync = new SyncService(ctx, options.platform, options.sync);
  if (!options.userWriteBlock) await timed('fdx:recover-sync', () => sync.recover());
  return {
    databases,
    settings: new SettingsRepo(ctx),
    catalog: new CatalogRepo(ctx),
    collection: new CollectionRepo(ctx),
    portfolio: new PortfolioService(ctx),
    install,
    transfer: new TransferService(ctx, options.platform, options.appVersion),
    sync,
    backup: new BackupService(ctx, options.platform, options.appVersion),
    storage: new StorageService(databases)
  };
}

export { SyncService };
export type { SyncCapabilities, SyncOptions } from './sync';
export { CatalogRepo, CatalogInstallService, CollectionRepo, PortfolioService, SettingsRepo };
export type { CatalogInstallPort, CatalogConfig };
export { BackupService, StorageService };
export type { StorageStatus } from './storage';
