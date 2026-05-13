---
name: financial-dates
description: Compute financial dates (IMM, FRA tenors, forward-forward swaps) and parse market conventions for interest-rate products.
---

# Financial Dates and Tenor Parsing

Guides the computation of financial dates and the parsing of standard market conventions (IMM, FRA, forward-forward, swap maturities), with a reference implementation in Python.

## When to use

- Building a pricer, a matching engine, or a contribution feed for interest-rate products
- Generating a rolling list of IMM expiries (futures, forward-starting swaps)
- Parsing market quotes expressed as FRA tenors (`0x3`, `1x4`, ...) or forward-forward (`1y3y`, `5y5y`, ...)
- Adjusting cashflow dates to business days (Modified Following)
- Generating the full combinatorics for a spread grid

## IMM dates (International Monetary Market)

IMM dates are the **third Wednesday** of March, June, September and December. They are the standard expiry convention for STIR futures (Eurodollar, SOFR, EURIBOR, JIBAR) and for forward-starting swaps.

```python
from datetime import date, timedelta

def third_wednesday(year: int, month: int) -> date:
    """Return the third Wednesday of the given month."""
    first = date(year, month, 1)
    days_until_wed = (2 - first.weekday()) % 7   # 0=Mon, 2=Wed
    first_wed = first + timedelta(days=days_until_wed)
    return first_wed + timedelta(days=14)

def next_imm_dates(from_date: date, count: int = 4) -> list[date]:
    """Return the next `count` IMM dates strictly after `from_date`."""
    imm_months = [3, 6, 9, 12]
    dates = []
    year = from_date.year
    while len(dates) < count:
        for month in imm_months:
            imm = third_wednesday(year, month)
            if imm > from_date:
                dates.append(imm)
                if len(dates) == count:
                    break
        year += 1
    return dates
```

**Typical platform rules**

- Display the next 4 IMM expiries at all times
- Exclude the spot date (today is never an IMM)
- Roll automatically when an expiry passes
- Map relative labels (`1IMM`, `2IMM`, `3IMM`, `4IMM`) to actual dates

**Example as of 8 April 2026:**
```
IMM 1: 17 Jun 2026
IMM 2: 16 Sep 2026
IMM 3: 16 Dec 2026
IMM 4: 17 Mar 2027
```

## FRA tenors (Forward Rate Agreements)

Convention `AxB`: A = start month, B = end month, both measured from spot.

```
0x3    FRA starting now, ending in 3 months
1x4    FRA starting in 1 month, ending in 4 months
9x12   FRA starting in 9 months, ending in 12 months
```

A typical set of 16 FRA tenors used on ZAR / EM rates desks:
```
0x3, 1x4, 2x5, 3x6, 4x7, 5x8, 6x9, 7x10, 8x11, 9x12,
10x13, 11x14, 12x15, 15x18, 18x21, 21x24
```

```python
def parse_fra_tenor(tenor: str) -> tuple[int, int]:
    """Parse a FRA tenor into (start_month, end_month)."""
    parts = tenor.lower().split('x')
    return int(parts[0]), int(parts[1])

def fra_tenor_to_dates(tenor: str, spot_date: date) -> tuple[date, date]:
    """Convert a FRA tenor to (start, end) dates, business-day adjusted."""
    start_m, end_m = parse_fra_tenor(tenor)
    start_date = add_months(spot_date, start_m)
    end_date = add_months(spot_date, end_m)
    return adjust_business_day(start_date), adjust_business_day(end_date)
```

## Forward-forward swaps

Convention `AyBy`: a swap of B years starting in A years from spot.
```
1y1y   1-year swap starting in 1 year
1y3y   3-year swap starting in 1 year
5y5y   5-year swap starting in 5 years
```

```python
import re

def parse_fwdfwd(tenor: str) -> tuple[int, int]:
    """Parse a forward-forward tenor into (start_years, swap_years)."""
    match = re.match(r'(\d+)y(\d+)y?', tenor.lower())
    if not match:
        raise ValueError(f"Invalid forward-forward tenor: {tenor}")
    return int(match.group(1)), int(match.group(2))

def fwdfwd_to_dates(tenor: str, spot_date: date) -> tuple[date, date]:
    start_y, swap_y = parse_fwdfwd(tenor)
    start_date = add_years(spot_date, start_y)
    end_date = add_years(start_date, swap_y)
    return adjust_business_day(start_date), adjust_business_day(end_date)
```

Common presets used as quick-access slots: `1y1y, 2y2y, 1y2y, 1y3y, 5y5y`. Beyond presets, any `AyBy` combination is generally accepted as a custom slot.

## Swap maturities

Convention `Xy`: an X-year swap from spot. A typical full set for ZAR IRS / OIS:

```python
SWAP_MATURITIES = [
    "1y", "2y", "3y", "4y", "5y", "6y", "7y", "8y", "9y",
    "10y", "12y", "15y", "20y", "25y", "30y"
]

# Overnight Index Swap (OIS), e.g. ZARONIA, SOFR, ESTR
OIS_OUTRIGHT_MATURITIES = SWAP_MATURITIES
OIS_TERM_MATURITIES = [f"{m}m" for m in range(1, 25)]   # 1M to 24M
```

## Business calendar and Modified Following

```python
# South African public holidays (illustrative, refresh annually from SARB / SABO).
ZA_HOLIDAYS_2026 = [
    date(2026, 1, 1),    # New Year's Day
    date(2026, 3, 21),   # Human Rights Day
    date(2026, 4, 3),    # Good Friday
    date(2026, 4, 6),    # Family Day
    date(2026, 4, 27),   # Freedom Day
    date(2026, 5, 1),    # Workers' Day
    date(2026, 6, 16),   # Youth Day
    date(2026, 8, 9),    # National Women's Day
    date(2026, 9, 24),   # Heritage Day
    date(2026, 12, 16),  # Day of Reconciliation
    date(2026, 12, 25),  # Christmas Day
    date(2026, 12, 26),  # Day of Goodwill
]

def is_business_day(d: date, holidays: list[date] | None = None) -> bool:
    if d.weekday() >= 5:
        return False
    if holidays and d in holidays:
        return False
    return True

def adjust_business_day(d: date, convention: str = "modified_following",
                        holidays: list[date] | None = None) -> date:
    """Apply business-day convention. Modified Following: roll forward,
    but roll backward if the rolled date crosses into the next month."""
    if convention != "modified_following":
        return d
    adjusted = d
    while not is_business_day(adjusted, holidays):
        adjusted += timedelta(days=1)
    if adjusted.month != d.month:
        adjusted = d
        while not is_business_day(adjusted, holidays):
            adjusted -= timedelta(days=1)
    return adjusted
```

For production: use `python-holidays`, `workalendar`, or a vendored calendar from your data provider (Bloomberg `CDR`, LSEG `Calendar`) instead of hardcoding.

## Spread grid combinatorics

```python
def generate_spread_grid(maturities: list[str]) -> list[tuple[str, str]]:
    """All ordered pairs (short, long) with short < long in the maturity list."""
    return [
        (short, long)
        for i, short in enumerate(maturities)
        for long in maturities[i + 1:]
    ]

def spread_label(short: str, long: str) -> str:
    """Format a spread label, e.g. ('2y', '5y') -> '2v5yr'."""
    s = short.replace('y', '')
    l = long.replace('y', '')
    return f"{s}v{l}yr"

# 15 maturities -> 105 spread combinations
```

## Validation

```python
def validate_maturity(maturity: str, product: str) -> bool:
    if product == "swaps":
        return maturity in SWAP_MATURITIES
    if product == "fra":
        return maturity in FRA_TENORS
    if product == "imm":
        return True   # validated by next_imm_dates()
    if product == "fwdfwd":
        return bool(re.match(r'^\d+y\d+y$', maturity))
    if product == "ois-outrights":
        return maturity in OIS_OUTRIGHT_MATURITIES
    if product == "ois-terms":
        return maturity in OIS_TERM_MATURITIES
    return False
```

## Checklist before shipping

- [ ] IMM date computation correct (third Wednesday, N futures, automatic roll)
- [ ] FRA tenor parsing covers your full set (e.g. `0x3` through `21x24`)
- [ ] Forward-forward parsing accepts arbitrary `AyBy`
- [ ] Business calendar sourced from a maintained provider, not hardcoded
- [ ] Modified Following adjustment respects month boundaries
- [ ] Spread grid generation matches the trader-facing UI
- [ ] Unit tests on each date function, with month-end and holiday edge cases
