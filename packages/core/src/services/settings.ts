import { Empty, SettingsPatch, type AppSettings, type Input } from '@flashydex/schemas';
import { ValidationError } from '../errors';
import { parse, readSettings, type ServiceContext } from './context';

export class SettingsRepo {
  constructor(private readonly ctx: ServiceContext) {}

  async get(input: Input<typeof Empty> = {}): Promise<AppSettings> {
    parse(Empty, input);
    return this.ctx.databases.user.read((q) => readSettings(q));
  }

  /** Settings never touch collectionRevision (DATA-MODEL AppSettings). */
  async update(input: Input<typeof SettingsPatch>): Promise<AppSettings> {
    const patch = parse(SettingsPatch, input);
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new ValidationError('At least one setting is required', [{ path: '', code: 'too_small', message: 'Empty patch' }]);
    const now = this.ctx.env.clock.now();
    return this.ctx.databases.user.transaction(async (tx) => {
      const current = await readSettings(tx);
      const languages = patch.languages ?? current.languages;
      if (new Set(languages).size !== languages.length) throw new ValidationError('Languages must be distinct', [{ path: 'languages', code: 'custom', message: 'Duplicate language' }]);
      const followed = patch.setsFollowed ?? current.setsFollowed;
      const seen = new Set<string>();
      for (const [index, key] of followed.entries()) {
        const id = `${key.language}\u0000${key.setId}`;
        if (seen.has(id)) throw new ValidationError('Followed sets must be distinct', [{ path: `setsFollowed.${index}`, code: 'custom', message: 'Duplicate set' }]);
        seen.add(id);
        if (!languages.includes(key.language)) {
          throw new ValidationError('Removing a language requires removing its followed sets', [
            { path: `setsFollowed.${index}`, code: 'custom', message: `Language ${key.language} is not selected` }
          ]);
        }
      }
      let ack = current.disclaimerAcknowledged;
      let ackAt = current.disclaimerAcknowledgedAt;
      if (patch.disclaimerAcknowledged !== undefined && patch.disclaimerAcknowledged !== ack) {
        ack = patch.disclaimerAcknowledged;
        ackAt = ack ? now : null;
      }
      let onboardedAt = current.onboardingCompletedAt;
      if (patch.onboardingCompleted !== undefined) onboardedAt = patch.onboardingCompleted ? (current.onboardingCompletedAt ?? now) : null;
      await tx.run(
        `UPDATE app_settings SET languages_json = ?, sets_followed_json = ?, sync_all_sets = ?, hide_tcg_pocket = ?, default_currency = ?,
          disclaimer_acknowledged = ?, disclaimer_acknowledged_at = ?, onboarding_completed_at = ?, updated_at = ? WHERE id = 'app'`,
        [
          JSON.stringify(languages), JSON.stringify(followed), (patch.syncAllSets ?? current.syncAllSets) ? 1 : 0,
          (patch.hideTcgPocket ?? current.hideTcgPocket) ? 1 : 0, patch.defaultCurrency ?? current.defaultCurrency, ack ? 1 : 0, ackAt, onboardedAt, now
        ]
      );
      return readSettings(tx);
    });
  }
}
