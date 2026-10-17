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
 * Exposes window.SheinParser; see the bottom of this file.
 * Read-only: never calls SHEIN, never touches the cart.
 */
(function (root) {
  "use strict";

  var VERSION = "0.3.0";

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
              // TODO(store): unconfirmed which field carries the name store
              // coupons use ("Apply to MOTF only"). Check against a capture.
              store: shop.shopName || line.store_title || "",
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
    if (!info) throw new Error("Nothing to import on this page. Open your SHEIN cart or My Coupons, then try again.");
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

  /* ------------------------------------------------------------ coupons --
   * Written against a real save of the US "My Coupons" page
   * (us.shein.com/user/coupon, Oct 2026). Unlike the cart, the coupon list
   * is not embedded as data; it only exists as rendered cards:
   *
   *   <div id="coupon-item-CODE">
   *     main[data-coupon-type]          "normal_coupon" | "saver_coupon"
   *     .coupon-left__sr-only           "20%OFF Orders $79+, 22%OFF Orders $139+"
   *                                     "$51 OFF Orders $229+"  "58%OFF No Min. Buy"
   *     .coupon-right__sr-only          "Product Coupon. Expires in 10/28/2026 03:59. For selected products"
   *     .discount-limit                 "Capped at $60" (absent when uncapped)
   *     .category-info                  "Apply to MOTF only" | "For selected products"
   *
   * The sr-only spans are SHEIN's screen-reader summaries, so they read the
   * same regardless of styling. Terms behind the card's expand arrow are not
   * in the page until opened, and are not captured.
   */
  function cardText(el, sel) {
    var n = el.querySelector(sel);
    return n ? n.textContent.replace(/\s+/g, " ").trim() : "";
  }

  // Runs against any Document: the live page, or a saved page via DOMParser.
  function couponCards(doc) {
    var cards = doc.querySelectorAll('[id^="coupon-item-"]'), out = [];
    for (var i = 0; i < cards.length; i++) {
      var el = cards[i], main = el.querySelector("[data-coupon-type]");
      out.push({
        code: el.id.slice("coupon-item-".length),
        kind: main ? main.getAttribute("data-coupon-type") : "",
        offer: cardText(el, ".coupon-left__sr-only"),
        summary: cardText(el, ".coupon-right__sr-only"),
        cap: cardText(el, ".discount-limit"),
        scope: cardText(el, ".category-info")
      });
    }
    return out;
  }

  function captureCoupons(doc) {
    var cards = couponCards(doc || document);
    if (!cards.length) throw new Error("No coupons on this page. Open My Coupons (Account → Coupons) first.");
    return JSON.stringify({ capturedBy: "shein " + VERSION, capturedAt: new Date().toISOString(), coupons: cards });
  }

  function money(s) {
    var m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(s || "");
    return m ? m[1].replace(/,/g, "") : null;
  }

  var TIER_RE = /(?:([\d.]+)\s*%\s*OFF|\$\s*([\d,.]+)\s*OFF)\s*(?:Orders\s*\$\s*([\d,.]+)\s*\+|No\s*Min\.?\s*Buy)/gi;

  function mapCoupon(card) {
    var tiers = [], m, notes = [], uncertain = false;
    TIER_RE.lastIndex = 0;
    while ((m = TIER_RE.exec(card.offer))) {
      tiers.push({
        payoff: m[1] != null ? "percent" : "fixed",
        value: m[1] != null ? m[1] : m[2].replace(/,/g, ""),
        minSpend: m[3] != null ? m[3].replace(/,/g, "") : 0
      });
    }
    var mixed = tiers.some(function (t) { return t.payoff !== tiers[0].payoff; });
    if (!tiers.length || mixed) {
      uncertain = true;
      notes.push("Could not read the discount “" + card.offer + "”; set it by hand.");
    }
    tiers.sort(function (a, b) { return Number(a.minSpend) - Number(b.minSpend); });

    var exp = /Expires in (\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}))?/.exec(card.summary);
    var expires = exp ? exp[3] + "-" + ("0" + exp[1]).slice(-2) + "-" + ("0" + exp[2]).slice(-2) : "";
    if (exp && exp[4]) notes.push("Expires " + exp[1] + "/" + exp[2] + "/" + exp[3] + " " + exp[4] + " (SHEIN's clock).");

    var stores = [], scope = card.scope || "";
    var only = /^Apply to (.+) only$/i.exec(scope);
    if (only) stores = [only[1].trim()];
    else if (/selected products/i.test(scope) || /selected products/i.test(card.summary)) {
      uncertain = true;
      notes.push("“For selected products”: the coupon page doesn't say which. Every item is treated as eligible.");
    } else if (scope) {
      uncertain = true;
      notes.push("Unrecognised scope “" + scope + "”; check which items qualify.");
    }

    var type = /^(Store|Product|Shipping)\s+Coupon/i.exec(card.summary);
    var label = (card.kind === "saver_coupon" ? "Saver " : "") +
      (type ? type[1].toLowerCase() + " coupon" : "coupon") + (stores.length ? " · " + stores[0] : "");
    var base = tiers[0] || { payoff: "percent", value: "", minSpend: 0 };

    return {
      id: "shein-coupon-" + card.code.toLowerCase(),
      code: card.code,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      payoff: base.payoff,
      value: base.value,
      maxDiscount: money(card.cap),
      minSpend: base.minSpend,
      minItems: 0,
      tiers: mixed ? [] : tiers.slice(1).map(function (t) { return { minSpend: t.minSpend, value: t.value }; }),
      includeCategories: [],
      excludeCategories: [],
      includeStores: stores,
      // TODO(coupons): flash-sale/clearance coverage and stacking are not on
      // the card. Defaults: not covered, no stacking, one use per account.
      appliesToDiscountedItems: false,
      singleUse: true,
      stackableWith: [],
      expires: expires,
      uncertain: uncertain,
      notes: notes.join(" "),
      enabled: !uncertain || tiers.length > 0
    };
  }

  // input: capture JSON from captureCoupons(), or a saved My Coupons page.
  function parseCoupons(input) {
    var cards;
    if (typeof input === "string" && input.trim().charAt(0) === "{") cards = JSON.parse(input).coupons;
    else if (typeof input === "string") cards = couponCards(new DOMParser().parseFromString(input, "text/html"));
    else cards = input && input.coupons;
    if (!cards || !cards.length) throw new Error("No coupons found. Paste the capture from My Coupons, or that page's saved HTML.");
    var coupons = cards.map(mapCoupon), warnings = [];
    var sel = coupons.filter(function (c) { return /selected products/.test(c.notes); }).length;
    if (sel) warnings.push(sel + " coupon" + (sel > 1 ? "s say" : " says") + " “for selected products” without listing them. They are treated as covering every item and flagged uncertain.");
    var bad = coupons.filter(function (c) { return !c.value; }).length;
    if (bad) warnings.push(bad + " coupon" + (bad > 1 ? "s" : "") + " could not be read and need their discount set by hand.");
    warnings.push("Coupon cards don't say whether a coupon covers flash-sale items or stacks with others. Imported coupons assume no to both.");
    return { coupons: coupons, warnings: warnings, meta: { parser: "shein " + VERSION, count: coupons.length } };
  }

  /* ------------------------------------------------------------ routing -- */

  // What kind of capture is this? "cart" | "coupons" | null
  function detect(input) {
    if (typeof input !== "string") return input && input.coupons ? "coupons" : input && (input.originCartInfo || input.mallCartInfo) ? "cart" : null;
    var s = input.trim();
    if (s.charAt(0) === "{") {
      try { return detect(JSON.parse(s)); } catch (e) { return null; }
    }
    if (/gbCartSsrData\s*=/.test(s)) return "cart";
    if (/id="coupon-item-/.test(s)) return "coupons";
    return null;
  }

  // For the extension: capture whichever supported SHEIN page this is.
  function captureAny() {
    if (document.querySelector('[id^="coupon-item-"]')) return captureCoupons(document);
    return capture();
  }

  root.SheinParser = {
    VERSION: VERSION, capture: capture, parse: parse,
    captureCoupons: captureCoupons, parseCoupons: parseCoupons,
    detect: detect, captureAny: captureAny
  };
})(typeof window !== "undefined" ? window : this);
