# Migration Guide

This guide documents every breaking change to the public `@sorowill/sdk` API
and explains how to update your code when upgrading between major or minor
versions that include breaking changes.

---

## Migrating from 0.1.0 → 0.1.1

### 1. `Beneficiary.percentage` scale changed (0–10 000 → 0–100)

**What changed**

In SDK 0.1.0 the `Beneficiary.percentage` field held the raw on-chain
*basis-point* value (0–10 000, where 10 000 = 100 %). In 0.1.1 it was
re-scaled to a human-readable 0–100 integer percentage.

| SDK version | `percentage` meaning | Example: 30 % share |
|-------------|----------------------|---------------------|
| 0.1.0       | Basis points          | `3000`              |
| ≥ 0.1.1     | Whole percentage      | `30`                |

**Impact**

- Any code that reads `beneficiary.percentage` and treats it as a raw basis
  point value will now receive a number 100 × smaller than before.
- Any persisted `Beneficiary` objects (e.g. stored in a database, localStorage,
  or a React state snapshot) need a one-time migration: divide the stored
  `percentage` by 100.

**Migration**

```ts
// Before (SDK 0.1.0): basisPoints was the raw value, e.g. 3000 for 30 %
const basisPoints = beneficiary.percentage;

// After (SDK ≥ 0.1.1): percentage is the human-readable value, e.g. 30 for 30 %
const humanPercentage = beneficiary.percentage; // 30, not 3000

// Migrating stored basis-point values from 0.1.0:
const legacyBasisPoints = storedBeneficiary.percentage; // e.g. 3000
const migratedPercentage = legacyBasisPoints / 100;     // 30
```

---

### 2. Two new `WillStatus` variants added

**What changed**

`WillStatus` gained two new variants in 0.1.1:

| Variant              | When set |
|----------------------|----------|
| `PendingConfirmation` | The will was created but the initial on-chain confirmation has not yet been processed. |
| `Settled`            | All balances have been fully distributed and the will record is closed. |

**Impact**

If your code contains an exhaustive `switch` or `if`/`else if` chain over
`WillStatus` values (e.g. to render a status badge in a UI), TypeScript will
now warn about unhandled cases when you upgrade — this is intentional, as
TypeScript's exhaustiveness checking surfaces the update requirement at
compile time.

**Migration**

Add handlers for the two new variants:

```ts
import { WillStatus } from '@sorowill/sdk';

function statusLabel(status: WillStatus): string {
  switch (status) {
    case WillStatus.PendingConfirmation:
      return 'Pending confirmation';
    case WillStatus.Active:
      return 'Active';
    case WillStatus.Triggered:
      return 'Triggered';
    case WillStatus.Released:
      return 'Released';
    case WillStatus.Cancelled:
      return 'Cancelled';
    case WillStatus.Settled:
      return 'Settled';
    // TypeScript will error here (never) if any variant is missing.
    // Add a default only if you intentionally want to ignore future variants:
    // default:
    //   return 'Unknown';
  }
}
```

---

## Type versioning policy

Starting with 0.1.1, every breaking change to a public interface or enum is
documented with:

1. A row in the **Change history** table on the affected type's JSDoc comment
   (see `src/types.ts`).
2. A `@since X.Y.Z` tag on each field added or changed after the initial
   release.
3. An entry in the `[Unreleased]` section of `CHANGELOG.md` under
   `### Changed` (breaking) or `### Added` (additive).
4. A section in this migration guide for any breaking change.

This makes it possible to determine which SDK version introduced a type change
by reading the source directly, without consulting external documentation.

---

## Changelog reference

See [CHANGELOG.md](./CHANGELOG.md) for a complete, version-by-version record
of all changes. Breaking changes are always listed under `### Changed` with
a clear description of the before/after behaviour.
