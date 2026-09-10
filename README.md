# SHEIN cart-split optimizer

A read-only planner for splitting a shopping cart across several orders so that
coupons, the free-shipping threshold and card cashback land as cheaply as
possible. It never touches your cart. It prints a plan you place by hand.

Built to run entirely in mobile Safari on an iPad: one self-contained HTML file,
no build step, no server, no login, no analytics.

## Status

**Step 1 shipped — v0.1.0.** `index.html` works end to end with manual entry:
add items by hand, define coupons and card offers through forms, run the
optimizer, read the plan.

Still to come:

- Step 2: paste raw cart page text, parsed heuristically.
- Step 3: an iOS Shortcut and a bookmarklet that capture the cart as JSON,
  plus `parsers/shein.js` to map a real payload.

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Settings → Pages → Build and deployment → Source: **Deploy from a branch**.
3. Pick the branch and the `/ (root)` folder, then Save.
4. Wait for the Pages build, then open `https://<user>.github.io/<repo>/` on the
   iPad.

The empty `.nojekyll` file at the repository root stops GitHub Pages from
running the files through Jekyll.

## Use it on an iPad

Open the Pages URL in Safari, then Share → **Add to Home Screen**. It launches
full screen with its own icon. Everything you enter is saved in that device's
local storage, so it survives relaunches.

The only network request the page makes is loading `javascript-lp-solver` from
jsDelivr. If that fails, the page still works: the exact MILP path switches off
and the plan comes from local search alone, which the page tells you.

Use **Export JSON** to back your coupons up, since clearing Safari's website
data wipes local storage.

## How it works

Give it your items, your coupons and any card offers, then tap Optimize. It
reports:

- a **baseline**: everything in one order with the best coupon that applies,
- a **proposed split** of up to K orders, with each order's items, subtotal,
  coupon code, discount, shipping and total,
- **card cashback on its own line** under the grand total, never folded into an
  order total,
- the **savings delta**, and a plain recommendation not to bother if it is under
  five dollars,
- **near-miss hints** such as which single item to move to clear a threshold,
  and what that move actually costs,
- **warnings** for anything ambiguous: an unparsed price, a missing category, a
  coupon you flagged as uncertain, a split bundle.

A coupon is a gate plus a payoff. The gate is a minimum spend and/or a minimum
item count. The payoff is one of: a fixed amount off, a percentage off (capped
if you set a cap), the cheapest N eligible units free, or free shipping. That
covers "buy 3 get 1 free" and "$5 off 3+ items" without separate coupon types.

Small carts are solved by enumerating coupon layouts and running a MILP per
layout, alongside local search. Larger carts, and any cart with a
cheapest-units-free coupon, go through seeded local search. The page always
reports which mode ran and how long it took.

See `CLAUDE.md` for the full data model and the project's constraints.
