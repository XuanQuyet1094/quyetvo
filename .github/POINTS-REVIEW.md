# Daily points review

Accounts with fewer than 220 verified points across saved receipts for the Vietnam calendar day qualify for the noon retry even when the morning status is completed. A missing task or an unmet mobile/desktop search goal also qualifies, including accounts above 220. Unknown points require review. Auth failures, locks, active attempts, and the one-retry-per-day reservation still block automatic retries.

The threshold is a diagnostic trigger, not a guarantee of available points. A retry runs the normal worker configuration; actual task/quota checks decide what remains. Evening reconciliation uses fresh task checks and its separate one-attempt-per-day reservation.

Mobile and desktop have separate daily goals of 60 and 90 points. Each query gets its own fresh balance baseline; positive increases of up to three points count toward that platform. Larger increases, negative changes and rebounds below the previous high-water balance do not count. Search credit is separate from total account gains, Daily Set, reading and claimed bonuses. Browser searches are sequential and background Edge/API searching is disabled to isolate the observations.

A query whose balance update arrives at the next baseline is still counted before starting another query. Reaching the goal during that read skips the new query. At session end, at most two read-only checks (after one and two seconds) may settle the last outstanding query within the existing time budget. Verification failures preserve existing receipts. Increases before the first query and amounts claimed by ClaimBonusPoints remain unattributed to search; an unexplained six-point claim is never automatically split into three mobile and three desktop points.

Each query emits a cumulative structured receipt, captured privately even if a later query fails. Same-day receipts are deduplicated by run ID/attempt and capped at each platform target. Morning starts with a new day ledger. Later claims restore the saved credits; older runs can be migrated from private per-query logs, not stage totals. Missing evidence remains uncertain. Telegram displays day counters (for example 57/60 and 87/90), then “Hoàn thành mục tiêu” once the goal is reached. This is completion of the configured goal, not an invented Microsoft quota response. A reliable Microsoft quota-complete response is still respected even when the local counter is lower.

Historical logs containing an ambiguous large gain preserve the smaller confirmed query credits as a lower bound instead of resetting the platform to zero. Telegram labels the observed count explicitly and distinguishes the configured target from a quota completion confirmed by Microsoft. Five idle searches or a missing quota response alone never establish completion.

Reconciliation searches only the remaining amount for each platform. Each platform remains limited to 20 queries and five consecutive queries without gains, and stops starting new queries after an eight-minute session budget. The overall account and daily deadlines remain in force. Hitting a guard cannot complete an unmet goal; it remains eligible for review. Reservations are not cleared or reopened.

Daily totals are computed from validated private balance-difference receipts, deduplicated by run ID and attempt. Missing or inconsistent receipts do not count as a verified total. Telegram morning reports flag accounts below the threshold. Private logs and credentials remain private.

Delayed noon schedules can start until 21:00 Vietnam instead of 16:00. Reconciliation now passes its mode to the time-budget guard and has backup triggers at 19:17 and 20:17 in addition to 18:17. All evening triggers share the same daily reservation. No account is started across the date boundary or beyond the existing 22:30 deadline. GitHub schedule delays are still possible.

