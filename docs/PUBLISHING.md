# Publishing to Firefox Add-ons (AMO)

This is the release checklist for the signed build and the AMO listing.

## 1. Prepare the release

1. Bump `version` in both `extension/manifest.json` and `package.json`.
2. Run the checks:

   ```bash
   npm test
   npm run lint
   npm run build
   ```

3. The build is written to `dist/chatgpt-account-switcher-<version>.xpi`.
   `dist/` and `signed/` are git-ignored on purpose.

## 2. Create the AMO listing

1. Sign in at <https://addons.mozilla.org>.
2. Open the developer hub: <https://addons.mozilla.org/developers/>.
3. Choose **Submit a New Add-on**.
4. Pick the distribution model:
   - **On this site** — public listing, reviewed by Mozilla.
   - **On your own** — unlisted/self-distributed, still signed by Mozilla.
5. Fill in the listing:
   - **Name:** ChatGPT Account Switcher
   - **Summary:** Save multiple ChatGPT accounts locally and switch between
     them in one click.
   - **Category:** Productivity
   - **License:** MIT
   - **Privacy policy:** link to `PRIVACY.md` in the GitHub repository
   - **Support site / homepage:** <https://github.com/tje3d/chatgpt-account-switcher>
   - **Tags:** `chatgpt`, `accounts`, `switcher`, `privacy`, `cookies`
6. Upload the XPI from `dist/`.
7. Upload the screenshots from `docs/screenshots/` if the listing asks for
   them. They use demo data only.

## 3. Reviewer notes

Paste something like this into the notes field:

> This extension stores user-initiated snapshots of `chatgpt.com` and
> `openai.com` cookies in `browser.storage.local` so the user can switch between
> their own ChatGPT accounts without logging in again. It has no server, no
> analytics, and no remote code.
>
> Permissions:
> - `cookies` — read/clear/restore cookies for the two allowed domains.
> - `storage` — keep snapshots and labels locally.
> - `tabs` — reload open ChatGPT tabs after switching.
>
> Network: the only request is a same-origin read of
> `https://chatgpt.com/api/auth/session` to display the signed-in email. No data
> is sent to the developer.
>
> To test without sharing credentials: load the extension, save any cookie
> snapshot from `chatgpt.com`, then use the backup page to export/import it. A
> full login test requires a normal ChatGPT account.

The manifest already declares
`browser_specific_settings.gecko.data_collection_permissions.required =
["none"]`.

## 4. Sign an unlisted build from the command line

Generate API credentials at
<https://addons.mozilla.org/developers/addon/api/key/>.

```bash
npm run build
npx web-ext sign \
  --source-dir extension \
  --artifacts-dir signed \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
```

Install the signed `.xpi` from `about:addons` → gear → **Install Add-on From
File…**.

## 5. After approval

- Add the AMO link and badge to `README.md`.
- Create a Git tag and GitHub release for the version.
- Attach the **signed** XPI to the release, not the unsigned build.
- Keep the exported `.xpi` checksum in the release notes.

## Notes

- `web-ext lint` reports two warnings because Firefox 115 is older than the
  version that introduced `data_collection_permissions` (Firefox 140 / Android
  142). They are compatibility warnings, not errors; keep Firefox 115 support
  unless that is no longer wanted.
- Do not commit `dist/`, `signed/`, real cookie exports, or account emails.
