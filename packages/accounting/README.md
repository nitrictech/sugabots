# @sugabots/accounting

Records model usage and produces reproducible cost estimates. Estimates are operational data, not
invoices or customer-billable amounts.

## API

Public operations return Effects and add named tracing spans to the caller's trace. The package does
not configure telemetry. Application code should use the unsuffixed Effect APIs.

## Key Operations

| Function                 | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `collectAttempt`         | Runs one provider request and records its accounting lifecycle |
| `normalizeUsage`         | Validates counters and reports measurement completeness        |
| `aggregateAttempts`      | Combines usage while retaining coverage and disputes           |
| `snapshotFromModelsDev`  | Creates a rate snapshot from [Models.dev](https://models.dev/)  |
| `resolvePricingSnapshot` | Selects the applicable rate snapshot for an attempt            |
| `estimateCost`           | Prices one attempt against an applicable rate snapshot         |
| `aggregateEstimates`     | Sums estimates without mixing currencies                       |
| `providerReportedCharge` | Validates charges without treating them as estimates           |
| `costEstimateRevision`   | Records estimate provenance and corrections                    |

Import `snapshotFromModelsDev` from `@sugabots/accounting/models-dev`; the other operations above
are available from the package root.

## Collection

`collectAttempt` manages one provider request from intent through terminal observation:

- Every request and retry has its own attempt ID.
- Dispatch requires an atomic claim, preventing duplicate provider calls.
- Callers choose whether an unavailable intent write should `block` or `continue`.
- Observation writes are idempotent; failed writes are reported without replaying the request.
- Provider failures and interruptions remain unchanged after terminal accounting.

Store adapters can validate isolated fixtures with `verifyAccountingStoreContract`.

## Pricing

Rate snapshots are immutable and retain source provenance. Calculations use exact decimal arithmetic,
preserve missing measurements, and resolve rates for the attempt's time, context tier, and connection.
Incomplete evidence produces a partial or unavailable estimate rather than a misleading zero.
