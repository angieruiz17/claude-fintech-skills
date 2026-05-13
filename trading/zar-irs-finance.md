---
name: zar-irs-finance
description: Quick reference for ZAR IRS / OIS calculations -- spreads in basis points, DV01 / PV01, USD-to-ZAR nominal conversion, FRA and forward-forward conventions, ZARONIA specifics, butterfly pricing.
---

# ZAR IRS Finance Reference

Working notes for building or operating any interest-rate platform on the ZAR (South African rand) curve: JIBAR swaps, ZARONIA OIS, FRAs, forward-forwards, IMMs, butterflies.

The same formulas apply to other EM rates curves with the obvious substitutions (currency, IBOR, OIS, calendar).

## Spreads in basis points

```
spread_bp = (mid_long - mid_short) * 100

Example: mid(5y) = 7.31%, mid(10y) = 7.8875%
         spread_bp = (7.8875 - 7.31) * 100 = 57.75 bp
```

UI rule: **always display in bp, not percent**. `57.75 bp`, not `0.58 %`. Tick size on most ZAR IRS desks is `0.25 bp`.

## Stretch

A "stretch" defines the three tradable prices around a mid (often low / mid / high or bid / mid / ask).

```
low  = mid - (stretch / 100)    # mid is in percent, stretch in basis points
high = mid + (stretch / 100)

Example, stretch = 1 bp, mid = 7.50 %:
  low = 7.49, mid = 7.50, high = 7.51
```

Typical values:
- JIBAR swaps / FRAs : 1 bp
- ZARONIA OIS : 3 bp
- Custom slots : 0.5 bp / 0.25 bp possible

For spreads, the stretch is normally the same as the outright at the wide end, but you may want to separate them in production.

## DV01 / PV01

DV01 ("Dollar Value of 01") is the change in present value for a 1 bp move in the relevant curve. For ZAR swaps, DV01 is normally quoted as PV01 in USD per million notional per basis point.

Approximate **PV01 / MM (USD)** table, useful for sizing UI without a live curve:

```
 1y:   96     6y:   492    12y:   797
 2y:  186     7y:   555    15y:   895
 3y:  271     8y:   613    20y:  1006
 4y:  350     9y:   666    25y:  1077
 5y:  424    10y:   714    30y:  1124
```

These are illustrative. The real values come from your curve under your conventions (ACT/365 FIXED, MOD FOLLOWING, ZAJO calendar) and should be refreshed from your pricer.

## USD-to-ZAR nominal conversion (DV01-matched)

```
ZAR_notional = USD_notional * FX * 1_000_000 / PV01_USD
```

Example: trader wants USD 5,000 of risk on the 5y, FX = 16.21:
```
ZAR_notional = 5000 * 16.21 * 1_000_000 / 424 = 191,155,660  (~ZAR 191 M)
```

**Common bug to avoid**: the inverted formula `USD * FX * PV01 / 1000` gives values orders of magnitude off (you'd get ZAR ~34k instead of ZAR ~191 M). When in doubt, do a unit check:

```
[USD] * [ZAR/USD] * [1M / unit] / [USD per bp per MM]
= [USD] * [ZAR/USD] * [USD / (USD per bp per MM)]
= [ZAR] * [MM per bp]
which scales properly to a ZAR notional when applied for a 1 bp move
```

## FRA tenors

Format `start x end`, in months from spot:

```
0x3, 1x4, 2x5, 3x6, 4x7, 5x8, 6x9, 7x10,
8x11, 9x12, 10x13, 11x14, 12x15, 15x18, 18x21, 21x24
```

Same pattern in EUR (EURIBOR FRAs), USD (LIBOR / SOFR FRAs), GBP (SONIA), etc.

## Forward-forwards

Format `start_y x swap_y`: an A-year-into-B-years swap.

```
1y1y    1y swap starting in 1y
1y3y    3y swap starting in 1y
5y5y    5y swap starting in 5y
```

Typical presets: `1y1y, 2y2y, 1y2y, 1y3y, 5y5y`. Any combination is usually accepted as custom.

## ZARONIA (ZAR Overnight Index Average)

```
Maturities       : 1y, 2y, 3y, 4y, 5y, 6y, 7y, 8y, 9y, 10y, 12y, 15y, 20y, 25y, 30y
Term maturities  : 1M to 24M
Default stretch  : 3 bp (vs 1 bp for JIBAR swaps / FRAs)
Floating rate    : ZARONIA (overnight, 1D fixing)
Day count        : ACT/365 FIXED
Convention       : MOD FOLLOWING
Holiday centre   : ZAJO (Johannesburg)
```

## IMM dates

IMM = third Wednesday of March, June, September, December. See [`imm-date-rolling`](imm-date-rolling.md) for full handling (parsing, resolved-to-relative conversion, rotation pitfalls).

## ZAR IRS conventions reference

| Parameter           | Value                          |
|---------------------|--------------------------------|
| Floating rate       | ZAR-JIBAR (3M) or ZARONIA (1D) |
| Day count           | ACT / 365 FIXED                |
| Business convention | MOD FOLLOWING                  |
| Holiday centre      | ZAJO (Johannesburg)            |
| Clearing house      | LCH.Clearnet Limited           |
| ISDA definitions    | ISDA 2021                      |
| Execution venue     | OTF                            |
| Settlement currency | ZAR                            |

## Butterflies (3-leg)

Format `short - belly - long`, e.g. `3y-5y-7y`.

```
fly_price_bp = (2 * belly_mid - short_mid - long_mid) * 100

Example: 3y = 7.005, 5y = 7.16, 7y = 7.395
         fly_bp = (2 * 7.16 - 7.005 - 7.395) * 100 = -8 bp
```

Sizing convention is nominal-weighted **1:2:1** (wings half each, belly twice the wings).

Eligible products: swaps and OIS curves with a continuous tenor structure. Avoid FRAs, IMMs, FwdFwds, or term maturities -- the 2:1:1 relationship breaks down.

Execution model in a multilateral platform:

- 1 parent trade with the fly identity (legs + price)
- 3 leg trades (short, belly, long), each at the frozen mid for that maturity
- Legs linked to the parent via a `parent_trade_id` foreign key
- Partial fills must preserve the 1:2:1 ratio across all three legs

Wash-trade rule: same entity on the buy and sell side of the same fly is rejected. Same applies to outrights and spreads.

## Matching rules to keep in mind

| Rule                       | Typical value                            |
|----------------------------|------------------------------------------|
| Minimum outright           | 5,000 USD DV01-equivalent                |
| Minimum spread             | 10,000 USD                               |
| Minimum fly unit           | 5k wings / 10k belly (1:2:1)             |
| Wash trade                 | reject same-entity buy + sell            |
| Stale same-bank conflict   | reject opposite same-bank stale orders   |
| Priority                   | Price-Time, FIFO, sequence ASC           |
| Residual after partial     | promote to traded level, not original    |
| Dark pool directional info | never expose B / S indicators            |

The exact minimums depend on the desk and the regulator; treat the numbers above as a sanity-check baseline.
