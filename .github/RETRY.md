# Daily recovery workflow

Schedule (Vietnam time): 04:17 morning, 14:37 technical-failure recovery. Scheduled morning plans may start before 10:00; retry plans before 16:00. Later queued schedules are skipped. GitHub may queue jobs; both modes use the same concurrency group. Manual dispatch selects `morning` or `retry`.

## One-time setup

Create a fine-grained GitHub PAT for **only** the private repository configured by `REWARDS_PRIVATE_REPO` with **Contents: Read and write**. Add its value to the public `quyetvo` repository's Actions secret named `REWARDS_STATE_TOKEN`. Keep `PRIVATE_REPO_TOKEN` read-only for checkout. No Actions-write or Workflows permission is needed for the state token. PAT repository permissions are not restricted to the state branch, so keep the token private and review changes to workflow code.

Storage branch: `rewards-state` in the private repo. Paths: `state/YYYY-MM-DD/account-N.json`. Only slot number, fixed status/error labels, eligibility and attempt identifiers/timestamps are saved; no email, balances, credentials, cookies or logs. Results also retain an allowlisted last stage, login state and error labels under `diagnostic`, so a generic `FLOW_FAILED` can be investigated privately. Unknown diagnostic strings and raw messages are discarded. Older state files cannot recover details that were not saved.

## Recovery rules

- Only same-day terminal technical failures qualify: network/proxy connection errors, timeout and selected transient HTTP errors.
- Successful runs, unverified completion, generic unknown failures, authentication/locked accounts, configuration failures and missing state do not qualify.
- Each account reserves its morning or retry attempt before execution. A cancelled/interrupted reservation is consumed, preventing an automatic duplicate. Re-running jobs does not reset the daily retry budget.
- Missing `REWARDS_STATE_TOKEN`: morning execution continues without persistence; afternoon skips all accounts. A configured but invalid token or conflicting write fails closed before running the affected account.
- Account results are stored before Telegram notification. Telegram failure alone never causes the account to run again.
- The retry is a new login/run, not restoration of a saved browser session. Sessions are not uploaded to the public repository.
- Existing AZDIGI dispatch cron can still trigger runs. Disable duplicate schedules outside this repo separately.

After adding the token, the next morning run will create state files. The afternoon run cannot reconstruct prior runs that did not save state. Use manual `retry` only after a same-day morning result exists.

## Local validation

`node --test .github/scripts/rewards-runner.test.cjs .github/scripts/rewards-state.test.cjs .github/scripts/rewards-operations.test.cjs`

## Preflight, private notifications and log retention

Each earning worker checks account credentials, SSH settings, private source read access, private state write/delete access, and Telegram getMe/getChat before reserving an earning attempt. Telegram checks do not send messages. A failed preflight consumes no daily attempt.

Account reports are persisted privately before notification delivery. A private notification record is reserved by its Git blob SHA before sending, then marked sent. Confirmed Telegram rejections can be retried by the report-only recovery workflow, up to three total attempts per notification. Timeout or ambiguous network outcomes become uncertain; records left sending after interruption are also not sent again automatically. Verify Telegram manually in these cases, because exactly-once delivery cannot be guaranteed across an external API and Git storage. Saved payloads contain the private formatted report, including account identity, but no bot token or authentication credentials. They remain private; they do not cross public job outputs.

Report-only recovery runs at 08:30, 12:30, 16:30 and 20:30 Vietnam time, or via manual dispatch. It considers the latest three Vietnam calendar days of notifications and never launches the bot or claims an earning attempt. A chat ID change refuses to deliver older messages to a new destination.

Install/browser/build output is capped, redacted and saved privately under setup-logs. Public logs show only fixed success/failure messages.

Private log retention runs daily at 06:30 Vietnam time, or via manual dispatch, and removes older files only under logs, diagnostics and setup-logs. It keeps today and the preceding two Vietnam calendar dates. Reports, notifications, account state and retry budgets are preserved. The branch update is non-forced so concurrent state writes cannot be overwritten. GitHub scheduling can be delayed. This removes files from the current branch only; historical Git objects are not purged.

## Private connection settings

Before merging the Secrets migration, create these repository Actions secrets in the public automation repository:

- `REWARDS_PRIVATE_REPO`: private source/state repository in `owner/repository` format.
- `AZDIGI_SSH_HOST`: SSH hostname.
- `AZDIGI_SSH_USER`: SSH login username.
- `AZDIGI_SSH_PORT`: SSH port as a decimal number.

Keep the existing checkout token, state token, SSH key and known-hosts secrets. The main workflow already passes repository secrets to the reusable worker using `secrets: inherit`. This migration affects future runs only; old logs and Git history retain previously published values.

## Daily execution window

The plan reads the original workflow run creation timestamp from GitHub instead of dating the run when a delayed job starts. A run queued across Vietnam midnight is skipped, never reassigned to the next day. Unknown schedules fail closed.

Each worker checks its remaining budget before preflight and again before reserving an attempt. New account attempts require at least 90 minutes before the 22:30 Vietnam bot deadline (last start 21:00). The bot retains its 75-minute limit and is also stopped at the earlier daily deadline; DAILY_WINDOW_EXPIRED does not qualify for an earning retry. Result persistence and notification can follow the bot stop. GitHub may still show a late queued workflow entry; preventing that entry requires an external scheduler. Existing active runs keep their old workflow revision.

Accounts remain sequential and the 100–180 second inter-account rest is unchanged. Six workers at their 100-minute job caps can need about ten hours per pass; changing cron does not make six full worst-case retries fit after an arbitrarily late start. Late accounts are skipped without consuming their attempts. Search pacing is unchanged. Disable any duplicate external AZDIGI schedule separately.
