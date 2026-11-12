/* ============================================================================
 * tools.js — the agent's tools. Plain JavaScript, deterministic.
 *
 * The LLM never does arithmetic. It calls these functions and repeats the
 * numbers they return. Read tools compute from data.js; action tools change
 * the on-screen panels (action tracker, follow-up, WhatsApp preview).
 * ========================================================================== */
(function () {
  const D = window.KAM_DATA;
  const r100 = (n) => Math.round(n / 100) * 100;
  const pct1 = (n) => Math.round(n * 1000) / 10; // 0.325 -> 32.5

  // ---- Derived numbers (computed once, reused by every tool) ---------------
  function derive() {
    const a = D.given.lastMonth, b = D.given.thisMonth;
    const placedA = a.orders / (1 - a.cancellationRate);      // ~434.8
    const placedB = b.orders / (1 - b.cancellationRate);      // ~314.0
    const salesDrop = a.sales - b.sales;                      // 65,000

    const skus = D.newlyOutOfStock.map((s) => {
      const lostUnits = Math.round((s.lastMonthUnits * s.daysOut) / 30);
      return { ...s, lostUnits, estLostSales: r100(lostUnits * s.price) };
    }).sort((x, y) => y.estLostSales - x.estLostSales);
    const stockoutLoss = skus.reduce((t, s) => t + s.estLostSales, 0);

    // Sales bridge: three parts that add up to the Rs 65,000 drop exactly.
    const extraCancelLoss = r100(placedB * (b.cancellationRate - a.cancellationRate) * b.asp);
    const otherLoss = salesDrop - stockoutLoss - extraCancelLoss; // residual, never hardcoded

    const cancelledB = Math.round(placedB - b.orders);
    const sh = D.cancellationReasonShare;
    const stockCancels = Math.round(cancelledB * sh.stockNotAvailable);
    const lateCancels = Math.round(cancelledB * sh.lateDispatch);

    return {
      a, b, salesDrop, skus, stockoutLoss, extraCancelLoss, otherLoss,
      placedA: Math.round(placedA), placedB: Math.round(placedB),
      cancelledA: Math.round(placedA - a.orders), cancelledB,
      stockCancels, lateCancels, buyerCancels: cancelledB - stockCancels - lateCancels
    };
  }
  const X = derive();

  // ---- Session state changed by action tools --------------------------------
  const session = { sellerInputs: [], actions: [], followUp: null, summary: null, checked: {}, stockPlan: null };
  function resetSession() {
    session.sellerInputs = []; session.actions = []; session.followUp = null;
    session.summary = null; session.checked = {}; session.stockPlan = null;
  }

  function followUpDate(days) {
    const d = new Date(); d.setDate(d.getDate() + days);
    return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  }

  // ---- Tool implementations --------------------------------------------------
  const impl = {
    get_account_overview() {
      session.checked.overview = true;
      return {
        seller: D.seller.name, shop: D.seller.shop,
        last_month: { sales_rupees: X.a.sales, net_orders: X.a.orders, cancellation_rate_pct: pct1(X.a.cancellationRate), avg_selling_price: X.a.asp, out_of_stock_products: X.a.outOfStock },
        this_month: { sales_rupees: X.b.sales, net_orders: X.b.orders, cancellation_rate_pct: pct1(X.b.cancellationRate), avg_selling_price: X.b.asp, out_of_stock_products: X.b.outOfStock },
        change: {
          sales_drop_rupees: X.salesDrop,
          sales_drop_pct: pct1(X.salesDrop / X.a.sales),
          orders_drop: X.a.orders - X.b.orders,
          orders_drop_pct: pct1((X.a.orders - X.b.orders) / X.a.orders),
          avg_selling_price_change: X.b.asp - X.a.asp,
          cancellation_rate_change_points: pct1(X.b.cancellationRate - X.a.cancellationRate),
          out_of_stock_increase: X.b.outOfStock - X.a.outOfStock
        },
        reading: "Price is unchanged, so the whole drop is fewer orders. Out-of-stock products and cancellations both got worse. Check inventory first."
      };
    },

    get_inventory_report(args) {
      session.checked.inventory = true;
      const n = Math.min(Math.max(parseInt(args && args.top_n, 10) || 3, 1), 13);
      const top = X.skus.slice(0, n);
      return {
        active_products: D.activeSkus,
        out_of_stock_now: X.b.outOfStock,
        out_of_stock_last_month: X.a.outOfStock,
        newly_out_of_stock_this_month: X.skus.length,
        est_sales_lost_to_stockouts_rupees: X.stockoutLoss,
        share_of_total_sales_drop_pct: pct1(X.stockoutLoss / X.salesDrop),
        top_products_by_lost_sales: top.map((s) => ({ name: s.name, price: s.price, units_sold_last_month: s.lastMonthUnits, days_out_of_stock: s.daysOut, est_lost_sales_rupees: s.estLostSales })),
        top_products_lost_sales_rupees: top.reduce((t, s) => t + s.estLostSales, 0),
        verdict: "PRIMARY CAUSE. Best sellers ran out of stock. Estimate, based on last month's sales rate."
      };
    },

    get_cancellation_report() {
      session.checked.cancellations = true;
      return {
        cancellation_rate_last_month_pct: pct1(X.a.cancellationRate),
        cancellation_rate_this_month_pct: pct1(X.b.cancellationRate),
        orders_placed_this_month: X.placedB,
        orders_cancelled_this_month: X.cancelledB,
        orders_cancelled_last_month: X.cancelledA,
        reasons_this_month: [
          { reason: "Product not in stock when the order came (seller cancelled)", orders: X.stockCancels },
          { reason: "Late dispatch", orders: X.lateCancels },
          { reason: "Buyer changed mind", orders: X.buyerCancels }
        ],
        est_sales_lost_to_extra_cancellations_rupees: X.extraCancelLoss,
        verdict: "CONTRIBUTING CAUSE, linked to inventory. Most cancellations are orders taken on products that were not actually in stock, so listed stock is not matching real stock."
      };
    },

    get_pricing_and_visibility() {
      session.checked.pricing = true; session.checked.visibility = true;
      const t = D.traffic;
      return {
        avg_selling_price_last_month: X.a.asp, avg_selling_price_this_month: X.b.asp,
        pricing_verdict: "NOT A CAUSE in the data. Average selling price is unchanged. No competitor price data is available, so ask the seller if a competitor cut prices.",
        store_visits_last_month: t.lastMonth.visits, store_visits_this_month: t.thisMonth.visits,
        visits_change_pct: pct1((t.thisMonth.visits - t.lastMonth.visits) / t.lastMonth.visits),
        conversion_last_month_pct: pct1(X.placedA / t.lastMonth.visits),
        conversion_this_month_pct: pct1(X.placedB / t.thisMonth.visits),
        visibility_verdict: "NOT THE MAIN CAUSE. Visits are almost flat but fewer visitors are ordering, which is what happens when shoppers land on sold-out products. Do not cut prices or spend on ads before restocking."
      };
    },

    get_sales_bridge() {
      session.checked.bridge = true;
      return {
        total_sales_drop_rupees: X.salesDrop,
        parts: [
          { cause: "Stockouts on 13 products", rupees: X.stockoutLoss, share_pct: pct1(X.stockoutLoss / X.salesDrop) },
          { cause: "Extra cancellations (rate 8% to 14%)", rupees: X.extraCancelLoss, share_pct: pct1(X.extraCancelLoss / X.salesDrop) },
          { cause: "Not explained by the data (season, competition, other)", rupees: X.otherLoss, share_pct: pct1(X.otherLoss / X.salesDrop) }
        ],
        note: "The first two parts are estimates. The third is whatever is left over."
      };
    },

    estimate_recovery(args) {
      session.checked.recovery = true;
      const n = Math.min(Math.max(parseInt(args && args.restock_top_n, 10) || 3, 1), 13);
      const top = X.skus.slice(0, n);
      const restock = top.reduce((t, s) => t + s.estLostSales, 0);
      const total = restock + X.extraCancelLoss;
      return {
        restock_products: top.map((s) => s.name),
        monthly_sales_recovered_by_restocking_rupees: restock,
        monthly_sales_recovered_by_cancellations_back_to_8pct_rupees: X.extraCancelLoss,
        total_monthly_recovery_rupees: total,
        share_of_drop_recovered_pct: pct1(total / X.salesDrop),
        note: "Estimate at last month's sales rate. Restocking all 13 products recovers more."
      };
    },

    log_seller_input(args) {
      const item = { topic: String((args && args.topic) || "other"), note: String((args && args.note) || "").slice(0, 200) };
      session.sellerInputs.push(item);
      return { saved: true };
    },

    commit_action_plan(args) {
      const list = Array.isArray(args && args.actions) ? args.actions.slice(0, 5) : [];
      session.actions = list.map((a, i) => ({
        priority: i + 1,
        title: String(a.title || "Action"), owner: String(a.owner || "Seller"),
        due: String(a.due || "This week"), expected_impact: String(a.expected_impact || "")
      }));
      return { saved: true, actions_on_tracker: session.actions.length };
    },

    schedule_followup(args) {
      const days = Math.min(Math.max(parseInt(args && args.days_from_now, 10) || 3, 1), 30);
      session.followUp = { days, date: followUpDate(days), agenda: String((args && args.agenda) || "Check progress on the action plan") };
      return { scheduled: true, date: session.followUp.date, days_from_now: days, note: "Simulated. No real call is booked in this prototype." };
    },

    send_summary(args) {
      session.summary = { to: D.seller.whatsapp, message: String((args && args.message) || "").slice(0, 700) };
      return { sent: true, channel: "WhatsApp (simulated)", to: D.seller.whatsapp };
    },

    // ---- Day-to-day inventory practice -------------------------------------------
    // Fast / medium / slow movers, plus stock that is sitting too long (FIFO, ageing).
    get_product_movement() {
      session.checked.movement = true;
      const R = D.stockRules;
      const all = [...D.newlyOutOfStock.map((s) => ({ ...s, stockUnits: 0 })), ...D.inStock];
      const cls = (u) => (u >= R.fastFrom ? "fast" : u >= R.mediumFrom ? "medium" : "slow");
      const fast = all.filter((p) => cls(p.lastMonthUnits) === "fast").sort((a, b) => b.lastMonthUnits - a.lastMonthUnits);
      const slowStock = D.inStock.filter((p) => cls(p.lastMonthUnits) === "slow")
        .map((p) => ({ name: p.name, units_in_stock: p.stockUnits, units_sold_last_month: p.lastMonthUnits, oldest_stock_days: p.oldestStockDays, stock_value_rupees: r100(p.stockUnits * p.price) }))
        .sort((a, b) => b.stock_value_rupees - a.stock_value_rupees);
      return {
        products_classified: all.length,
        rule: `fast = ${R.fastFrom}+ units a month, medium = ${R.mediumFrom} to ${R.fastFrom - 1}, slow = under ${R.mediumFrom}`,
        fast_movers: fast.length,
        medium_movers: all.filter((p) => cls(p.lastMonthUnits) === "medium").length,
        slow_movers: all.filter((p) => cls(p.lastMonthUnits) === "slow").length,
        fast_movers_out_of_stock: fast.filter((p) => p.stockUnits === 0).map((p) => p.name),
        fast_movers_out_of_stock_count: fast.filter((p) => p.stockUnits === 0).length,
        slow_movers_with_excess_stock: slowStock,
        money_locked_in_slow_stock_rupees: slowStock.reduce((t, p) => t + p.stock_value_rupees, 0),
        ageing_stock_products: D.inStock.filter((p) => p.oldestStockDays > R.ageingAfterDays).length,
        ageing_rule_days: R.ageingAfterDays,
        advice: "Money is sitting in slow products while fast movers are sold out. Sell the oldest stock first (FIFO), clear ageing slow stock with a small offer, and put that money into fast movers."
      };
    },

    // Min / max stock levels for fast movers: when to reorder and how much.
    get_stock_plan(args) {
      session.checked.stockPlan = true;
      const R = D.stockRules;
      const lead = Math.min(Math.max(parseInt(args && args.supplier_lead_time_days, 10) || R.defaultLeadTimeDays, 1), 60);
      const all = [...D.newlyOutOfStock.map((s) => ({ ...s, stockUnits: 0 })), ...D.inStock];
      const rows = all.filter((p) => p.lastMonthUnits >= R.fastFrom).sort((a, b) => b.lastMonthUnits - a.lastMonthUnits).map((p) => {
        const daily = p.lastMonthUnits / 30;
        const min = Math.ceil(daily * (lead + R.safetyDays));
        const max = Math.ceil(daily * (lead + R.safetyDays + R.maxExtraCoverDays));
        const cover = p.stockUnits ? Math.round(p.stockUnits / daily) : 0;
        return { name: p.name, units_in_stock: p.stockUnits, days_of_stock_left: cover, min_level: min, max_level: max,
          order_now_units: p.stockUnits <= min ? max - p.stockUnits : 0,
          status: p.stockUnits === 0 ? "out of stock" : p.stockUnits <= min ? "at or below min, reorder now" : "healthy" };
      });
      session.stockPlan = { lead, rows };
      return {
        supplier_lead_time_days_used: lead,
        how_levels_are_set: `min = daily sales x (lead time ${lead} + ${R.safetyDays} safety days). max = min + ${R.maxExtraCoverDays} more days of sales. Reorder when stock touches min, order up to max.`,
        fast_movers: rows,
        about_to_run_out: rows.filter((r) => r.units_in_stock > 0 && r.order_now_units > 0).map((r) => r.name),
        total_units_to_order_now: rows.reduce((t, r) => t + r.order_now_units, 0)
      };
    },

    // What customers are asking for: restock requests and searches for products he does not list.
    get_customer_enquiries() {
      session.checked.enquiries = true;
      const E = D.enquiries;
      const top = Object.entries(E.restockRequests).map(([id, n]) => ({ name: D.newlyOutOfStock.find((s) => s.id === id).name, customers_waiting: n })).sort((a, b) => b.customers_waiting - a.customers_waiting);
      return {
        customers_waiting_for_restock_total: top.reduce((t, x) => t + x.customers_waiting, 0) + E.otherRestockRequests,
        most_requested_sold_out_products: top,
        searched_but_not_listed: E.notListed.map((x) => ({ product: x.product, searches_this_month: x.searches })),
        advice: "Restock in the order customers are asking. Consider listing the most searched product he does not sell yet."
      };
    },

    // Dispatch speed: are orders leaving on time?
    get_dispatch_report() {
      session.checked.dispatch = true;
      const P = D.dispatch;
      return {
        dispatch_promise_days: P.promiseDays,
        avg_dispatch_days_last_month: P.avgDaysLastMonth,
        avg_dispatch_days_this_month: P.avgDaysThisMonth,
        orders_cancelled_for_late_dispatch: X.lateCancels,
        advice: "Keep the fast movers packed and ready on one shelf so they ship the same day. Late dispatch is causing cancellations."
      };
    },

    set_language(args) {
      const lang = args && args.language === "hi" ? "hi" : "en";
      return { language: lang, switched: true };
    },

    end_call() { return { ended: true }; }
  };

  // Monitoring rules. In production these would run every day on every seller;
  // when one fires, the KAM calls the seller instead of waiting for him to call.
  function checkAlerts() {
    const alerts = [];
    const dropPct = pct1(X.salesDrop / X.a.sales);
    const cancelPts = pct1(X.b.cancellationRate - X.a.cancellationRate);
    if (dropPct >= 20) alerts.push({ rule: "Sales down 20% or more vs last month", text: `Sales down ${dropPct}%`, value: dropPct });
    if (cancelPts >= 3) alerts.push({ rule: "Cancellation rate up 3 points or more", text: `Cancellations up ${cancelPts} pts`, value: cancelPts });
    if (X.b.outOfStock >= 2 * X.a.outOfStock) alerts.push({ rule: "Out-of-stock products doubled", text: `Out of stock ${X.b.outOfStock} (was ${X.a.outOfStock})`, value: X.b.outOfStock });
    return alerts;
  }

  window.KAM_TOOLS = {
    derived: X,
    checkAlerts,
    session,
    resetSession,
    run(name, args) {
      if (!impl[name]) return { error: "Unknown tool: " + name };
      try { return impl[name](args || {}); }
      catch (e) { return { error: "Tool failed: " + e.message }; }
    }
  };
})();
