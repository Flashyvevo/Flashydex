import { createImageCacheController } from './image-controller';
import { createInstallController } from './install';
import { createStorageProtection } from './protection';
import { createUpdateController } from './update';

/**
 * Stage F PWA surface. Lazily-created singletons would hide import-time side effects; these constructors only read
 * localStorage/navigator state (no listeners until check()/start()/register() are called).
 */
export const storageProtection = createStorageProtection();
export const installController = createInstallController();
export const updateController = createUpdateController();
export const imageCache = createImageCacheController();

export { IMAGE_CACHE_LIMITS, IMAGE_CACHE_NAME, IMAGE_ALLOWED_ORIGIN, SW_MESSAGES } from '../web-storage/contract';
export type {
  ImageCacheController,
  ImageCacheStats,
  InstallController,
  InstallState,
  PersistState,
  ProtectionSnapshot,
  StorageProtectionController,
  UpdateController,
  UpdateState
} from '../web-storage/contract';
export * from './copy';
export { createStorageProtection } from './protection';
export { createInstallController, detectPlatform } from './install';
export { createUpdateController } from './update';
export { createImageCacheController } from './image-controller';
