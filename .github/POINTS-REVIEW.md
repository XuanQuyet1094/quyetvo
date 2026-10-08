# Daily points review

Accounts with fewer than 220 verified points across saved receipts for the Vietnam calendar day now qualify for the noon retry even when the morning status is completed. Unknown points also require review. Exactly 220 is not below the threshold. Auth failures, locks, active attempts, and the one-retry-per-day reservation still block automatic retries.

The threshold is a diagnostic trigger, not a guarantee of available points. A retry runs the normal worker configuration; actual task/quota checks decide what remains. Evening reconciliation still uses fresh confirmed-missing task checks and its separate one-attempt-per-day reservation.

Daily totals are computed from validated private balance-difference receipts, deduplicated by run ID and attempt. Missing or inconsistent receipts do not count as a verified total. Telegram morning reports flag accounts below the threshold. Private logs and credentials remain private.

Delayed noon schedules can start until 21:00 Vietnam instead of 16:00. Reconciliation now passes its mode to the time-budget guard and has backup triggers at 19:17 and 20:17 in addition to 18:17. All evening triggers share the same daily reservation. No account is started across the date boundary or beyond the existing 22:30 deadline. GitHub schedule delays are still possible.
