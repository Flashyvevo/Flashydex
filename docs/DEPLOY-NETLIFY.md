# Deploy FlashyDex as a Netlify PWA

FlashyDex is currently distributed as a browser/PWA product. The Capacitor shell remains in the repository for a later manual iOS/TestFlight workflow; it is not part of the Netlify deploy.

## Production URLs and environment values

Create a dedicated public Netlify site named `flashydex-catalog-packs`. Its fixed production manifest URL is:

```text
https://flashydex-catalog-packs.netlify.app/catalog-manifest.json
```

Set this exact public build variable on the FlashyDex application site for both Production and Deploy Previews:

```text
FLASHYDEX_MANIFEST_URL=https://flashydex-catalog-packs.netlify.app/catalog-manifest.json
```

Vite exposes `FLASHYDEX_` values to the client, so this is public configuration: never put credentials in it. If the packs site is given a different Netlify subdomain, update both the workflow `PACKS_ORIGIN` and this environment value before its first pack deployment.

The catalog workflow also needs these GitHub Actions repository secrets:

```text
NETLIFY_AUTH_TOKEN=<Netlify personal access token with deploy access>
NETLIFY_PACKS_SITE_ID=<the flashydex-catalog-packs Netlify site ID>
```

The pack site deploy contains the current `catalog-manifest.json`, immutable versioned `.db.zst` packs, set indexes, and metrics. It sends `Access-Control-Allow-Origin: *`; `.zst` is explicitly `application/zstd` with no `Content-Encoding`, so Netlify must not double-compress it. GitHub Releases remain an immutable archive, not a browser download origin.

## Owner setup: application site

1. In Netlify, choose Add new site, then Import an existing project.
2. Select GitHub and choose `Flashyvevo/Flashydex`.
3. Keep the repository root as the base directory. Netlify reads `netlify.toml`, which sets Node 22, runs `npm ci && npm run build --workspace=@flashydex/mobile`, and publishes `apps/mobile/dist`.
4. In Site configuration → Environment variables, add `FLASHYDEX_MANIFEST_URL` with the exact value above. Set the scopes to Production and Deploy Previews.
5. Deploy the site. Pushes to `main` create production deploys. Pull requests create Netlify Deploy Previews; open the deployment link in the PR checks or Netlify Deploys page.
6. Do not attach a custom domain until the initial `*.netlify.app` deploy is working. When ready, add the domain in Domain management, update DNS, and use the HTTPS custom-domain manifest origin only if the packs origin changes.

The root SPA fallback is `apps/mobile/public/_redirects`. Static assets take precedence, and unknown client routes rewrite to `index.html` with HTTP 200. `apps/mobile/public/_headers` gives hashed Vite JS/CSS/font assets immutable caching, forces `application/wasm` for WebAssembly, and makes the app shell, service worker, and web manifest revalidate.

Cross-origin isolation headers remain deliberately commented out. The chosen `opfs-sahpool` SQLite VFS does not require COOP/COEP. Enable the commented `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` block only if the product changes to the `opfs` VFS, which needs SharedArrayBuffer.

## Owner setup: pack site and workflow

1. In Netlify, create a second blank site named exactly `flashydex-catalog-packs`. No repository build configuration is needed: the GitHub workflow deploys a generated static directory directly.
2. Copy the site ID from Site configuration → General → Site details.
3. Create a Netlify personal access token that can deploy to that site.
4. In GitHub repository Settings → Secrets and variables → Actions, add `NETLIFY_AUTH_TOKEN` and `NETLIFY_PACKS_SITE_ID`.
5. Run Actions → Catalog packs → Run workflow. It builds EN/JA packs, verifies and archives them in an immutable GitHub Release, deploys the packs site, then fetches the stable manifest URL and byte-compares it to the generated manifest.

A new packs deploy replaces the packs site's current deploy as a coherent manifest-plus-assets release. A client always fetches the fixed manifest URL first, so it receives URLs for the packs present in that deploy. To roll a pack release back, use the previous deploy in the packs site's Deploys page and publish it; the matching previous manifest and pack files return together.

## Roll back the application

In Netlify → FlashyDex application site → Deploys, find the last known-good production deploy and choose Publish deploy. Netlify restores that exact static deploy. The catalog manifest remains independently hosted; application rollbacks do not remove user data or a device's installed catalog.

## CLI alternative

Install and authenticate the Netlify CLI locally, then link and deploy the application site:

```bash
npm install --global netlify-cli
netlify login
cd C:/Projects/flashydex
netlify init
netlify deploy
netlify deploy --prod
```

Confirm the linked site is the application site before `--prod`. The CLI reads `netlify.toml`; set `FLASHYDEX_MANIFEST_URL` in the Netlify site environment rather than adding it to `.env` or a command history.

## Installing the PWA

- iPhone/iPad (Safari): open the HTTPS production URL, tap Share, then Add to Home Screen, and confirm Add.
- Android (Chrome): open the HTTPS production URL, use the Install prompt or Chrome menu → Install app/Add to Home screen, then confirm.

Installation and service-worker behavior require HTTPS. A local LAN HTTP dev server is not equivalent to this production path.

## References

- Netlify file-based configuration: https://docs.netlify.com/build/configure-builds/file-based-configuration/
- Netlify redirects and rewrites: https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/
- Netlify custom headers: https://docs.netlify.com/manage/routing/headers/
- Netlify CLI deploy command: https://docs.netlify.com/cli/get-started/
- GitHub Actions workflow syntax: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
