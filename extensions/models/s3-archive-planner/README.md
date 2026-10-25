# @svendowideit/s3-archive-planner

Plan an Australian photo/video archive on Amazon S3 before spending money on
uploads, Glacier transitions or restore drills.

> **AUD is a live conversion, not an AWS AUD price list.** AWS publishes the
> Price List API in USD only. The extension fetches the live USD catalog and a
> live USD/AUD rate; AUD figures can differ slightly from an AWS Australia
> invoice, where AWS applies its own exchange rate and GST treatment.

## What it does

Takes a source inventory (Google, NAS, old CDs/DVDs), an access profile and a
horizon, then models the monthly cost of several S3 plans: stay hot in Standard,
move to Standard-IA or Glacier, transition down a lifecycle ladder, upload
straight to Deep Archive, or keep a hot subset. It includes the costs people
usually miss — per-object metadata, 128 KiB minimums, 30/90/180-day minimum
durations, transition/restore requests, retrieval fees, restored-copy storage
and internet egress — plus the initial transfer and a SHA-256 verification plan.

Prices are live: the extension fetches the current AWS Price List in USD and a
live USD/AUD rate, then converts the whole catalog. Inputs accept `1.2b`, `500m`
and `90k` as well as plain numbers. It is a **planner**, not an ingest tool: no
AWS credentials, no S3 bucket calls, no uploads. It makes read-only HTTPS calls
to the AWS Price List API and a public FX source, and writes swamp data only.

## Install

```sh
swamp extension pull @svendowideit/s3-archive-planner
```

No extension dependencies. The live AWS Price List covers `ap-southeast-2`
(Sydney) and `ap-southeast-4` (Melbourne); AUD is converted from the live USD/AUD rate.

## Configuration

Set global arguments when creating the model:

| Argument | Type | Default | Description |
| -------- | ---- | ------- | ----------- |
| `region` | enum | `ap-southeast-2` | `ap-southeast-2` (Sydney) or `ap-southeast-4` (Melbourne). |
| `currency` | enum | `aud` | `aud` or `usd`. AUD is a live conversion from the AWS USD price list, not an AWS-published AUD price. |
| `pricingRefresh` | enum | `auto` | `auto` fetches when the cached catalog is stale; `always` fetches every run; `never` uses cache/bundled only. |
| `pricingMaxAgeHours` | number | `24` | How long a cached live catalog is reused in `auto` mode. |
| `audPerUsd` | number | unset | Optional manual AUD/USD override. Omit it to fetch the live rate. |
| `taxPercent` | number | `0` | Optional tax/GST percentage added to displayed totals (use `10` for Australian GST). |
| `uploadBandwidthMbps` | number | `100` | Default upload speed for transfer-time estimates. |
| `transferEfficiency` | number | `0.7` | Fraction of nominal bandwidth actually achieved. |
| `multipartThresholdBytes` | integer | `104857600` | Objects above this are assumed to use multipart upload. |
| `multipartPartSizeBytes` | integer | `67108864` | Assumed multipart part size. |
| `multipartObjectFraction` | number | `0` | Fraction of objects that are multipart; raise it for video-heavy libraries. |
| `priceOverrides` | object | `{}` | Flat `dot.path` to overrides **in the selected currency**, e.g. `{"storage.DEEP_ARCHIVE.tiers.0.perGbMonth":0.0019}`. |

`analyse` accepts these per-run inputs:

| Input | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `accessProfile` | enum | `occasional` | `cold` (0.1%/yr, bulk), `occasional` (1%/yr, standard), `family` (5%/yr, standard), `frequent` (20%/yr, standard) or `custom`. |
| `restoreFractionPerYear` | number | profile | Override restore volume as a fraction of stored bytes (0.01 = 1%). |
| `restoreTier` | enum | profile | `bulk`, `standard` or `expedited`. Deep Archive has no expedited tier and falls back to standard. |
| `restoreRetentionDays` | integer | profile | Days the temporary restored copy is kept (charged at the Standard rate). |
| `extraEgressGbPerMonth` | number | profile | Ordinary downloads per month in addition to restores. |
| `getRequestsPerMonth` | integer | profile | Ordinary GET requests per month (browsing). |
| `maxRestoreHours` | number | `48` | Plans slower than this are shown but excluded from the recommendation. |
| `years` | integer | `10` | Analysis horizon. |
| `planIds` | string[] | all plans | Limit the comparison to specific plan ids. |
| `egress` | boolean | `true` | Include internet egress for restores; set false for same-region restores. |
| `verificationSampleFraction` | number | `0.001` | Fraction of archive bytes restored in the sample drill. |
| `verificationSampleMinBytes` | number | `10737418240` | Minimum sample-drill size (10 GiB). |
| `s3ComputesChecksum` | boolean | `false` | Include S3's per-GB checksum computation fee. |
| `useBatchOperations` | boolean | `false` | Include one S3 Batch Operations pass in verification. |
| `priceOverrides` | object | `{}` | Method-level overrides in the selected currency; these win over the global overrides. |
| `inventoryOverride` | object | unset | One-off `sources`, `totalBytes`, `objectCount`, `avgObjectSizeBytes`, `duplicateFraction`, `annualGrowthPercent` or `initialTransferMonths` without re-recording the inventory. Byte/count values accept `1.2b`/`500m`/`90k` strings. |

## Examples

Create a planner and record a realistic mixed-source inventory:

```sh
# Use Sydney pricing and AUD output (the default). The live FX rate is fetched.
swamp model create @svendowideit/s3-archive-planner family-photos \
  --global-arg region=ap-southeast-2 --global-arg currency=aud

# Record Google Photos, NAS and DVD sources. bytes/objectCount accept k/m/b
# strings; duplicateFraction removes bytes already in another source.
swamp model method run family-photos inventory \
  --input 'sources:json=[{"name":"Google Photos","kind":"google","bytes":"1200b","objectCount":"450k","duplicateFraction":0.1},{"name":"NAS","kind":"nas","bytes":"2500b","objectCount":"800k"},{"name":"DVD archive","kind":"optical","bytes":"180b","objectCount":"90k","fixedCost":40}]'
```

Compare cold-archive and family-browsing access profiles:

```sh
# Cold archive: restore 0.1%/year, bulk (48h), accept up to 48h.
swamp model method run family-photos analyse \
  --input accessProfile=cold --input maxRestoreHours=48 --input years=10

# Family browsing: restore 5%/year, standard (12h), max 12h.
swamp model method run family-photos analyse \
  --input accessProfile=family --input maxRestoreHours=12 --input years=10
```

Try a one-off "what if" without changing the recorded inventory:

```sh
# Pretend the collection is 6 TB / 2 million objects, growing 8%/year.
swamp model method run family-photos analyse \
  --input 'inventoryOverride:json={"totalBytes":"6000b","objectCount":"2m","annualGrowthPercent":8}' \
  --input accessProfile=occasional --input years=15

# Override a price locally (for example, a negotiated Deep Archive rate).
swamp model method run family-photos analyse \
  --input 'priceOverrides:json={"storage.DEEP_ARCHIVE.tiers.0.perGbMonth":0.0019}' \
  --input accessProfile=cold
```

Inspect the effective pricing catalog and read the report:

```sh
# Force a fresh AWS/FX fetch and show the effective catalog for the region.
swamp model method run family-photos pricing --input refresh=true

# Render the latest analysis as markdown, including the verification plan.
swamp report get @svendowideit/s3-archive-report \
  --model family-photos --markdown
```

## Upgrade

This extension installs nothing on the host, so updating the package is the
whole upgrade:

```sh
swamp extension update @svendowideit/s3-archive-planner
```

Prices are fetched live, so an update does not freeze a price table. Re-run
`analyse` after updating; existing `inventory` and `analysis` data are
untouched. If you use a manual `audPerUsd` or local price overrides, check them
against `pricing` after an update.

## Details

### Model and methods

One model type, `@svendowideit/s3-archive-planner`, with three methods:

| Method | Purpose | Resource written |
| ------ | ------- | ---------------- |
| `inventory` | Record sources, bytes, objects, duplicates and growth. | `inventory/inventory` |
| `analyse` | Compare every plan, transfer cost and verification strategy for the stored inventory (or an `inventoryOverride`). | `analysis/analysis` |
| `pricing` | Fetch/show the live AWS USD catalog, live FX, and effective selected-currency catalog. | `pricing/pricing` and `pricing-cache/pricing-cache` |

`pricing-cache` holds the raw live USD catalog and FX rate with no per-run
overrides; `analyse` reuses it for `pricingMaxAgeHours`. The report
`@svendowideit/s3-archive-report` runs after `analyse` and renders the latest
`analysis/analysis` resource.

### Plans compared

- `standard` — everything hot in S3 Standard.
- `intelligent-tiering` — automatic Frequent/Infrequent/Archive Instant/Deep
  Archive Access tiers (archive tiers enabled).
- `intelligent-tiering-basic` — automatic tiering without the asynchronous
  archive tiers.
- `standard-ia`, `glacier-ir`, `glacier-flexible`, `deep-archive` — direct PUT
  to one class.
- `standard-30d-deep-archive`, `standard-180d-deep-archive`,
  `standard-365d-deep-archive` — hot window then archive.
- `standard-30d-sia-30d-deep-archive` — warm month after the hot month, then
  archive, respecting the 30-day Standard-IA minimum.
- `standard-90d-gir-90d-deep-archive` and
  `standard-90d-gfr-90d-deep-archive` — three months instant/Glacier access,
  then archive, respecting the 90-day minimums.
- `hybrid-10pct-standard-deep-archive` and
  `hybrid-10pct-sia-deep-archive` — keep a 10% hot/warm subset and archive the
  rest.

A plan that leaves a class before its minimum storage duration is marked invalid
and excluded from the recommendation. Direct PUT to Deep Archive is one-way;
the model says so rather than pretending a lifecycle rule can bring it back.

### How the costs are built

- **Storage** is modelled monthly over the horizon. Initial bytes are spread
  across `initialTransferMonths`; growth compounds annually. S3 Standard and
  Intelligent-Tiering Frequent Access use the published volume tiers. Other
  classes use their flat rate.
- **Per-object costs** are applied to every object: 128 KiB minimum for
  Standard-IA, One Zone-IA and Glacier IR; 40 KiB of metadata for Glacier
  Flexible and Deep Archive (8 KiB at Standard rates + 32 KiB at the class
  rate). A million small files can cost more than the headline $/GB.
- **Requests** include PUT, lifecycle transition, restore and GET requests.
  Multipart part requests are included when `multipartObjectFraction` is raised.
- **Retrieval** is allocated proportionally to the bytes stored in each class.
  Glacier Flexible/Deep Archive add the retrieval fee, the restore request and a
  temporary copy charged at the Standard rate. Internet egress is charged after
  the 100 GB/month free allowance.
- **Break-even** compares storage savings against the extra retrieval + egress
  cost per GB. It answers "how often could we restore before this hotter tier
  wins?" rather than just showing a single monthly number.
- **Packing** estimates the saving from combining small sidecars/thumbnails into
  ~1 GiB archives. It is recommended when the average object is under 1 MiB or
  the collection exceeds a million objects.

### Verification strategy

The `analyse` output and report contain a costed verification plan:

1. **Source SHA-256 manifest** — hash every file before upload (NAS/optical
   locally; Google Drive's `md5Checksum`/`sha256Checksum` where available,
   otherwise hash after Takeout download).
2. **Upload with checksums** — send `x-amz-checksum-sha256` so S3 stores a
   content checksum. Do not treat an ETag as the full-object hash for multipart
   uploads.
3. **S3 Inventory reconciliation** — compare keys, sizes and storage classes.
   Inventory is cheap and asynchronous, but it does not carry the checksum
   value.
4. **HEAD/metadata pass** — compare `ContentLength`, `ChecksumSHA256` and
   `StorageClass` per object. `HeadObject` works on Deep Archive without a
   restore.
5. **Sample restore drill** — restore a sample with bulk retrieval, download and
   compare SHA-256. This is the step that proves the archive and restore path
   return the original bytes.
6. **Full recovery drill (optional)** — restore the whole archive and compare;
   priced as a disaster-recovery rehearsal, not a routine check.

Confidence is reported as `exact` (SHA-256 match), `strong` (key + size + class)
or `weak` (key/size only). The model never describes size/date matching as a
byte-for-byte duplicate proof.

### Pricing sources and currency

**AWS publishes its Price List API in USD only.** There is no AUD price list for
the `aws` partition, so the extension fetches the live USD catalog and a live
USD/AUD rate, then converts every monetary field. The report names the FX source,
rate and date. It never uses a fixed compiled-in exchange rate.

This means AUD figures are **not an AWS-published AUD price** and can differ
slightly from an AWS Australia invoice, because AWS applies its own exchange
rate and GST treatment. For an exact reconciliation, compare the USD figures in
the report with the AWS invoice or the Price List API. The `usd` currency mode
avoids the conversion entirely.

The three live documents are:

- `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/ap-southeast-2/index.json`
- `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/ap-southeast-2/index.json`
- `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/ap-southeast-2/index.json`

The currency rate is tried in order from Frankfurter (ECB reference rates),
open.er-api.com and jsDelivr's currency-api. If all three fail, the extension
uses the last cached rate, or shows USD with a warning — it does not invent an
AUD rate. `audPerUsd` is an optional manual override for offline or deterministic
runs; when set, no FX request is made.

The catalog records its AWS `asOf` date and the local `fetchedAt` time.
`pricingRefresh=auto` (the default) reuses a cached catalog for
`pricingMaxAgeHours` (24h), then refreshes. `--input refresh=true` on `pricing`
forces a fresh fetch. `priceOverrides` are in the selected currency and are
applied after conversion. Prices exclude GST; set `taxPercent=10` for an
Australian GST-inclusive display.

### Input shorthand

`bytes`, `objectCount` and `avgObjectSizeBytes` accept a number or a string:

| Input | Value |
| ----- | ----- |
| `"450k"` | 450,000 |
| `"1.2m"` | 1,200,000 |
| `"1.2b"` | 1,200,000,000 |
| `"1,200,000"` | 1,200,000 |
| `1200000` | 1,200,000 |

Suffixes are case-insensitive; whitespace and commas are ignored. Invalid
strings fail with a message showing the accepted `450k` / `1.2m` / `1.2b`
forms. Object counts are rounded to whole objects.

### Assumptions and limits

- Average object size is used for every object. A library with a heavy tail of
  tiny files is better modelled by packing first or by using `inventoryOverride`
  with a realistic average.
- Restore volume is spread proportionally across stored classes. Real access is
  lumpier; use `accessProfile=custom` with a high `restoreFractionPerYear` for a
  worst-case view.
- Glacier Flexible and Deep Archive restores include the AWS per-GB Glacier
  restore fee (currently `$0.008/GB` in Sydney and Melbourne) in addition to the
  class retrieval fee. The restored copy is charged at the Standard rate for
  `restoreRetentionDays`.
- AUD figures are a live conversion of the AWS USD price list. They are not an
  AWS-published AUD price list and may differ slightly from the AWS Australia
  invoice because AWS applies its own conversion and GST treatment.
- Transfer time is an estimate from source throughput and upload bandwidth. It
  does not model Google Takeout queueing, ISP shaping or retries.
- The planner does not create buckets, lifecycle rules, inventory
  configurations or restore jobs. It produces the numbers and the plan; a later
  extension or workflow can execute it.
- S3 is durable, not a backup strategy by itself. The report recommends
  versioning, Object Lock and an independent copy for irreplaceable family
  media.

### Extending and testing

The code is split into:

- `pricing.ts` — bundled Australian fallback catalog and types. Add a region by
  cloning `baseCatalog()` and updating the `AuRegion` union and the model's
  `region` enum.
- `live_pricing.ts` — parses the live AWS Price List documents, fetches the
  live USD/AUD rate, and converts the catalog currency. The parser starts from
  the bundled catalog and only replaces fields it can find, recording warnings
  for usage-type changes.
- `s3_archive_planner.ts` — schemas, count parsing, pricing cache/resolution,
  pure cost/simulation functions and the model definition.
- `s3_archive_planner_report.ts` — markdown report.
- Colocated tests cover tier math, inventory dedupe, `k`/`m`/`b` parsing,
  minimum-duration validation, the Deep Archive vs Standard comparison, egress
  toggling, price overrides, live price-list parsing, FX fallback, AUD
  conversion, transfer estimates, verification evidence and report rendering.

Run the tests and type check with the Deno binary swamp ships:

```sh
~/.swamp/deno/deno test extensions/models/s3-archive-planner/s3_archive_planner_test.ts
~/.swamp/deno/deno test extensions/models/s3-archive-planner/s3_archive_planner_report_test.ts
~/.swamp/deno/deno check extensions/models/s3-archive-planner/s3_archive_planner.ts
```

To add a plan, append a `PlanSpec` to `PLAN_CATALOG` with sorted stages and a
matching test. To change the fallback prices, edit `pricing.ts`; live runs
override them from the AWS Price List API. No data migration is needed because
pricing is resolved at run time.
