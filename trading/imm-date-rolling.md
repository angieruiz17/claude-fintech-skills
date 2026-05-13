---
name: imm-date-rolling
description: Handle IMM-date rolling in interest-rate platforms (3rd Wednesday Mar/Jun/Sep/Dec, parsing pitfalls, resolved-to-relative mapping, automatic rotation).
---

# IMM Date Rolling

Conventions and engineering details for handling **IMM dates** (International Monetary Market settlement dates) in trading platforms, market-data feeds, and pricing engines.

## Definition

An **IMM date** is the **third Wednesday** of March, June, September, or December. It is the standard expiry convention for STIR futures (Eurodollar, SOFR, EURIBOR, JIBAR) and the start date for forward-starting swaps.

Example IMM dates:

| Quarter   | Date           |
|-----------|----------------|
| Mar 2026  | 18-Mar-2026    |
| Jun 2026  | 17-Jun-2026    |
| Sep 2026  | 16-Sept-2026   |
| Dec 2026  | 16-Dec-2026    |
| Mar 2027  | 17-Mar-2027    |
| Jun 2027  | 16-Jun-2027    |
| Sep 2027  | 15-Sept-2027   |
| Dec 2027  | 15-Dec-2027    |

## Resolved vs relative notation

Two ways to refer to an IMM swap:

- **Resolved**: full date plus tenor, e.g. `17-Jun-2026_5y`. Source feeds typically emit this form.
- **Relative**: ordinal index, e.g. `1IMM_5y`, `2IMM_5y`, `3IMM_5y`. Convenient for back-end storage because the set of keys is stable across rotations.

A pricing engine often stores **relative** keys internally and resolves them to dates only at the UI layer. This avoids rewriting the schema every quarter.

## Parsing the wire format

Robust regex that accepts both `dd-mmm-yyyy_Xy` and `dd-mmm-yy_Xy`:

```python
import re

IMM_PATTERN = re.compile(r'^(\d{1,2})-([A-Za-z]{3,4})-(\d{2,4})_(\d+y)$')

MONTH_MAP = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}
```

Note the **four-letter `sept`** alongside `sep`: many financial data vendors abbreviate September as `Sept`, not `Sep`. If you hardcode three-letter parsing you silently lose all September rows.

## Resolved -> relative conversion

```python
from datetime import datetime

def resolve_imm_relative(mids: dict, dv01: dict | None = None):
    """Replace resolved IMM dates with ordinal IMM indices.

    Input keys like '17-Jun-2026_5y' are remapped to '1IMM_5y' (oldest = 1IMM).
    Non-IMM keys (forward-forwards, custom slots, spot) are preserved as-is.
    """
    dates_seen = {}
    for key in mids:
        dt, _tenor = parse_imm_key(key)
        if dt:
            date_token = key.rsplit('_', 1)[0]
            dates_seen[date_token] = dt

    if not dates_seen:
        return mids, dv01

    sorted_dates = sorted(dates_seen.items(), key=lambda x: x[1])
    date_to_relative = {tok: f"{idx + 1}IMM" for idx, (tok, _) in enumerate(sorted_dates)}

    new_mids, new_dv01 = {}, {}
    for key, value in mids.items():
        dt, tenor = parse_imm_key(key)
        if dt and tenor:
            relative = date_to_relative[key.rsplit('_', 1)[0]]
            new_key = f"{relative}_{tenor}"
            new_mids[new_key] = value
            if dv01 and key in dv01:
                new_dv01[new_key] = dv01[key]
        else:
            new_mids[key] = value
            if dv01 and key in dv01:
                new_dv01[key] = dv01[key]
    return new_mids, new_dv01
```

## TypeScript helper for the UI

When the front-end needs to show resolved dates rather than relative labels:

```typescript
function getCurrentImmDates(count: number = 3): Date[] {
  const today = new Date();
  const dates: Date[] = [];
  let year = today.getFullYear();
  let month = today.getMonth();   // 0-based

  while (dates.length < count) {
    while (![2, 5, 8, 11].includes(month)) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    const firstOfMonth = new Date(year, month, 1);
    const firstDow = firstOfMonth.getDay();   // 0 = Sun, 3 = Wed
    const firstWed = firstDow <= 3 ? 1 + (3 - firstDow) : 1 + (3 + 7 - firstDow);
    const thirdWed = firstWed + 14;
    const immDate = new Date(year, month, thirdWed);
    if (immDate > today) dates.push(immDate);
    month++;
    if (month > 11) { month = 0; year++; }
  }
  return dates;
}

function formatImmDateLabel(d: Date): string {
  const day = d.getDate().toString().padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[d.getMonth()]}-${d.getFullYear().toString().slice(-2)}`;
}
```

## Known pitfalls

### `Sept` vs `Sep`

Some vendors use the four-letter abbreviation `Sept` for September. Always include both in your month map.

### Two-digit vs four-digit year

Same vendor, different files may emit `dd-mmm-yy` or `dd-mmm-yyyy`. Defensive parsing:

```python
year = int(year_str)
if year < 100:
    year += 2000
```

### Spot swap is not an IMM

If today happens to be a Wednesday in `Mar/Jun/Sep/Dec`, a row dated today is **spot**, not an IMM. Validate that the date is the third Wednesday of an IMM month before treating it as one:

```python
def is_imm_date(dt: datetime) -> bool:
    return (dt.month in (3, 6, 9, 12)
            and dt.weekday() == 2
            and 15 <= dt.day <= 21)
```

### Mid-session rotation

If a session straddles an IMM date (rare on intraday sessions, common on overnight or multi-day sessions), the feed will start emitting the **next** set of dates. Decide whether your snapshot should:

- freeze the relative labels and ignore the new dates until session end, or
- accept the rolled feed and update the labels live.

Both are valid; pick one and document it. Mixed behaviour leads to subtle reconciliation bugs.

### Don't reimplement rotation client-side

If your upstream data feed already rolls its IMM set every quarter, just consume what it sends. Building a client-side rotation engine that races the feed is a guaranteed source of off-by-one bugs.

## Sanity check table

When debugging, compute against a known-good reference set:

| Quarter   | 3rd Wednesday  |
|-----------|----------------|
| Mar 2026  | 18-Mar-2026    |
| Jun 2026  | 17-Jun-2026    |
| Sep 2026  | 16-Sept-2026   |
| Dec 2026  | 16-Dec-2026    |
| Mar 2027  | 17-Mar-2027    |
| Jun 2027  | 16-Jun-2027    |
| Sep 2027  | 15-Sept-2027   |
| Dec 2027  | 15-Dec-2027    |
| Mar 2028  | 15-Mar-2028    |
