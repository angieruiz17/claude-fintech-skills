---
name: bloomberg-data
description: Access Bloomberg market data (BDP, BDS, BLPAPI, BPIPE) for FinTech applications, with reference patterns for ZAR IRS tickers and DV01 / nominal conversion.
---

# Bloomberg Data Access

Reference for accessing Bloomberg market data programmatically and via Excel, with the four practical integration patterns and their trade-offs. Examples use ZAR IRS tickers, but the patterns apply to any interest-rate desk.

## ZAR IRS reference tickers

| Instrument        | Bloomberg ticker     | Field           | Use                            |
|-------------------|----------------------|-----------------|--------------------------------|
| USD/ZAR spot      | `ZAR Curncy`         | `LAST_PRICE`    | USD to ZAR nominal conversion  |
| Swap 1Y - 30Y     | `SASW{N} Curncy`     | `SW_CNV_RISK`   | DV01 (RPP = `SW_CNV_RISK * 100`) |
| JIBAR 3M          | `SA JIBAR 3M`        | `LAST_PRICE`    | IBOR reference                 |
| ZARONIA           | `ZARONIA`            | `LAST_PRICE`    | OIS reference rate             |
| ZARONIA OIS curve | `SAOIAAA` - `SAOIAA30` (BGN Curncy) | `LAST_PRICE` | Curve points |

The same pattern applies to other currencies: `EUSW{N} Curncy` (EUR IRS), `USSW{N} Curncy` (USD IRS), `BPSW{N} Curncy` (GBP), etc.

## USD-to-currency nominal formula (IRS)

For interest-rate swaps where the trade is priced in USD DV01 terms but settled in local currency:

```
LocalCcy_Nominal = (USD_Nominal * USD_LocalCcy_Spot / RPP) * 1,000,000

where:
  RPP            = BDP("<currency>SW{N} Curncy", "SW_CNV_RISK") * 100
  USD_LocalCcy_Spot = BDP("<LocalCcy> Curncy", "LAST_PRICE")
```

Important caveats:

- `SW_CNV_RISK` is Bloomberg's convexity-adjusted risk; for production pricing prefer your own curve-based DV01 (QuantLib, Murex, your front-office system).
- Conventions differ by counterparty: confirm RPP semantics with your sales / quant team before going live.

## Four ways to pull Bloomberg data

### 1. Excel BDP / BDS

```
=BDP("SASW5 Curncy", "SW_CNV_RISK")     -> 3.915
=BDP("ZAR Curncy",   "LAST_PRICE")      -> 18.50
=BDS("SPX Index",    "INDX_MEMBERS")    -> table of members
```

Pros: zero setup if the trader already has a Bloomberg terminal, perfect for prototyping.
Cons: not callable from a server; locked to the workstation; manual refresh; opaque audit trail.

### 2. BLPAPI (Bloomberg API, Python or C++)

```python
import blpapi

session = blpapi.Session()
session.start()
session.openService("//blp/refdata")

service = session.getService("//blp/refdata")
request = service.createRequest("ReferenceDataRequest")
request.getElement("securities").appendValue("SASW5 Curncy")
request.getElement("fields").appendValue("SW_CNV_RISK")
session.sendRequest(request)
# ... event loop to read response messages
```

Pros: scriptable, repeatable, can run in any process on the workstation.
Cons: still tied to a logged-in terminal session; rate-limited; not suitable for headless servers.

### 3. BPIPE (Bloomberg Professional Interface Protocol)

Server-side licensed access. Required as soon as you need:

- A headless service that pulls market data 24/7
- Many concurrent symbol subscriptions (subscription tier, not refdata)
- A redundant connection from a data centre, independent of any terminal user

Order of magnitude: low five figures USD per year per connection, scaling with concurrent symbol count and entitlements. Talk to your Bloomberg sales contact for accurate sizing.

### 4. Indirect capture via an Excel add-in

If a trader's Excel workbook already pulls everything you need via BDP, you can write a custom Excel add-in (Excel-DNA in C#, or VSTO) that:

1. Reads the cells of interest on each tick
2. Validates and timestamps the value
3. Pushes it to your back-end (HTTPS, Kafka, ZeroMQ, ...)

Pros: zero additional Bloomberg licence (uses the trader's existing terminal entitlements), most pragmatic when starting from a manual workflow.
Cons: requires the workbook to stay open, sensitive to layout changes, needs a watchdog if the trader closes Excel.

## Choosing an integration strategy

| Phase       | Mids                          | DV01                    | FX                  |
|-------------|-------------------------------|-------------------------|---------------------|
| MVP / PoC   | Manual entry                  | Manual entry            | Manual entry        |
| Phase 2     | Excel add-in -> back-end      | Excel add-in            | Excel add-in (BDP)  |
| Production  | BPIPE subscription            | Internal curve / API    | BLPAPI / BPIPE      |

Start manual. Add the Excel-add-in path only when manual entry becomes a friction point. Move to BPIPE only when you have a real need for headless, redundant access.

## Bloomberg page publishing

Trading desks routinely publish indicative prices on Bloomberg pages (e.g. `GDCO`, `BTMM`, ...). Publication is done via the native Bloomberg Excel plug-in, free with the terminal entitlement.

This is **separate** from any matching / contribution back-end you build: the prices on Bloomberg pages are typically the mids your desk wants to advertise to clients, not the engine's internal book.

## Checklist before integrating

- [ ] Confirm DV01 / nominal formula with your sales or quant team
- [ ] Decide MVP source (manual vs add-in vs BLPAPI) based on operational constraints
- [ ] Map the exact tickers and fields per maturity and per currency
- [ ] Plan for ticker rotation (curve points refresh, IMM roll, etc.)
- [ ] Build a fallback path: stale-data detection, last-known-good cache, alerting
- [ ] Verify entitlements: refdata vs subscription, terminal vs BPIPE
- [ ] Stress-test latency: cold cache, network blip, terminal restart
