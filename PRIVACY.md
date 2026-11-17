# Privacy Policy

**ChatGPT Account Switcher** does not collect, transmit, sell, or share personal
data. There is no analytics, telemetry, advertising, or crash reporting.

## What is stored, and where

Everything the add-on remembers stays in your local Firefox profile
(`browser.storage.local`):

- account labels you choose,
- email addresses detected from your own ChatGPT session,
- cookie snapshots for `chatgpt.com` and `openai.com`,
- timestamps for when an account was saved or last used.

Nothing is sent to the developer or to any third party.

## Network access

The add-on makes no requests to a developer-operated server. It only reads
`https://chatgpt.com/api/auth/session` in your browser to display which account
is currently signed in. That request goes to OpenAI, not to the developer.

## Permissions

- **cookies** — read, clear, and restore cookies for ChatGPT/OpenAI so accounts
  can be switched.
- **storage** — keep account snapshots locally in Firefox.
- **tabs** — reload open `chatgpt.com` tabs after a switch.
- **host access** — limited to `chatgpt.com` and `openai.com`.

## Backups

An export is created only when you press **Export**. The resulting JSON file
contains live login cookies and is written wherever you choose to save it. You
control that file; the add-on never uploads it.

## Deleting your data

- Delete individual accounts in the popup.
- Remove the add-on, or clear its data from `about:addons` → **ChatGPT Account
  Switcher** → **Details** → **Clear storage**, to remove all snapshots.
- Exported backup files must be deleted separately.

## Contact

For privacy questions, open an issue at
<https://github.com/tje3d/chatgpt-account-switcher/issues>. Do not include real
cookies, account emails, or backup files in an issue.

_Effective date: November 17, 2026._
