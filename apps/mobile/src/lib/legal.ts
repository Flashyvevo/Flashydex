// Bundled legal text. Source of truth for the policy wording: docs/PRIVACY-POLICY.md (owner brackets resolved
// to the shipped behaviour; D18 backup sentence included). Works offline.

export const DISCLAIMER = 'FlashyDex is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company.';
export const DISCLAIMER_SECONDARY = 'Card names, numbers and images are the property of their respective owners and are shown for collection tracking only.';
export const BACKUP_SENTENCE = 'Your collection is included in your device backup. The card catalog is not — it re-downloads.';
export const TCGDEX_URL = 'https://tcgdex.dev';
export const PRIVACY_URL = (import.meta.env.FLASHYDEX_PRIVACY_URL as string | undefined) ?? '';

export const PRIVACY_UPDATED = '31 October 2026';

export const PRIVACY_SUMMARY: string[] = [
  'FlashyDex doesn’t collect your data. There’s no account, no ads and no analytics.',
  'Your collection, notes and prices you enter stay on this device.',
  'To download card data, images and prices, the app connects directly to TCGdex (api.tcgdex.net and assets.tcgdex.net). TCGdex sees your device’s IP address, like any website you visit. Price data comes from TCGplayer and Cardmarket through TCGdex.',
  'Exports and backups go only where you share them.',
  BACKUP_SENTENCE
];

export const PRIVACY_SECTIONS: { heading: string; paragraphs: string[]; bullets?: string[] }[] = [
  {
    heading: 'The short version',
    paragraphs: [
      'FlashyDex stores your collection on your device. We do not run user accounts. We do not sell data. The app does not include advertising or analytics.',
      'The app downloads card catalog data and images from TCGdex so you can search cards and see artwork. Those requests go to TCGdex, not to us.'
    ]
  },
  {
    heading: 'What stays on the device',
    paragraphs: ['The app keeps a database on the phone or tablet. That database holds:'],
    bullets: [
      'cards you add, including condition, grade, purchase price, notes, and storage location if you enter them',
      'sets and card details the app has downloaded so search works offline',
      'your settings, including which languages and sets you chose'
    ]
  },
  {
    heading: 'Device backups',
    paragraphs: [
      BACKUP_SENTENCE,
      'We do not operate a server that receives your collection. Uninstalling the app removes it from the device.',
      'You can export your collection to a file and share that file yourself. Once you share it, whoever you sent it to has it. We do not see that transfer.'
    ]
  },
  {
    heading: 'Network requests',
    paragraphs: ['The app makes network requests only to:'],
    bullets: ['api.tcgdex.net for catalog data (sets, cards, prices TCGdex publishes)', 'assets.tcgdex.net for card images and set artwork', 'the host that serves FlashyDex catalog downloads']
  },
  {
    heading: 'What the requests contain',
    paragraphs: [
      'Those requests are ordinary HTTPS. They ask for catalog records. They do not include your name, your notes, or an account id, because the app has none. Your device’s IP address is visible to the host as part of the connection, the same way it is visible to any site you open.',
      'We do not use the data in those requests to advertise to you. We do not sell it. We do not combine it with data from other companies.'
    ]
  },
  {
    heading: 'What we do not do',
    paragraphs: [],
    bullets: ['No account, no password, no email signup', 'No analytics SDK, no advertising SDK, no sale of personal information', 'No request that you allow tracking across other companies’ apps']
  },
  {
    heading: 'Camera and photos',
    paragraphs: ['This version does not use the camera or the photo library, and asks for no permissions.']
  },
  {
    heading: 'Children',
    paragraphs: ['FlashyDex is a collection tool. It is not directed at children, and it does not ask for a child’s name or age.']
  },
  {
    heading: 'How long we keep data',
    paragraphs: [
      'We do not keep a copy of your collection. It stays on your device until you delete it or uninstall the app.',
      'Downloaded catalogs can be removed in Settings → Remove a downloaded catalog. There is no account to delete.'
    ]
  },
  {
    heading: 'Card names and artwork',
    paragraphs: ['Card names, set names and card images come from TCGdex and depict a game we do not own. See About.']
  },
  {
    heading: 'Changes',
    paragraphs: ['If this policy changes, the date above changes and the copy inside the app matches it.']
  }
];

export type LicenseEntry = { name: string; version?: string; license: string; holder: string; note?: string; url?: string };

/** Always-first entries (UX §10.6), then direct dependencies. Versions mirror apps/mobile/package.json. */
export const LICENSES: LicenseEntry[] = [
  { name: 'TCGdex', license: 'MIT', holder: '2021 TCGdex', url: 'https://github.com/tcgdex/cards-database', note: 'Card data. The MIT license covers TCGdex’s software and data files, not the card artwork.' },
  { name: 'Inter', version: '5.3.0', license: 'SIL OFL 1.1', holder: 'The Inter Project Authors', url: 'https://openfontlicense.org' },
  { name: 'lucide-react', version: '1.65.0', license: 'ISC', holder: 'Lucide Contributors', url: 'https://lucide.dev/license' },
  { name: 'React', version: '19.3.1', license: 'MIT', holder: 'Meta Platforms, Inc. and affiliates' },
  { name: 'TanStack Router', version: '1.170.46', license: 'MIT', holder: 'Tanner Linsley' },
  { name: 'TanStack Query', version: '5.105.0', license: 'MIT', holder: 'Tanner Linsley' },
  { name: 'Tailwind CSS', version: '4.3.3', license: 'MIT', holder: 'Tailwind Labs, Inc.' },
  { name: 'Capacitor', version: '7.6.10', license: 'MIT', holder: 'Drifty Co.' },
  { name: '@capacitor-community/sqlite', version: '7.0.3', license: 'MIT', holder: 'Capacitor Community' },
  { name: 'SQLCipher', license: 'BSD-style (Zetetic LLC)', holder: 'Zetetic LLC', note: 'Linked on iOS and Android through @capacitor-community/sqlite.', url: 'https://www.zetetic.net/sqlcipher/license/' },
  { name: 'sql.js', version: '1.12.0', license: 'MIT', holder: 'sql.js contributors' },
  { name: 'jeep-sqlite', version: '2.8.0', license: 'MIT', holder: 'Capacitor Community' },
  { name: 'Drizzle ORM', version: '0.45.4', license: 'Apache-2.0', holder: 'Drizzle Team', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  { name: 'fzstd', version: '0.1.1', license: 'MIT', holder: 'Arjun Barrett' },
  { name: 'hash-wasm', version: '4.12.0', license: 'MIT', holder: 'Dani Biró' },
  { name: 'zod', version: '4.6.7', license: 'MIT', holder: 'Colin McDonnell' },
  { name: 'localForage', version: '1.10.0', license: 'Apache-2.0', holder: 'Mozilla', url: 'https://www.apache.org/licenses/LICENSE-2.0' }
];

export const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

export const ISC_TEXT = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
