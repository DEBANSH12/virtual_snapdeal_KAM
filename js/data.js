/* ============================================================================
 * data.js — MOCK DATA ONLY. Nothing here comes from Snapdeal systems.
 *
 * GIVEN   = the five metrics from the assignment brief (ground truth).
 * ASSUMED = everything else, invented so the agent has something to diagnose.
 *           Every assumption is listed in ASSUMPTIONS and repeated in NOTE.md.
 * ========================================================================== */
window.KAM_DATA = {
  seller: {
    name: "Rajesh Kumar",
    spokenName: "Rajesh ji",
    shop: "Rajesh Home & Kitchen",
    category: "Home & Kitchen",
    whatsapp: "+91 98XXX XX210" // masked, fictional
  },

  // ---- GIVEN in the brief (do not change) ---------------------------------
  given: {
    lastMonth: { sales: 200000, orders: 400, cancellationRate: 0.08, asp: 500, outOfStock: 5 },
    thisMonth: { sales: 135000, orders: 270, cancellationRate: 0.14, asp: 500, outOfStock: 18 }
  },

  // ---- ASSUMED (clearly labelled) -----------------------------------------
  ASSUMPTIONS: [
    "A1. 'Orders' in the brief are net orders (after cancellations). This fits the data: 270 orders x Rs 500 = Rs 1,35,000.",
    "A2. Cancellation rate = cancelled orders / orders placed. So orders placed were about 435 last month and 314 this month.",
    "A3. The seller has 60 active products. 5 were already out of stock last month; 13 more ran out this month (18 total).",
    "A4. The list of 13 newly out-of-stock products (names, prices, last-month units, days out of stock) is invented.",
    "A5. Sales lost on a product = last month's daily sales rate x days out of stock x price, rounded to the nearest Rs 100.",
    "A6. This month's cancellations split 55% stock not available / 25% late dispatch / 20% buyer changed mind (invented).",
    "A7. Store visits and impressions are invented and nearly flat, so visibility is a secondary hypothesis only.",
    "A8. No competitor price data exists in the mock set. The agent has to ask the seller about it.",
    "A9. Eight in-stock products are itemised (stock on hand, last-month units, age of oldest stock). The other 34 products are not itemised.",
    "A10. Movement classes: fast = 20 or more units a month, medium = 8 to 19, slow = under 8.",
    "A11. Min/max levels: min = daily sales x (supplier lead time + 3 safety days); max = min + 15 days of sales. Lead time defaults to 7 days until the seller states his own.",
    "A12. Stock older than 90 days counts as ageing. Stock value is units x selling price (no purchase cost in the mock data).",
    "A13. Customer enquiries (restock requests on sold-out products, and searches for products the seller does not list) are invented.",
    "A14. Dispatch times are invented. The dispatch promise is assumed to be 2 days."
  ],

  activeSkus: 60,

  // 13 products that went out of stock THIS month. lastMonthUnits = net units sold last month.
  newlyOutOfStock: [
    { id: "HK-101", name: "Non-stick Dosa Tawa",          price: 549, lastMonthUnits: 36, daysOut: 20 },
    { id: "HK-102", name: "Stainless Steel Kadhai",        price: 699, lastMonthUnits: 24, daysOut: 18 },
    { id: "HK-103", name: "Manual Vegetable Chopper",      price: 299, lastMonthUnits: 45, daysOut: 16 },
    { id: "HK-104", name: "Insulated Steel Flask",         price: 449, lastMonthUnits: 18, daysOut: 15 },
    { id: "HK-105", name: "Airtight Container Set",        price: 399, lastMonthUnits: 20, daysOut: 12 },
    { id: "HK-106", name: "Masala Dabba Spice Box",        price: 499, lastMonthUnits: 12, daysOut: 15 },
    { id: "HK-107", name: "Glass Lunch Box Set",           price: 599, lastMonthUnits: 10, daysOut: 12 },
    { id: "HK-108", name: "Kitchen Knife Set",             price: 349, lastMonthUnits: 12, daysOut: 10 },
    { id: "HK-109", name: "Insulated Roti Box",            price: 459, lastMonthUnits: 9,  daysOut: 10 },
    { id: "HK-110", name: "Silicone Spatula Set",          price: 249, lastMonthUnits: 10, daysOut: 9  },
    { id: "HK-111", name: "Dish Drying Rack",              price: 749, lastMonthUnits: 4,  daysOut: 8  },
    { id: "HK-112", name: "Oil Dispenser Bottle",          price: 279, lastMonthUnits: 6,  daysOut: 10 },
    { id: "HK-113", name: "Cutlery Organiser Tray",        price: 329, lastMonthUnits: 5,  daysOut: 6  }
  ],

  // 5 products that were already out of stock last month (no change vs last month).
  alreadyOutOfStock: ["Cast Iron Grill Pan", "Bamboo Chopping Board", "Tea Coaster Set", "Steel Water Jug", "Fridge Storage Bins"],

  // 8 products that ARE in stock. oldestStockDays = how long the oldest units have been on the shelf.
  inStock: [
    { id: "HK-201", name: "Non-stick Fry Pan",        price: 499,  lastMonthUnits: 26, stockUnits: 9,  oldestStockDays: 12 },
    { id: "HK-202", name: "Steel Dinner Plate Set",   price: 449,  lastMonthUnits: 21, stockUnits: 6,  oldestStockDays: 10 },
    { id: "HK-203", name: "Steel Tiffin Box",         price: 649,  lastMonthUnits: 22, stockUnits: 30, oldestStockDays: 25 },
    { id: "HK-204", name: "Copper Water Bottle",      price: 599,  lastMonthUnits: 14, stockUnits: 35, oldestStockDays: 60 },
    { id: "HK-205", name: "Wooden Spice Rack",        price: 899,  lastMonthUnits: 3,  stockUnits: 40, oldestStockDays: 140 },
    { id: "HK-206", name: "Ceramic Dinner Set",       price: 1499, lastMonthUnits: 2,  stockUnits: 25, oldestStockDays: 160 },
    { id: "HK-207", name: "Glass Jar Set",            price: 349,  lastMonthUnits: 5,  stockUnits: 60, oldestStockDays: 120 },
    { id: "HK-208", name: "Table Mat Set",            price: 199,  lastMonthUnits: 4,  stockUnits: 80, oldestStockDays: 180 }
  ],

  stockRules: { defaultLeadTimeDays: 7, safetyDays: 3, maxExtraCoverDays: 15, fastFrom: 20, mediumFrom: 8, ageingAfterDays: 90 },

  // Customers asking for things this month.
  enquiries: {
    restockRequests: { "HK-103": 38, "HK-101": 31, "HK-102": 19, "HK-104": 12, "HK-105": 9 },   // "tell me when it is back"
    otherRestockRequests: 14,
    notListed: [ { product: "Idli Maker", searches: 46 }, { product: "Steel Masala Grinder", searches: 21 } ]
  },

  dispatch: { promiseDays: 2, avgDaysLastMonth: 1.2, avgDaysThisMonth: 2.1 },

  cancellationReasonShare: { stockNotAvailable: 0.55, lateDispatch: 0.25, buyerChangedMind: 0.20 },

  traffic: {
    lastMonth: { impressions: 120000, visits: 14500 },
    thisMonth: { impressions: 114500, visits: 13900 }
  }
};
