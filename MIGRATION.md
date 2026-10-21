# Migration Guide

This guide documents every breaking change to the public `@sorowill/sdk` API
and explains how to update your code when upgrading between major or minor
versions that include breaking changes.

## Contents

- [How to upgrade the SDK](#how-to-upgrade-the-sdk)
- [Versioning: what counts as a breaking change](#versioning-what-counts-as-a-breaking-change)
- [Breaking changes by version](#breaking-changes-by-version)
- [Migrating from 0.1.0 → 0.1.1](#migrating-from-010--011)
- [Type versioning policy](#type-versioning-policy)
- [Template for future major-version sections](#template-for-future-major-version-sections)

---

## How to upgrade the SDK

Follow these steps whenever you move to a new version of `@sorowill/sdk`,
especially across a major version (or, while the SDK is pre-1.0, a minor
version):

1. **Check your current version.**

   ```bash
   npm ls @sorowill/sdk
   ```

2. **Read every section of this guide between your current version and the
   target version**, in order. Breaking changes are cumulative — upgrading from
   0.1.0 straight to a later release requires applying every intermediate
   migration.

3. **Pin the exact target version** rather than a range while you migrate, so a
   later release cannot slip in mid-upgrade:

   ```bash
   npm install @sorowill/sdk@0.1.1 --save-exact
   ```

4. **Run the TypeScript compiler.** Most breaking changes to public interfaces
   and enums surface as compile-time errors (for example, an exhaustive
   `switch` over `WillStatus` will fail when a new variant is added):

   ```bash
   npx tsc --noEmit
   ```

5. **Migrate persisted data.** Values you stored from a previous SDK version
   (in a database, `localStorage`, IndexedDB, or a serialized React state
   snapshot) are not migrated automatically. Each version section below lists
   any one-time data migrations under **Impact**. The SDK's own read cache
   (`ReadCache` with a persistence adapter) should be cleared after an upgrade
   so it is not hydrated with values shaped by the old version:

   ```ts
   import { ReadCache, IndexedDbCachePersistenceAdapter } from '@sorowill/sdk';

   const cache = new ReadCache({ persistence: new IndexedDbCachePersistenceAdapter() });
   await cache.ready();
   cache.clear(); // run once after upgrading
   ```

6. **Test against testnet before mainnet.** Construct a client with
   `SoroWillClient.forNetwork('testnet')` and exercise the flows your
   application relies on (create, check-in, trigger, release) before deploying
   the upgrade to production.

---

## Versioning: what counts as a breaking change

`@sorowill/sdk` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

| Version range | Breaking changes may appear in |
|---------------|--------------------------------|
| `0.x.y` (pre-1.0, current) | **minor** and, rarely, **patch** releases — always documented in this guide |
| `≥ 1.0.0` | **major** releases only |

Because the SDK is currently pre-1.0, depend on it with a tilde range
(`"~0.1.1"`) or an exact version rather than a caret range, so `npm install`
never pulls in a release with breaking changes without you reading this guide
first.

A change is treated as **breaking** (and gets a section in this guide) when it:

- removes or renames an exported function, class, method, type, or enum member;
- changes the meaning, unit, or scale of an existing field (e.g. the
  `Beneficiary.percentage` re-scaling in 0.1.1);
- adds a variant to an exported enum or union type that consumers may switch
  over exhaustively;
- makes a previously optional parameter required, or changes a parameter's
  type in a non-widening way;
- changes the resolved value or the thrown error class of a public method;
- raises the minimum supported Node.js version or changes the package's
  `exports` map.

A change is **not** breaking (and only appears in `CHANGELOG.md`) when it adds
a new export, adds an optional parameter or option, or adds an optional field
to a returned object.

---

## Breaking changes by version

| Upgrade | Breaking changes | Section |
|---------|------------------|---------|
| 0.1.0 → 0.1.1 | `Beneficiary.percentage` re-scaled from basis points to 0–100; `WillStatus` gained `PendingConfirmation` and `Settled` | [Migrating from 0.1.0 → 0.1.1](#migrating-from-010--011) |

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

### 3. Additive changes in 0.1.1 (no action required)

The following changes are backwards compatible. Existing code keeps working,
but you may want to adopt them:

```ts
// Optional per-call timeout on every public method.
await client.checkIn(willId, { timeoutMs: 15_000 });

// Optional pagination on list reads. Without options the result is still Will[].
const page = await client.getWillsByOwner(owner, { pageSize: 10 });

// The wallet adapter is now configurable; Freighter remains the default.
const client = new SoroWillClient({ contractId, network: 'testnet', wallet: myAdapter });
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

## Template for future major-version sections

Every future release that contains breaking changes adds a section above this
one, using the following structure, and a row to the
[Breaking changes by version](#breaking-changes-by-version) table:

````md
## Migrating from X.Y.Z → A.B.C

### 1. <Short description of the breaking change>

**What changed**

What the old behaviour was, what the new behaviour is, and why.

**Impact**

Who is affected (e.g. code reading a field, persisted data, exhaustive
switches) and how the breakage shows up (compile error, runtime error,
silently different value).

**Migration**

```ts
// Before (SDK X.Y.Z)
...

// After (SDK ≥ A.B.C)
...
```
````

---

## Changelog reference

See [CHANGELOG.md](./CHANGELOG.md) for a complete, version-by-version record
of all changes. Breaking changes are always listed under `### Changed` with
a clear description of the before/after behaviour.
