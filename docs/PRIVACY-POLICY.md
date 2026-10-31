# Privacy Policy — FlashyDex (draft)

Draft for the owner to review. This is not legal advice. Text in brackets is a choice the owner has to make before this page is hosted. Do not publish the brackets.

App Review Guideline 5.1.1(i) requires a privacy-policy link in App Store Connect and inside the app. Host the finished text at a public HTTPS URL. [owner to confirm] the URL.

Last updated: [owner to confirm: date]

## Who we are

FlashyDex is a card-collection app published by [owner to confirm: legal name of the developer or company].

Contact: [owner to confirm: email address that a user and Apple can write to].

The studio contact on file is julian@elevatedpeakmarketing.com. Use it only if that person or company is the publisher. [owner to confirm]

## The short version

FlashyDex stores your collection on your device. We do not run user accounts. We do not sell data. The app, as designed for its first release, does not include advertising or analytics.

The app downloads card catalog data and images from TCGdex so you can search cards and see artwork. Those requests go to TCGdex, not to us.

## What stays on the device

The app keeps a database on the phone or tablet. That database holds:

- cards you add, including condition, grade, purchase price, notes, and storage location if you enter them
- sets and card details the app has downloaded so search works offline
- your settings, including which languages and sets you chose to sync

We do not operate a server that receives this database. Uninstalling the app removes it from the device, subject to the backup note below.

[owner to confirm: the build will store the database in the iOS location `Library/CapacitorDatabase`, which the SQLite plugin documents as not backed up to iCloud and not visible in iTunes. If the build uses the Documents folder instead, iOS may include the database in an iCloud or Finder backup. The sentence in the published policy must match the build.]

You can export your collection to a file and share that file yourself. Once you share it, whoever you sent it to has it. We do not see that transfer.

## Network requests

The app makes network requests only to:

- `https://api.tcgdex.net` for catalog data (sets, cards, prices TCGdex publishes)
- `https://assets.tcgdex.net` for card images and set artwork

A later version may also let you point the app at a server you run yourself, for backup or for card recognition. That server is yours. This policy does not describe what it stores. If we add that, the in-app screen that asks for the server address will say so, and this policy will be updated before that version ships. [owner to confirm: no other hosts, including crash reporting, will be added without updating this policy]

Those requests are ordinary HTTPS. They ask for catalog records. They do not include your name, your notes, or an account id, because the app has none. Your device's IP address is visible to TCGdex as part of the connection, the same way it is visible to any site you open.

[owner to confirm: whether TCGdex keeps IP addresses or request logs, and for how long. A privacy policy for TCGdex was not found on 31 October 2026. If they retain logs, say that here in plain language, and answer the App Store privacy questions to match.]

We do not use the data in those requests to advertise to you. We do not sell it. We do not combine it with data from other companies.

## What we do not do

- No account, no password, no email signup
- No analytics SDK, no advertising SDK, no sale of personal information
- No request that you allow tracking across other companies' apps

If that changes, this policy changes first, and the App Store and Play listings are updated to match.

## Camera and photos

The first release does not use the camera or the photo library.

A later version may use the camera, or a photo you pick, to identify a card. The photo is processed to match a card. [owner to confirm: the photo stays on the device and is not uploaded to us. If a future optional server receives the photo, this section must say that before that version ships.]

You can refuse the camera permission and still search for the card by name.

## Children

FlashyDex is a collection tool. It is not directed at children, and it does not ask for a child's name or age. [owner to confirm: the app will not be placed in Apple's Kids Category, and store text will not say "for kids" or "for children".]

## How long we keep data

We do not keep a copy of your collection. It stays on your device until you delete it, erase the app's data, or uninstall the app.

Catalog files the app downloaded can be deleted by clearing the catalog in the app or by uninstalling. [owner to confirm: the Settings screen will include a control that deletes the local database, so the policy's "how do I delete my data" answer is true without an account.]

There is no account to delete. App Review Guideline 5.1.1(v) requires in-app account deletion only if the app lets people create an account. This app does not.

## Card names and artwork

Card names, set names, and card images come from TCGdex and depict a game we do not own. See the About text below. [owner to confirm: legal review of showing those images before the policy claims anything stronger than this.]

## Changes

If this policy changes, the hosted page will show a new date, and the copy inside the app will match it. Continued use of the app after the date is not a substitute for telling you when the change is material. [owner to confirm: how a material change will be shown in the app.]

## Contact

Questions about this policy: [owner to confirm: same email as above].

---

## In-app About text

Put this on the About screen, reachable from Settings, without an account. It is the disclaimer, not the whole policy. Link the full policy under it.

FlashyDex is a personal collection manager. It is not affiliated with Nintendo, Creatures, GAME FREAK or The Pokémon Company. Pokémon and related marks are trademarks of their owners. Card names and images are shown so you can identify cards in your collection. They are not ours.

Your collection stays on this device. The app downloads catalog data from TCGdex (api.tcgdex.net and assets.tcgdex.net). It does not send your collection to us. There is no account.

Privacy policy: [owner to confirm: hosted URL]
Contact: [owner to confirm: email]
