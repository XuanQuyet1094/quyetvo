# Daily recovery workflow

Schedule (Vietnam time): 07:00 morning, 15:00 technical-failure recovery. GitHub may queue jobs; both modes use the same concurrency group. Manual dispatch selects `morning` or `retry`.

## One-time setup

Create a fine-grained GitHub PAT for **only** `XuanQuyet1094/Microsoft-Rewards-Script` with **Contents: Read and write**. Add its value to the public `quyetvo` repository's Actions secret named `REWARDS_STATE_TOKEN`. Keep `PRIVATE_REPO_TOKEN` read-only for checkout. No Actions-write or Workflows permission is needed for the state token. PAT repository permissions are not restricted to the state branch, so keep the token private and review changes to workflow code.

Storage branch: `rewards-state` in the private repo. Paths: `state/YYYY-MM-DD/account-N.json`. Only slot number, fixed status/error labels, eligibility and attempt identifiers/timestamps are saved; no email, balances, credentials, cookies or logs.

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

`node --test .github/scripts/rewards-runner.test.cjs .github/scripts/rewards-state.test.cjs`
