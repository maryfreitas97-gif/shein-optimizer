/*
 * parsers/shein.js — SHEIN cart extractor.
 *
 * All SHEIN-specific knowledge lives in this file. When SHEIN changes its
 * cart page, this is the only file that should need fixing (see README).
 *
 * Written against a real capture of the US desktop cart page (Oct 2026).
 * The cart is server-rendered into an inline script as
 *
 *   gbCartSsrData = { originCartInfo: { mallCartInfo: { mallCarts: [...] } } }
 *
 *   mallCarts[].type            "1" = normal, "-1" = invalid / sold out group
 *     .shops[].contentData[].productLineInfoList[]   one entry per cart line
 *
 * Verified against that capture: sum(unitPrice * quantity) over checked lines
 * equals originCartInfo.totalPrice exactly, and retailPrice sums to
 * originPrice. So unitPrice is the price the cart actually charges.
 *
 * Exposes window.SheinParser = { VERSION, capture, parse }.
 * Read-only: never calls SHEIN, never touches the cart.
 */
(function (root) {
  "use strict";

  var VERSION = "0.2.0";

  // TODO(category): SHEIN only gives a numeric cat_id per line, with no name.
  // Coupon categories in the planner are words ("Women", "Beauty"), so a raw
  // id would never match and would hide the "uncategorised" warning. Leave
  // items uncategorised until an id is mapped here, e.g. "1738": "Women".
  var CATEGORY_NAMES = {};

  // aggregateProductBusiness.type_id seen in the capture:
  //   "31" no tag, or "Price Drop"   (46 lines)
  //   "32" "Extra Savings"           (17 lines, promotion ruleNum "4")
  //   "33" "Extra Savings" + Voucher (1 line)
  // TODO(flags): none of these is known to be a flash sale or clearance,
  // and nothing in the payload says "flash" or "clearance". Add ids here only
  // after confirming one against a product SHEIN labels that way on screen.
  var FLASH_SALE_TYPE_IDS = [];
  var CLEARANCE_TYPE_IDS = [];
  // Promotions whose price depends on what else is in the order. Splitting
  // the cart can lose them, so the planner's price may be too low.
  var CART_LEVEL_PROMO_TYPE_IDS = ["32", "33"];

  function get(o, path) {
    for (var i = 0; i < path.length; i++) {
      if (o == null) return undefined;
      o = o[path[i]];
    }
    return o;
  }

  function amount(p) {
    var a = p && p.amount;
    return a == null || a === "" || isNaN(Number(a)) ? null : String(a);
  }

  // Pull the gbCartSsrData object out of page HTML. The value is a JSON
  // literal, so scan to its matching brace instead of eval-ing page script.
  function ssrFromHtml(html) {
    var m = /gbCartSsrData\s*=\s*\{/.exec(html);
    if (!m) return null;
    var start = m.index + m[0].length - 1;
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < html.length; i++) {
      var c = html.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
    return null;
  }

  // Accepts page HTML, the JSON capture() produces, or the SSR object itself.
  function toCartInfo(input) {
    var o = input;
    if (typeof o === "string") {
      var s = o.trim();
      if (s.charAt(0) === "{") o = JSON.parse(s);
      else o = ssrFromHtml(s);
      if (!o) throw new Error("No SHEIN cart data found. Paste the capture output, or the cart page source.");
    }
    if (o.originCartInfo) o = o.originCartInfo;
    if (!get(o, ["mallCartInfo", "mallCarts"])) throw new Error("Cart data has no mallCartInfo.mallCarts. SHEIN may have changed the format; see README.");
    return o;
  }

  function attrText(product) {
    var parts = (product.sku_sale_attr || []).map(function (a) {
      return a.attr_value_name_en || a.attr_value_name || a.attrValue;
    });
    if (product.size && parts.indexOf(product.size) < 0) parts.push(product.size);
    return parts.filter(Boolean).join(" / ");
  }

  /*
   * parse(input, opts) -> { items, warnings, meta }
   *   opts.include  "checked" (default): only lines ticked for checkout
   *                 "all": every valid line in the cart
   * items match the planner's Item model; feed each to newItem().
   */
  function parse(input, opts) {
    opts = opts || {};
    var include = opts.include || "checked";
    var info = toCartInfo(input);
    var items = [], warnings = [];
    var skippedInvalid = 0, skippedUnchecked = 0, cartPromo = 0, badPrice = 0;
    var unmappedCats = {};

    info.mallCartInfo.mallCarts.forEach(function (mall) {
      (mall.shops || []).forEach(function (shop) {
        (shop.contentData || []).forEach(function (group) {
          (group.productLineInfoList || []).forEach(function (line) {
            var p = line.product || {};
            var biz = line.aggregateProductBusiness || {};
            if (String(mall.type) === "-1" || line.isInvalid === "1") { skippedInvalid++; return; }
            if (include === "checked" && line.is_checked !== "1") { skippedUnchecked++; return; }

            var price = amount(line.unitPrice);
            if (price == null) { badPrice++; price = amount(p.salePrice); }
            var typeId = biz.type_id == null ? "" : String(biz.type_id);
            if (CART_LEVEL_PROMO_TYPE_IDS.indexOf(typeId) >= 0) cartPromo++;
            var cat = CATEGORY_NAMES[p.cat_id] || "";
            if (!cat && p.cat_id) unmappedCats[p.cat_id] = true;
            var attrs = attrText(p);

            items.push({
              id: "shein-" + (line.id || p.sku_code || p.goods_id),
              name: (p.goods_name || "Unnamed item") + (attrs ? " — " + attrs : ""),
              price: price == null ? "" : price,
              qty: parseInt(line.quantity, 10) || 1,
              category: cat,
              brand: p.brand || "",
              flags: {
                flashSale: FLASH_SALE_TYPE_IDS.indexOf(typeId) >= 0,
                clearance: CLEARANCE_TYPE_IDS.indexOf(typeId) >= 0,
                bundle: false // TODO(flags): no bundle signal in the capture (appendIds and promotionGroupId were all empty).
              }
            });
          });
        });
      });
    });

    if (!items.length && skippedUnchecked) warnings.push("No lines are ticked in your SHEIN cart. Tick the items you plan to buy, or import all lines.");
    if (skippedInvalid) warnings.push(skippedInvalid + " sold-out or invalid line" + (skippedInvalid > 1 ? "s were" : " was") + " skipped.");
    if (badPrice) warnings.push(badPrice + " line" + (badPrice > 1 ? "s have" : " has") + " no cart price; used the list price instead. Check them.");
    if (cartPromo) warnings.push(cartPromo + " item" + (cartPromo > 1 ? "s are" : " is") + " priced with an “Extra Savings” cart promotion. That price may not survive splitting into smaller orders.");
    var cats = Object.keys(unmappedCats);
    if (cats.length) warnings.push("SHEIN gives categories as numbers only (" + cats.slice(0, 5).join(", ") + (cats.length > 5 ? ", …" : "") + "). Items are uncategorised; set categories in the table.");
    warnings.push("Flash sale and clearance flags are not detected yet. Tick them in the table where they apply.");

    return {
      items: items,
      warnings: warnings,
      meta: {
        parser: "shein " + VERSION,
        include: include,
        cartTotal: amount(info.totalPrice),
        currency: get(info, ["totalPrice", "amountWithSymbol"]) ? String(info.totalPrice.amountWithSymbol).replace(/[\d.,\s]/g, "") : "",
        lines: items.length,
        skippedUnchecked: skippedUnchecked,
        skippedInvalid: skippedInvalid
      }
    };
  }

  /*
   * capture() — run on the SHEIN cart page (Shortcut or bookmarklet).
   * Returns a JSON string of just the cart lines and totals. The address,
   * member id and session tokens that sit alongside them in the page data
   * are deliberately left out.
   */
  function capture() {
    var ssr = root.gbCartSsrData || root.gbRawData;
    if (!ssr) {
      var scripts = document.querySelectorAll("script:not([src])");
      for (var i = 0; i < scripts.length && !ssr; i++) {
        if (scripts[i].textContent.indexOf("gbCartSsrData") >= 0) ssr = ssrFromHtml(scripts[i].textContent);
      }
    }
    var info = ssr && ssr.originCartInfo;
    if (!info) throw new Error("No SHEIN cart data on this page. Open the cart page first.");
    return JSON.stringify({
      capturedBy: "shein " + VERSION,
      capturedAt: new Date().toISOString(),
      originCartInfo: {
        totalPrice: info.totalPrice,
        originPrice: info.originPrice,
        mallCartInfo: { mallCarts: info.mallCartInfo.mallCarts }
      }
    });
  }

  root.SheinParser = { VERSION: VERSION, capture: capture, parse: parse };
})(typeof window !== "undefined" ? window : this);
