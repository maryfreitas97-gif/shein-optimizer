# SHEIN cart-split optimizer

A read-only planner. You paste in a cart, it prints a plan for splitting that
cart across several orders so the coupons, shipping thresholds and card offers
land as cheaply as possible. You place the orders by hand.

## Hard constraints — do not violate these

- **The hosted `index.html` must keep working on iPad Safari with manual
  entry.** No Xcode, no build tooling. Everything runs as plain files. No npm
  install, no bundler, no transpile step.
- **The Chrome extension is a desktop add-on on top of the hosted page,**
  never a replacement for it. Its side panel embeds the hosted `index.html`;
  nothing in `index.html` may depend on the extension being present. On iPad
  the capture path stays an iOS Shortcut or a bookmarklet.
- **Read-only.** Never automate checkout, never modify the cart, never log in.
  The extension reads the cart and never modifies it or touches checkout.
  The output is a plan the user executes manually.
- **No login, no server, no analytics.** The only permitted network calls are the
  CDN fetch for the LP solver and, in the extension, loading the hosted page
  itself. Everything else is local.
- `index.html` is **one self-contained file**: inline CSS, inline JS. CDN
  dependencies are allowed; local sibling files are not (except the parser).
  The extension's own files live outside it.
- The solver must be **pure JS, not WASM** — `javascript-lp-solver`. WASM
  builds are unreliable in iPad Safari.
- The page must keep working after first load and be add-to-Home-Screen
  friendly. If the CDN is unreachable, degrade to local search rather than fail.
- Target: an optimize run finishes **under 3 seconds** on an A-series iPad.

## Deliverables and build order

1. `index.html` — manual entry, optimizer, output. **Done (v0.1.0).**
2. `parsers/shein.js` — swappable extractor, mapped from a real capture.
   Category names and flash/clearance flags stay TODO until confirmed.
   **Done (v0.2.0)**, with input mode C wired into `index.html`.
2b. Chrome extension (`manifest.json` at the repo root, code in
   `extension/`). **Done (v0.2.0).**
2c. Coupon import from My Coupons, mapped from a real saved page, with
   tiers and store scope in the model. **Done (v0.3.0).** Pending: confirm
   which cart field carries the store name that store coupons use.
3. `shortcut.md` — iOS Shortcut steps, including the exact JS for the
   "Run JavaScript on Web Page" action (async, returns via `completion()`),
   triggered from the Safari share sheet.
4. `bookmarklet.md` — `javascript:` URL alternative plus iPad Safari install steps.
5. `README.md` — GitHub Pages deploy, and how to fix the parser when it breaks.

Ship each step before starting the next.

## Input modes

- **A. Manual entry / editable table.** The guaranteed fallback. Built.
- **B. Paste raw cart page text.** Heuristic parse. Not built.
- **C. Paste JSON captured by the Shortcut or bookmarklet.** Built. The
  extension's "Import from this SHEIN tab" button goes through the same
  `importPayload()` code path.

Captures are routed by `SheinParser.detect()`: a cart capture replaces the
item table; a My Coupons capture is merged into the coupons by code, keeping
the user's on/off and stacking choices. The extension's one button imports
whichever of the two pages is open.

All three land in the same editable table, and the table stays editable after
any import. Import takes items ticked for checkout by default, with a setting
for all lines.

## Chrome extension

- `manifest.json` sits at the repo root so the extension can load
  `parsers/shein.js` without a copy. The folder to load unpacked is the repo
  root.
- MV3 extension pages forbid inline and CDN scripts, so the side panel
  (`extension/panel.html`) is a thin shell that frames the hosted
  `index.html` from GitHub Pages.
- It reads the embedded page data by running `SheinParser.capture()` in the
  tab's MAIN world on click. It never intercepts or replays requests.
- Only `capture()`'s output (cart lines and totals) crosses from the page to
  the panel. Address, member id and tokens never leave the tab.
- Panel ↔ page messages are tagged and origin-checked on both sides.
- Permissions stay minimal: `sidePanel`, `scripting`, host access to
  `*.shein.com` only.
- Raw captures contain personal data and are gitignored. Never commit one.

## Parser rule

Do **not** guess SHEIN's DOM selectors or API shape. `parsers/shein.js` is
written against a documented internal format, with a capture step that dumps
the raw payload. The mapping gets written only after a real payload is pasted
back. All SHEIN-specific code stays in that one file.

## Data model

```
Item        {id, name, price, qty, category, brand, store,
             flags:{flashSale, clearance, bundle}}

Coupon      {id, code, label,
             payoff:"fixed"|"percent"|"cheapestFree"|"freeShipping",
             value, maxDiscount|null,
             minSpend, minItems, tiers[{minSpend, value}],
             includeCategories[], excludeCategories[], includeStores[],
             appliesToDiscountedItems, singleUse, stackableWith[],
             expires, uncertain, notes, enabled}

CardOffer   {id, label, minSpend, cashback, perTransaction, maxUses, enabled}

ShippingRule {freeThreshold, flatFee, perOrder:true, measure:"after"|"before"}
```

A coupon is a **gate** plus a **payoff**, not a type.

- Gate — both optional, both must pass if set: `minSpend` on the eligible
  subtotal, `minItems` on the eligible item count.
- Payoff — exactly one: `fixed` (value dollars off), `percent` (value% of the
  eligible subtotal, capped by `maxDiscount`), `cheapestFree` (the `value`
  cheapest eligible units are free), `freeShipping` (waives shipping on that
  order).

- Tiers — optional, `fixed` and `percent` only. `tiers[]` lists the levels
  above the base `minSpend`/`value` ("20% off $79+, 22% off $139+"). An order
  gets the best tier it reaches; `maxDiscount` is shared; all tiers share the
  coupon's single use. Inside the optimizer each tier is a separate variant
  with its own gate, grouped under the source coupon, and single-use masks are
  per group, so two tiers of one code can never both be used.
- Store scope — `includeStores[]` matches `Item.store`, case-insensitive.
  Blank means any store. The UI warns when a store coupon matches no item.

This covers "buy 3 get 1 free" (`minItems 3` + `cheapestFree 1`), "$5 off 3+
items" (`minItems 3` + `fixed 5`), and "20% off when you buy 2" (`minItems 2` +
`percent 20`) without separate types.

## Optimizer

Minimise `sum over orders of (subtotal - discounts + shipping)` minus card
cashback.

Constraints:

- every item in exactly one order
- at most K orders, configurable, default 3
- one coupon per order unless `stackableWith` permits more
- `singleUse` coupons used at most once across all orders
- a coupon applies only if its gate is met by **eligible** items in that order
- flash sale and clearance items are excluded from a coupon's qualifying
  subtotal unless `appliesToDiscountedItems` is true
- percent coupons with `maxDiscount` are capped

Solver routing:

- Small carts (no `cheapestFree` coupon, at most 12 item lines, at most 3
  orders, at most 90 coupon layouts, solver CDN reachable): enumerate the
  coupon-to-order layouts and solve each item partition as a MILP with
  `javascript-lp-solver`, alongside local search.
- Everything else: seeded local search — greedy fill by threshold proximity,
  then a move/swap neighbourhood, multiple restarts.
- `cheapestFree` is **not linear** in the assignment variables, so it can never
  go into the MILP objective. If any active coupon uses it, the whole solve
  goes through local search.
- Every partition the MILP proposes is re-scored by the exact evaluator, so a
  formulation slip can only cost a worse suggestion, never a wrong number.
- The mode that ran is always reported in the UI.

## Output rules

- Baseline row first: everything in one order. That is the number to beat.
- Per proposed order: items, qty, subtotal, coupon code, discount, shipping,
  order total.
- Grand total, then card cashback on **its own line below the grand total** —
  never folded into an order total — then net cost and the savings delta.
- If the delta is under $5, say plainly that splitting is not worth it.
- Near-miss hints name the gap, the item to move, and the net effect.
- Copy-code button per order, plus a persisted "placed" checkbox per order.
- Warning banners for anything ambiguous: unparsed price, missing category,
  coupon terms flagged uncertain, stacked-coupon assumptions, split bundles.

## UX rules

- One column, thumb-reachable, ~820pt Safari and sometimes split-screen.
- Inputs must be at least 16px or iOS zooms on focus.
- Coupon rules are edited through a form, never by hand-editing JSON.
- Everything persists to `localStorage`, with JSON export and import.
- Keep a visible version number in the bottom corner of the page.

## Modelling decisions worth remembering

- All optimizer arithmetic is integer cents. Floats only touch input fields and
  the formatter.
- Stacked coupons are each computed against the pre-discount eligible subtotal,
  and the sum is capped at the order subtotal. Real checkout may apply them in
  sequence for less. The UI warns when this assumption is in play.
- Card offers: many may be configured, each order takes at most one, `maxUses`
  defaults to 1 because most offers are once per account.
  `perTransaction: false` means the threshold is measured against the whole
  split rather than a single order.
- A card offer's `minSpend` is compared against the full amount charged for an
  order, shipping included.
- The free-shipping threshold can be measured before or after the coupon
  discount. It is a user setting, because stores differ.
- Uncategorised items count as ineligible for "only these categories" coupons,
  and the UI warns when that is happening.
- My Coupons has no embedded data, only rendered cards, so the coupon parser
  reads SHEIN's screen-reader summaries (`.coupon-left__sr-only`,
  `.coupon-right__sr-only`) plus `.discount-limit` and `.category-info`.
- "For selected products" coupons don't say which products. They are treated
  as covering every item and imported with `uncertain: true`. Cards don't
  state flash-sale coverage or stacking either, so imports assume neither.
- Expiry compares against the device's local date, never UTC.

## Testing

There is no test runner and no build. Verification is done by driving the page
with Playwright and Chromium and comparing the optimizer against exhaustive
enumeration on small random carts. Keep that property: for any cart small
enough to brute force, the reported plan must match the brute-force optimum.
