import { Capacitor } from '@capacitor/core';

export type FlashyDexPlatform = 'ios' | 'android' | 'web';

export function getPlatform(): FlashyDexPlatform {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

export function applyPlatformClass(): FlashyDexPlatform {
  const platform = getPlatform();
  document.documentElement.classList.remove('platform-ios', 'platform-android', 'platform-web');
  document.documentElement.classList.add(`platform-${platform}`);
  return platform;
}
