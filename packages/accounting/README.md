# @sugabots/accounting

Records model usage and produces reproducible cost estimates. Estimates are operational data, not
invoices or customer-billable amounts.

## API

Records that enter the package — intents, observations, usage evidence, rate snapshots, and
provider charges — are Effect Schemas. Decode them at the boundary; identifiers, timestamps,
currencies, and amounts are branded so unvalidated values cannot reach the calculations.

`collectAttempt` and `verifyAccountingStoreContract` perform I/O and return Effects with tracing
spans. Everything else is a plain function; ones that can fail return a `Result`.

| Function                        | Purpose                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `collectAttempt`                | Runs one provider request and records its accounting lifecycle |
| `reduceAttempt`                 | Rebuilds an attempt's ledger from stored observations          |
| `applyObservation`              | Adds one observation to a ledger, reporting conflicts          |
| `normalizeUsage`                | Validates counters and reports measurement completeness        |
| `aggregateAttempts`             | Combines usage while retaining coverage and disputes           |
| `estimateAttempt`               | Prices an attempt against the snapshot in effect at its start  |
| `aggregateEstimates`            | Sums estimates without mixing currencies                       |
| `evidenceFromAiSdkUsage`        | Converts AI SDK usage to evidence (`/ai-sdk`)                  |
| `snapshotFromModelsDev`         | Creates a rate snapshot from [Models.dev](https://models.dev/) (`/models-dev`) |
| `verifyAccountingStoreContract` | Checks a store adapter against isolated fixtures               |

## Collection

`collectAttempt` manages one provider request from intent through terminal observation:

- Every request and retry has its own attempt ID. The start and observation times come from `Clock`.
- Dispatch requires an atomic claim, preventing duplicate provider calls.
- Callers choose whether an unavailable intent write should `block` or `continue` untracked.
- Observation writes are idempotent; failed writes are reported without replaying the request.
- Provider failures and interruptions remain unchanged after terminal accounting.

## Pricing

Rate snapshots retain source provenance. Calculations use exact decimal arithmetic, preserve
missing measurements, and resolve rates for the attempt's start time, context tier, returned model,
and connection. Incomplete evidence produces a partial or unavailable estimate rather than a
misleading zero.
