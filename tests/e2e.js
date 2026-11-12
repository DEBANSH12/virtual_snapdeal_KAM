// End-to-end check in headless Chromium. Speech recognition, speech synthesis and the
// Gemini API are replaced with fakes, so this tests the app's logic, not real audio.
const { chromium } = require("playwright");
const path = require("path");
const assert = require("assert");
const BASE = process.env.BASE || "http://localhost:8765/";

const FAKES = () => {
  // --- fake speechSynthesis: "speaks" for 4 ms per character
  const spoken = []; window.__spoken = spoken;
  class U { constructor(t) { this.text = t; } }
  window.SpeechSynthesisUtterance = U;
  let timers = [];
  const synth = {
    getVoices: () => [{ name: "Fake Neerja Natural", lang: "en-IN" }, { name: "Fake Swara Natural", lang: "hi-IN" }],
    speak(u) { spoken.push(u.text); window.__speakingNow = u.text; timers.push(setTimeout(() => { window.__speakingNow = null; u.onend && u.onend(); }, Math.max(60, u.text.length * (window.__msPerChar || 4)))); },
    cancel() { timers.forEach(clearTimeout); timers = []; window.__speakingNow = null; window.__cancels = (window.__cancels || 0) + 1; },
    set onvoiceschanged(f) {}
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth });
  // --- fake SpeechRecognition
  class SR {
    constructor() { window.__sr = this; this.results = []; }
    start() { this.results = []; this.running = true; setTimeout(() => this.onstart && this.onstart(), 0); }
    abort() { this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
    stop() { this.abort(); }
  }
  window.SpeechRecognition = SR;
  const emit = (text, isFinal, sameSlot) => {
    const sr = window.__sr; if (!sr || !sr.running) return false;
    const r = [{ transcript: text }]; r.isFinal = isFinal;
    if (sameSlot && sr.results.length) sr.results[sr.results.length - 1] = r; else sr.results.push(r);
    sr.onresult({ resultIndex: sr.results.length - 1, results: sr.results });
    return true;
  };
  window.__interim = (t) => emit(t, false, window.__sr.results.length && !window.__sr.results[window.__sr.results.length - 1].isFinal);
  window.__final = (t) => emit(t, true, window.__sr.results.length && !window.__sr.results[window.__sr.results.length - 1].isFinal);
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
};

const phase = (p) => p.evaluate(() => window.KAM_APP.st.phase);
const waitPhase = (p, want, ms = 15000) => p.waitForFunction((w) => window.KAM_APP.st.phase === w, want, { timeout: ms });
async function sellerSays(p, text) {
  await waitPhase(p, "listening");
  await p.waitForTimeout(1300);               // step outside the echo window
  await p.evaluate((t) => { window.__interim(t.split(" ").slice(0, 2).join(" ")); window.__final(t); }, text);
  await p.waitForFunction(() => window.KAM_APP.st.phase !== "listening", null, { timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (viewport) => {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|rejected the API key/.test(m.text())) errors.push("console: " + m.text()); });
    await p.addInitScript(FAKES);
    return p;
  };

  // ===== 1. Scripted backup brain, full call ====================================
  let p = await newPage();
  await p.goto(BASE);
  assert.match(await p.textContent("#brainBadge"), /Scripted backup/);
  await p.click("#callBtn");
  await p.waitForFunction(() => window.__spoken.length > 0);
  assert.match((await p.evaluate(() => window.__spoken.join(" "))), /Namaste Rajesh ji/);
  for (const line of ["My sales have dropped significantly this month. I don't understand why. Can you help me?",
    "My supplier delayed the shipment by two weeks", "I update it by hand once a week", "No I did not change any price", "Yes I will order by Thursday"]) {
    await sellerSays(p, line);
  }
  await waitPhase(p, "listening");
  assert.strictEqual(await p.locator(".action").count(), 4, "4 actions on tracker");
  assert.strictEqual(await p.locator("#practices .pill.muted-pill").count(), 1, "movement, min/max and enquiries checked");
  assert.match(await p.textContent("#practices"), /4 of 7 fast movers sold out/);
  assert.ok(await p.isVisible("#followup"), "follow-up visible");
  assert.ok(await p.isVisible("#waCard"), "whatsapp visible");
  assert.strictEqual(await p.locator("#diagnosis .pill.muted-pill").count(), 1, "only 'outside the data' unchecked");
  await p.screenshot({ path: path.join(__dirname, "shot-desktop.png"), fullPage: true });
  await sellerSays(p, "No thank you");
  await waitPhase(p, "ended");
  const spokenAll = await p.evaluate(() => window.__spoken.join(" | "));
  assert.match(spokenAll, /one lakh thirty-five thousand rupees/);
  assert.match(spokenAll, /thirty-two point five percent/);
  assert.ok(!/[₹%*#]/.test(spokenAll), "no symbols reach the voice");
  assert.ok(await p.locator(".tool.ok").count() >= 4, "number check passes on replies");
  assert.strictEqual(await p.locator(".tool.warn").count(), 0, "no figure flagged in the scripted flow");
  assert.ok(await p.locator(".tool.time").count() >= 5, "reply time is measured each turn");
  assert.match(await p.textContent("#stats"), /Tool calls made/);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#reportBtn")]);
  const report = require("fs").readFileSync(await dl.path(), "utf8");
  assert.match(report, /ACTION PLAN\n1\. Restock/); assert.match(report, /Follow-up call on/); assert.match(report, /Seller: My supplier delayed/);
  console.log("1 scripted call OK ·", await p.evaluate(() => window.__spoken.length), "sentences spoken");
  await p.context().close();

  // ===== 2. Gemini brain with a fake API =========================================
  p = await newPage();
  const reqs = []; let n = 0;
  const reply = (parts) => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] });
  await p.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const req = route.request(); const body = JSON.parse(req.postData());
    const model = req.url().match(/models\/([^:]+):/)[1];
    reqs.push({ model, body, key: req.headers()["x-goog-api-key"] });
    n++;
    if (n === 1) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Unknown name thinkingLevel: thinking config not supported" } }) });
    if (n === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "The model is overloaded" } }) });
    if (n === 3) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "The model is overloaded" } }) });
    if (n === 4) return route.fulfill({ json: reply([
      { functionCall: { name: "get_account_overview", args: {}, id: "c1" }, thoughtSignature: "SIG-A" },
      { functionCall: { name: "get_inventory_report", args: { top_n: 3 } } }]) });
    if (n === 5) return route.fulfill({ json: reply([{ text: "I have your account open, Rajesh ji. Sales are down 32.5% to ₹1,35,000, and 18 products are out of stock. What happened with the stock on your Dosa Tawa and Kadhai?" }]) });
    if (n === 6) return route.fulfill({ json: reply([{ text: "Understood. Let me explain slowly what I am seeing in your cancellations and your pricing and your traffic so that everything is clear to you before we plan the next steps together today. That is about ₹70,000." }]) });
    if (n === 7) return route.fulfill({ json: reply([{ text: "Thank you, Rajesh ji. Goodbye." }, { functionCall: { name: "end_call", args: {} }, thoughtSignature: "SIG-B" }]) });
    return route.fulfill({ json: reply([{ text: "Okay." }]) });
  });
  await p.goto(BASE);
  await p.click("#settingsBtn"); await p.fill("#keyInput", "TEST-KEY"); await p.click("#settings button.primary");
  assert.match(await p.textContent("#brainBadge"), /AI brain: gemini-3\.8-flash/);
  await p.click("#callBtn");
  await sellerSays(p, "My sales have dropped significantly this month");
  await waitPhase(p, "listening");
  // request 1 had thinkingConfig, retry (2) did not; 2,3 were 503 on first model; 4 went to fallback model
  assert.ok(reqs[0].body.generationConfig.thinkingConfig, "first request asks for low thinking");
  assert.ok(!reqs[1].body.generationConfig.thinkingConfig, "retry drops thinkingConfig after 400");
  assert.strictEqual(reqs[0].key, "TEST-KEY");
  assert.strictEqual(reqs[3].model, "gemini-3.6-flash", "falls back to next model after two 503s");
  const c5 = reqs[4].body.contents;
  const modelTurn = c5[c5.length - 2], toolTurn = c5[c5.length - 1];
  assert.strictEqual(modelTurn.parts[0].thoughtSignature, "SIG-A", "thought signature is sent back");
  assert.strictEqual(toolTurn.role, "user");
  assert.strictEqual(toolTurn.parts.length, 2);
  assert.strictEqual(toolTurn.parts[0].functionResponse.id, "c1");
  assert.strictEqual(toolTurn.parts[0].functionResponse.response.change.sales_drop_rupees, 65000);
  assert.strictEqual(toolTurn.parts[1].functionResponse.response.est_sales_lost_to_stockouts_rupees, 47900);
  assert.ok(reqs[4].body.systemInstruction.parts[0].text.includes("Every number you say must come from a tool result"));
  assert.strictEqual(reqs[4].body.tools[0].functionDeclarations.length, 16);
  let spoken = await p.evaluate(() => window.__spoken.join(" | "));
  assert.match(spoken, /let me pull up your account/i, "filler spoken while tools run");
  assert.match(reqs[4].body.systemInstruction.parts[0].text, /CALL TYPE: The seller called you/);
  console.log("2a tool loop, signature echo, retry and model fallback OK");

  // --- echo must NOT interrupt; real speech must
  await p.evaluate(() => { window.__msPerChar = 40; });
  await sellerSays(p, "My supplier was late");
  await waitPhase(p, "speaking");
  await p.waitForTimeout(300);
  const cancelsBefore = await p.evaluate(() => window.__cancels || 0);
  await p.evaluate(() => window.__interim("what I am seeing in your cancellations"));   // the bot's own words
  await p.waitForTimeout(200);
  assert.strictEqual(await phase(p), "speaking", "echo does not interrupt");
  assert.strictEqual(await p.evaluate(() => window.__cancels || 0), cancelsBefore);
  await p.evaluate(() => window.__interim("wait"));
  await p.waitForTimeout(100);
  assert.strictEqual(await phase(p), "speaking", "one word is not enough to interrupt");
  await p.evaluate(() => window.__interim("wait one second please"));
  await p.waitForTimeout(100);
  assert.strictEqual(await phase(p), "listening", "seller speech interrupts the bot");
  assert.ok(await p.evaluate(() => window.__speakingNow === null), "voice stopped");
  assert.strictEqual(await p.locator(".bubble.kam.cut").count(), 1);
  assert.match(await p.textContent(".tool.warn"), /not found in account data: 70000/, "an invented figure is flagged");
  assert.strictEqual(await p.evaluate(() => window.KAM_APP.st.stats.interruptions), 1);
  await p.evaluate(() => { window.__msPerChar = 4; window.__final("wait one second please, that is all, thank you bye"); });
  await waitPhase(p, "ended");
  const lastUser = reqs[reqs.length - 1].body.contents.filter((c) => c.role === "user" && c.parts[0].text).pop().parts[0].text;
  assert.match(lastUser, /^\[Seller interrupted you\] wait one second please/);
  console.log("2b echo filter, barge-in, interruption note and end_call OK");
  await p.context().close();

  // ===== 3. Bad key, Hindi mode, mobile layout ==================================
  p = await newPage({ width: 390, height: 844 });
  await p.route("https://generativelanguage.googleapis.com/**", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }) }));
  await p.goto(BASE);
  await p.click("#settingsBtn"); await p.fill("#keyInput", "BAD"); await p.click("#settings button.primary");
  await p.click("#callBtn");
  await sellerSays(p, "sales are down");
  await waitPhase(p, "listening");
  assert.match(await p.textContent("#banner"), /rejected the API key/);
  await p.click("#callBtn");
  await p.click("#settingsBtn"); await p.fill("#keyInput", ""); await p.click("#settings button.primary");
  await p.selectOption("#langSel", "hi");
  await p.click("#callBtn");
  await sellerSays(p, "मेरी बिक्री बहुत कम हो गई है");
  await waitPhase(p, "listening");
  spoken = await p.evaluate(() => window.__spoken.join(" | "));
  assert.match(spoken, /नमस्ते राजेश जी/); assert.match(spoken, /32\.5 प्रतिशत/); assert.match(spoken, /135000 रुपये/);
  assert.strictEqual(await p.evaluate(() => window.__sr.lang), "hi-IN");
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, "no horizontal scroll on phone, got " + overflow);
  await p.screenshot({ path: path.join(__dirname, "shot-mobile.png"), fullPage: true });
  console.log("3 bad-key message, Hindi call and phone layout OK");

  // ===== 4. Outbound (proactive) call ============================================
  p = await newPage();
  await p.goto(BASE);
  assert.match(await p.textContent("#alertStrip"), /Sales down 32\.5%.*Cancellations up 6 pts.*Out of stock 18/);
  await p.click("#outBtn");
  await p.waitForFunction(() => window.__spoken.length >= 3);
  spoken = await p.evaluate(() => window.__spoken.join(" "));
  assert.match(spoken, /I am calling because I noticed your sales are down thirty-two point five percent/);
  assert.match(await p.evaluate(() => window.KAM_APP.st.history[0].parts[0].text), /^\[Outbound call\./);
  assert.match(await p.evaluate(() => window.KAM_PROMPT.buildSystemPrompt("en", window.KAM_BRAIN.cfg.callType)), /CALL TYPE: You called the seller/);
  await sellerSays(p, "Yes sure, tell me");
  await waitPhase(p, "listening");
  assert.ok(await p.locator("#diagnosis .pill.main").count() === 1, "diagnosis starts after he agrees");
  console.log("4 outbound call OK");

  // ===== 5. View switch ===========================================================
  assert.ok(await p.isVisible(".side"), "agent view is the default");
  await p.click("#viewSeller");
  assert.ok(!(await p.isVisible(".side")), "seller view hides the agent panels");
  assert.ok(!(await p.isVisible("#alertStrip")) && !(await p.isVisible(".tool")), "seller view hides alert strip and tool chips");
  assert.ok(await p.isVisible("#orb") && await p.isVisible(".bubble.kam"), "the call itself stays");
  assert.strictEqual(await p.getAttribute("#viewSeller", "aria-pressed"), "true");
  await sellerSays(p, "My supplier was late");
  await waitPhase(p, "listening");
  assert.ok(await p.evaluate(() => window.KAM_TOOLS.session.checked.cancellations), "agent keeps working in seller view");
  await p.screenshot({ path: path.join(__dirname, "shot-seller.png") });
  await p.reload();
  assert.ok(!(await p.isVisible(".side")), "the chosen view is remembered");
  await p.click("#viewAgent");
  assert.ok(await p.isVisible(".side"));
  await p.setViewportSize({ width: 390, height: 800 });
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, "no sideways scroll on phone with the switch");
  await p.screenshot({ path: path.join(__dirname, "shot-m.png") });
  console.log("5 view switch OK");

  await browser.close();
  if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); process.exit(1); }
  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
