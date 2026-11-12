// Unit checks for the numbers and the number-to-speech converter. Run: node tests/unit.js
const assert = require("assert");
global.window = {}; global.location = { protocol: "file:" };
["data", "tools", "prompt", "speech", "guard", "brain"].forEach((f) => require("../js/" + f + ".js"));
const T = window.KAM_TOOLS, { toSpeech } = window.KAM_SPEECH;

const o = T.run("get_account_overview");
assert.strictEqual(o.change.sales_drop_rupees, 65000);
assert.strictEqual(o.change.sales_drop_pct, 32.5);
assert.strictEqual(o.change.orders_drop, 130);
assert.strictEqual(o.change.cancellation_rate_change_points, 6);
assert.strictEqual(o.change.avg_selling_price_change, 0);

const b = T.run("get_sales_bridge");
assert.strictEqual(b.parts.reduce((t, p) => t + p.rupees, 0), 65000, "bridge adds up to the full drop");
assert.ok(b.parts.every((p) => p.rupees > 0));

const inv = T.run("get_inventory_report", { top_n: 13 });
assert.strictEqual(inv.top_products_by_lost_sales.length, 13);
assert.strictEqual(inv.top_products_lost_sales_rupees, inv.est_sales_lost_to_stockouts_rupees);
assert.strictEqual(inv.out_of_stock_now - inv.out_of_stock_last_month, inv.newly_out_of_stock_this_month);

const c = T.run("get_cancellation_report");
assert.strictEqual(c.reasons_this_month.reduce((t, r) => t + r.orders, 0), c.orders_cancelled_this_month);
assert.strictEqual(Math.round(c.orders_cancelled_this_month / c.orders_placed_this_month * 100), 14);

const r = T.run("estimate_recovery", {});
assert.strictEqual(r.total_monthly_recovery_rupees, r.monthly_sales_recovered_by_restocking_rupees + r.monthly_sales_recovered_by_cancellations_back_to_8pct_rupees);
assert.ok(T.run("nope").error);

// Inventory practice tools
const mv = T.run("get_product_movement");
assert.strictEqual(mv.fast_movers + mv.medium_movers + mv.slow_movers, mv.products_classified);
assert.strictEqual(mv.fast_movers_out_of_stock_count, 4);
assert.strictEqual(mv.money_locked_in_slow_stock_rupees, mv.slow_movers_with_excess_stock.reduce((t, p) => t + p.stock_value_rupees, 0));
const sp = T.run("get_stock_plan", {});
sp.fast_movers.forEach((f) => { assert.ok(f.max_level > f.min_level); assert.ok(f.units_in_stock > f.min_level ? f.order_now_units === 0 : f.order_now_units === f.max_level - f.units_in_stock); });
assert.deepStrictEqual(sp.about_to_run_out, ["Non-stick Fry Pan", "Steel Dinner Plate Set"]);
assert.ok(T.run("get_stock_plan", { supplier_lead_time_days: 14 }).fast_movers[0].min_level > sp.fast_movers[0].min_level, "longer lead time raises the min");
assert.strictEqual(T.run("get_customer_enquiries").customers_waiting_for_restock_total, 123);
assert.strictEqual(T.run("get_dispatch_report").orders_cancelled_for_late_dispatch, c.reasons_this_month[1].orders);

[["₹1,35,000", "one lakh thirty-five thousand rupees"], ["₹2,00,000", "two lakh rupees"], ["₹65,000", "sixty-five thousand rupees"],
 ["₹47,900", "forty-seven thousand nine hundred rupees"], ["32.5%", "thirty-two point five percent"], ["₹500", "five hundred rupees"],
 ["₹1.35 lakh", "one point three five lakh rupees"], ["8% to 14%", "eight percent to fourteen percent"],
 ["₹65,000, and", "sixty-five thousand rupees, and"]].forEach(([a, w]) => assert.strictEqual(toSpeech(a, "en"), w));
assert.strictEqual(toSpeech("₹1,35,000 और 32.5%", "hi"), "135000 रुपये और 32.5 प्रतिशत");

// The system prompt must not contain any figure from the data.
const prompt = window.KAM_PROMPT.buildSystemPrompt("en") + window.KAM_PROMPT.buildSystemPrompt("hi");
["32.5", "1,35,000", "2,00,000", "47,900", "Dosa", "Kadhai"].forEach((x) => assert.ok(!prompt.includes(x), "prompt leaks " + x));
// Number check: figures from tools pass, invented or rounded ones are flagged.
const G = window.KAM_GUARD;
G.reset(); G.learn(T.run("get_account_overview")); G.learn(T.run("get_inventory_report", {}));
assert.deepStrictEqual(G.check("Sales fell 32.5% to ₹1,35,000 and 18 products are out of stock.").unknown, []);
assert.deepStrictEqual(G.check("That is ₹1.35 lakh, down from ₹2 lakh.").unknown, []);
assert.deepStrictEqual(G.check("You lost about ₹48,000.").unknown, [48000]);
assert.strictEqual(G.check("Do these 3 things in 2 days.").checked, 0);
G.learn("I can order 50 units"); assert.deepStrictEqual(G.check("Good, 50 units is enough.").unknown, []);
assert.strictEqual(T.checkAlerts().length, 3);
console.log("unit tests passed");
