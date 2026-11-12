/* ============================================================================
 * guard.js — the number check.
 *
 * The prompt tells the model to use only numbers from tool results. This file
 * does not take that on trust. It remembers every number the tools returned
 * (and any number the seller said), then checks each reply: is every figure
 * in it one we have actually seen? The result is shown under the reply.
 * ========================================================================== */
(function () {
  const known = new Set();
  const key = (n) => String(Math.round(Math.abs(Number(n)) * 10) / 10);

  // Pull numbers out of text. Understands "1,35,000" and "1.35 lakh".
  function numbersIn(text) {
    const out = [], re = /(\d(?:[\d,]*\d)?(?:\.\d+)?)(\s?(lakhs?|crores?|thousand|लाख|करोड़|हज़ार|हजार))?/gi;
    let m;
    while ((m = re.exec(String(text)))) {
      let n = Number(m[1].replace(/,/g, ""));
      const unit = (m[3] || "").toLowerCase();
      if (/lakh|लाख/.test(unit)) n *= 100000;
      else if (/crore|करोड़/.test(unit)) n *= 10000000;
      else if (/thousand|हज़ार|हजार/.test(unit)) n *= 1000;
      out.push(n);
    }
    return out;
  }

  // Remember every number inside a tool result (objects, arrays, strings).
  function learn(x) {
    if (x == null) return;
    if (typeof x === "number") known.add(key(x));
    else if (typeof x === "string") numbersIn(x).forEach((n) => known.add(key(n)));
    else if (typeof x === "object") Object.values(x).forEach(learn);
  }

  // Check one reply. Numbers up to 10 are skipped: they are counts like "three actions" or "2 days".
  function check(text) {
    const nums = numbersIn(text).filter((n) => n > 10);
    return { checked: nums.length, unknown: nums.filter((n) => !known.has(key(n))) };
  }

  window.KAM_GUARD = { learn, check, numbersIn, reset: () => known.clear() };
})();
