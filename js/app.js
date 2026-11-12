/* ============================================================================
 * app.js — runs the call. Connects ears, brain, mouth and the on-screen panels.
 *
 * Call phases:  idle -> listening <-> thinking <-> speaking -> ended
 *   seller speaks  -> Ears.onUtterance -> handleSellerText -> runTurn (brain)
 *   brain answers  -> botSay -> Mouth speaks -> settle() -> listening again
 *   seller talks over the bot -> bargeIn() stops the voice at once
 * ========================================================================== */
(function () {
  const { Mouth, Ears, toSpeech } = window.KAM_SPEECH;
  const T = window.KAM_TOOLS, Brain = window.KAM_BRAIN, D = window.KAM_DATA, X = T.derived, Guard = window.KAM_GUARD;
  const $ = (id) => document.getElementById(id);
  const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const GREETING = {
    en: `Namaste ${D.seller.spokenName}, this is Priya, your account manager from Snapdeal. How can I help you today?`,
    hi: "नमस्ते राजेश जी, मैं प्रिया बोल रही हूँ, स्नैपडील से आपकी अकाउंट मैनेजर। बताइए, मैं आपकी क्या मदद कर सकती हूँ?"
  };
  // Outbound call: the KAM phones the seller because an alert fired. The figure comes from the alert rule.
  const OUT_GREETING = {
    en: (a) => `Namaste ${D.seller.spokenName}, this is Priya, your account manager from Snapdeal. I am calling because I noticed your sales are down ${a.value}% this month, and I would like to help you fix it. Do you have two minutes to talk?`,
    hi: (a) => `नमस्ते राजेश जी, मैं प्रिया बोल रही हूँ, स्नैपडील से आपकी अकाउंट मैनेजर। मैंने देखा कि इस महीने आपकी बिक्री ${a.value}% कम हुई है, और मैं इसे ठीक करने में आपकी मदद करना चाहती हूँ। क्या आपके पास दो मिनट हैं?`
  };
  const STILL_THERE = { en: `${D.seller.spokenName}, are you still there?`, hi: "राजेश जी, क्या आप लाइन पर हैं?" };
  const NO_RESPONSE = {
    en: "I am not able to hear you, so I will end the call for now. Please call back any time. Thank you.",
    hi: "मुझे आपकी आवाज़ नहीं आ रही है, इसलिए मैं अभी कॉल रख रही हूँ। आप कभी भी दोबारा कॉल कर सकते हैं। धन्यवाद।"
  };

  const st = {
    phase: "idle", lang: "en", history: [], bargeIn: true,
    inFlight: null,          // AbortController of the running brain turn
    seq: 0, snapshot: 0,     // turn counter + history length to roll back to on abort
    bot: { text: "", endedAt: 0 }, botFresh: true, lastKamBubble: null,
    interrupted: false, pendingEnd: false, echoPending: false,
    silenceTimer: null, silenceStage: 0, callStart: 0, tick: null,
    callType: "inbound", log: [], heardAt: 0,
    stats: { replyMs: [], tools: 0, verified: 0, flagged: 0, interruptions: 0 }
  };

  // ------------------------------ Small UI helpers ------------------------------
  const PHASE_LABEL = { idle: "Ready", listening: "Listening…", thinking: "Checking your account…", speaking: "Priya is speaking", ended: "Call ended" };
  const PHASE_ICON = { idle: "📞", listening: "🎙️", thinking: "⏳", speaking: "🔊", ended: "📞" };
  function setPhase(p) {
    st.phase = p;
    $("orb").className = "orb " + p;
    $("phase").textContent = PHASE_LABEL[p];
    $("orbIcon").textContent = PHASE_ICON[p];
    $("orb").setAttribute("aria-label", p === "speaking" ? "Interrupt Priya" : p === "idle" || p === "ended" ? "Start call" : "Call in progress");
  }
  function caption(who, text) { const c = $("caption"); c.className = "caption " + who; c.textContent = text; }
  function banner(msg, isError) {
    const b = $("banner");
    if (!msg) { b.hidden = true; return; }
    b.hidden = false; b.textContent = msg; b.className = "banner" + (isError ? " error" : "");
  }
  function addRow(cls, text) {
    const el = document.createElement("div"); el.className = cls; el.textContent = text;
    const box = $("transcript"); box.appendChild(el); box.scrollTop = box.scrollHeight;
    st.log.push((cls.includes("seller") ? "Seller: " : cls.includes("kam") ? "Priya: " : "   ") + text);   // kept for the call report
    return el;
  }
  function inCall() { return st.phase !== "idle" && st.phase !== "ended"; }

  // ------------------------------ Right-hand panels -----------------------------
  function renderMetrics() {
    const a = D.given.lastMonth, b = D.given.thisMonth;
    const rows = [
      ["Sales", inr(a.sales), inr(b.sales), `−${((a.sales - b.sales) / a.sales * 100).toFixed(1)}%`, "bad"],
      ["Orders", a.orders, b.orders, `−${((a.orders - b.orders) / a.orders * 100).toFixed(1)}%`, "bad"],
      ["Cancellation rate", Math.round(a.cancellationRate * 100) + "%", Math.round(b.cancellationRate * 100) + "%", `+${Math.round((b.cancellationRate - a.cancellationRate) * 100)} pts`, "bad"],
      ["Avg selling price", inr(a.asp), inr(b.asp), "flat", "flat"],
      ["Out-of-stock products", a.outOfStock, b.outOfStock, `+${b.outOfStock - a.outOfStock}`, "bad"]
    ];
    $("metrics").innerHTML = `<tr><th>Metric</th><th class="n">Last month</th><th class="n">This month</th><th class="n">Change</th></tr>` +
      rows.map((r) => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="n">${r[2]}</td><td class="n delta ${r[4]}">${r[3]}</td></tr>`).join("");
  }

  function renderDiagnosis() {
    const c = T.session.checked, t = D.traffic;
    const visits = ((t.thisMonth.visits - t.lastMonth.visits) / t.lastMonth.visits * 100).toFixed(1);
    const external = T.session.sellerInputs.filter((i) => i.topic === "external");
    const rows = [
      ["Inventory", c.inventory, "main", "Main cause", `${X.b.outOfStock} products out of stock (was ${X.a.outOfStock}). Est. ${inr(X.stockoutLoss)} of sales lost.`],
      ["Cancellations", c.cancellations, "contrib", "Contributing", `${X.stockCancels} of ${X.cancelledB} cancelled orders had no stock. Est. ${inr(X.extraCancelLoss)} lost.`],
      ["Pricing", c.pricing, "out", "Ruled out", `Average selling price unchanged at ${inr(X.b.asp)}. No competitor data, so the seller is asked.`],
      ["Visibility", c.visibility, "out", "Not the main cause", `Store visits ${visits}%. Shoppers still arrive but fewer can buy.`],
      ["Outside the data", external.length > 0, "ask", "From seller", external.map((i) => i.note).join(" ") || ""]
    ];
    $("diagnosis").innerHTML = rows.map(([name, done, cls, label, why]) => done
      ? `<li><span class="name">${name}</span><span class="pill ${cls}">${label}</span><span class="why">${esc(why)}</span></li>`
      : `<li><span class="name">${name}</span><span class="pill muted-pill">Not checked yet</span></li>`).join("");

    const br = $("bridge");
    if (c.bridge || (c.inventory && c.cancellations)) {
      const parts = [["Stockouts", X.stockoutLoss, "#d81b4d"], ["Extra cancellations", X.extraCancelLoss, "#e39a1c"], ["Not explained by data", X.otherLoss, "#b9b3a8"]];
      br.hidden = false;
      br.innerHTML = `<div class="section-title">Where the ${inr(X.salesDrop)} went <span class="muted">estimate</span></div>` +
        `<div class="bar">${parts.map((p) => `<span style="width:${p[1] / X.salesDrop * 100}%;background:${p[2]}"></span>`).join("")}</div>` +
        `<div class="legend">${parts.map((p) => `<div><span><i class="sw" style="background:${p[2]}"></i>${p[0]}</span><b>${inr(p[1])}</b></div>`).join("")}</div>`;
    } else br.hidden = true;

    const said = $("sellerSaid"), inputs = T.session.sellerInputs.filter((i) => i.topic !== "external");
    said.hidden = inputs.length === 0;
    said.innerHTML = `<b>What the seller told us</b><ul>${inputs.map((i) => `<li>${esc(i.note)}</li>`).join("")}</ul>`;
  }

  // Second layer: not "what went wrong" but "how should he run stock from now on".
  function renderPractices() {
    const c = T.session.checked, sp = T.session.stockPlan;
    const mv = c.movement ? T.run("get_product_movement") : null;
    const en = c.enquiries ? T.run("get_customer_enquiries") : null;
    const dp = c.dispatch ? T.run("get_dispatch_report") : null;
    const rows = [
      ["Fast and slow movers", mv, "main", mv && `${mv.fast_movers_out_of_stock_count} of ${mv.fast_movers} fast movers sold out`,
        mv && `${inr(mv.money_locked_in_slow_stock_rupees)} is locked in ${mv.slow_movers_with_excess_stock.length} slow products. ${mv.ageing_stock_products} have stock older than ${mv.ageing_rule_days} days: sell oldest first (FIFO).`],
      ["Min / max stock levels", sp, "contrib", sp && `Order ${sp.rows.reduce((t, r) => t + r.order_now_units, 0)} units now`,
        sp && `Lead time ${sp.lead} days. ` + sp.rows.filter((r) => r.order_now_units).map((r) => `${r.name}: min ${r.min_level}, max ${r.max_level}`).slice(0, 3).join(" · ") + "."],
      ["Customer enquiries", en, "ask", en && `${en.customers_waiting_for_restock_total} customers waiting`,
        en && `Most asked: ${en.most_requested_sold_out_products[0].name} (${en.most_requested_sold_out_products[0].customers_waiting}). Not listed but searched: ${en.searched_but_not_listed[0].product} (${en.searched_but_not_listed[0].searches_this_month}).`],
      ["Dispatch speed", dp, "contrib", dp && `${dp.avg_dispatch_days_this_month} days (was ${dp.avg_dispatch_days_last_month})`,
        dp && `${dp.orders_cancelled_for_late_dispatch} orders cancelled for late dispatch. Keep fast movers packed on a ready shelf.`]
    ];
    $("practices").innerHTML = rows.map(([name, done, cls, label, why]) => done
      ? `<li><span class="name">${name}</span><span class="pill ${cls}">${esc(label)}</span><span class="why">${esc(why)}</span></li>`
      : `<li><span class="name">${name}</span><span class="pill muted-pill">Not checked yet</span></li>`).join("");
  }

  function renderActions() {
    const s = T.session, box = $("actions"), cnt = $("actionCount");
    if (!s.actions.length) { box.className = "empty"; box.textContent = "The agreed plan appears here."; cnt.textContent = "waiting"; }
    else {
      box.className = "";
      box.innerHTML = s.actions.map((a) => `<div class="action"><b>${a.priority}. ${esc(a.title)}</b><span>${esc(a.owner)} · due ${esc(a.due)} · ${esc(a.expected_impact)}</span></div>`).join("");
      cnt.textContent = s.actions.length + " committed";
    }
    const f = $("followup");
    f.hidden = !s.followUp;
    if (s.followUp) f.textContent = `📅 Follow-up call: ${s.followUp.date} — ${s.followUp.agenda}`;
    $("waCard").hidden = !s.summary;
    if (s.summary) $("wa").innerHTML = `<span class="to">To ${esc(s.summary.to)}</span>${esc(s.summary.message)}`;
  }
  function renderStats() {
    const s = st.stats, avg = s.replyMs.length ? (s.replyMs.reduce((a, b) => a + b, 0) / s.replyMs.length / 1000).toFixed(1) + " s" : "–";
    $("stats").innerHTML =
      `<div><b>${avg}</b><span>Avg time to first word</span></div>` +
      `<div><b>${s.tools}</b><span>Tool calls made</span></div>` +
      `<div><b>${s.verified}${s.flagged ? " · " + s.flagged + " ⚠" : ""}</b><span>Figures checked against data</span></div>` +
      `<div><b>${s.interruptions}</b><span>Interruptions handled</span></div>`;
  }
  function renderAlerts() {
    const alerts = T.checkAlerts(), strip = $("alertStrip");
    strip.hidden = alerts.length === 0;
    strip.innerHTML = `<b>⚠ Monitoring alert on this seller</b>` + alerts.map((a) => `<span title="Rule: ${esc(a.rule)}">${esc(a.text)}</span>`).join("");
    $("outBtn").disabled = alerts.length === 0;
  }
  function renderAll() { renderMetrics(); renderDiagnosis(); renderPractices(); renderActions(); renderStats(); renderAlerts(); }

  function toolSummary(name, r) {
    switch (name) {
      case "get_account_overview": return `sales −${r.change.sales_drop_pct}%, out of stock ${r.this_month.out_of_stock_products}`;
      case "get_inventory_report": return `stockouts ≈ ${inr(r.est_sales_lost_to_stockouts_rupees)} lost`;
      case "get_cancellation_report": return `${r.orders_cancelled_this_month} cancelled, ${r.reasons_this_month[0].orders} for no stock`;
      case "get_pricing_and_visibility": return `price flat, visits ${r.visits_change_pct}%`;
      case "get_sales_bridge": return r.parts.map((p) => inr(p.rupees)).join(" + ");
      case "get_product_movement": return `${r.fast_movers_out_of_stock_count} of ${r.fast_movers} fast movers out, ${inr(r.money_locked_in_slow_stock_rupees)} in slow stock`;
      case "get_stock_plan": return `min/max set, order ${r.total_units_to_order_now} units now`;
      case "get_customer_enquiries": return `${r.customers_waiting_for_restock_total} customers waiting`;
      case "get_dispatch_report": return `dispatch ${r.avg_dispatch_days_this_month} days`;
      case "estimate_recovery": return `≈ ${inr(r.total_monthly_recovery_rupees)}/month recoverable`;
      case "commit_action_plan": return `${r.actions_on_tracker} actions saved`;
      case "schedule_followup": return r.date;
      case "send_summary": return "WhatsApp sent (simulated)";
      case "set_language": return r.language === "hi" ? "Hindi" : "English";
      case "log_seller_input": return "noted";
      default: return r.error || "done";
    }
  }
  function onTool(name, args, result) {
    addRow("tool", `⚙ ${name}() → ${toolSummary(name, result)}`);
    Guard.learn(result);                           // remember these numbers for the number check
    st.stats.tools++; renderStats();
    if (name === "set_language" && result.language) switchLang(result.language);
    renderDiagnosis(); renderPractices(); renderActions();
  }

  // --------------------------------- Speaking ------------------------------------
  function botSay(text) {
    if (!text) return;
    if (st.botFresh) { st.bot.text = ""; st.botFresh = false; }
    st.bot.text += " " + text + " " + toSpeech(text, st.lang);   // kept for echo detection
    st.lastKamBubble = addRow("bubble kam", text);
    caption("kam", text);
    const g = Guard.check(text);                   // is every figure in this reply one we have seen in the data?
    if (g.checked) {
      st.stats.verified += g.checked - g.unknown.length; st.stats.flagged += g.unknown.length;
      if (g.unknown.length) addRow("tool warn", `⚠ not found in account data: ${g.unknown.join(", ")}`);
      else addRow("tool ok", `✓ ${g.checked} figure${g.checked > 1 ? "s" : ""} match account data`);
      renderStats();
    }
    clearSilence();
    if (!window.speechSynthesis) { banner("This browser cannot speak (no speechSynthesis). Use Chrome or Edge.", true); return; }
    Mouth.say(text, st.lang);
  }
  Mouth.onStart = () => {
    if (!inCall()) return;
    setPhase("speaking");
    if (st.heardAt) {                               // time from "seller finished" to "first word spoken"
      const ms = Math.round(performance.now() - st.heardAt); st.heardAt = 0;
      st.stats.replyMs.push(ms); addRow("tool time", `⏱ ${(ms / 1000).toFixed(1)} s to first word`); renderStats();
    }
  };
  Mouth.onDrained = () => { st.bot.endedAt = Date.now(); settle(); };

  // Decide what happens after the bot stops talking or a turn finishes.
  function settle() {
    if (!inCall() || Mouth.speaking) return;
    if (st.pendingEnd) return endCall();
    if (st.inFlight) return setPhase("thinking");
    setPhase("listening"); armSilence();
  }

  // --------------------------------- Listening -----------------------------------
  const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const botWords = () => new Set(words(st.bot.text));
  // Words the bot did not just say. If the mic hears only the bot's own words, it is echo from the speakers.
  function novelWords(text) { const bot = botWords(); return words(text).filter((x) => !bot.has(x)); }
  function isEcho(text) {
    const w = words(text); if (!w.length) return true;
    const novel = novelWords(text).length;
    return novel === 0 || (w.length >= 5 && novel / w.length < 0.25);   // allow a few mis-heard words
  }
  // When echo and the seller's words land in one transcript, drop the echoed start.
  function stripLeadingEcho(text) {
    const bot = botWords(), parts = text.split(/\s+/);
    let i = 0;
    while (i < parts.length && words(parts[i]).every((w) => bot.has(w))) i++;
    return i >= 3 ? parts.slice(i).join(" ") : text;
  }
  const inEchoWindow = () => Mouth.speaking || Date.now() - st.bot.endedAt < 1200;

  Ears.onInterim = (text) => {
    if (!inCall()) return;
    if (inEchoWindow()) {
      if (isEcho(text)) { st.echoPending = true; return; }
      if (Mouth.speaking) {
        if (!st.bargeIn) return;
        if (novelWords(text).length < 2) return;   // wait for a second real word before cutting the bot off
        bargeIn();
      }
    }
    clearSilence();
    caption("seller", st.echoPending ? stripLeadingEcho(text) : text);
  };
  Ears.onUtterance = (text) => {
    if (!inCall()) return;
    const hadEcho = st.echoPending; st.echoPending = false;
    if ((hadEcho || inEchoWindow()) && isEcho(text)) return;
    if (Mouth.speaking) {
      if (!st.bargeIn || novelWords(text).length < 2) return;
      bargeIn();
    }
    if (hadEcho) text = stripLeadingEcho(text);
    if (text) handleSellerText(text);
  };
  Ears.onError = (code) => {
    const msg = {
      "not-allowed": "Microphone is blocked. Click the lock icon in the address bar, allow the microphone, then start the call again.",
      "service-not-allowed": "Speech recognition is not allowed in this browser. Use Chrome or Edge on desktop.",
      "audio-capture": "No microphone was found. Plug one in and start the call again.",
      "network": "Speech recognition cannot reach its service. If this is Brave or another privacy browser, switch to Chrome or Edge. Otherwise check your internet; it will retry.",
      "language-not-supported": "This browser cannot recognise this language. Try Chrome."
    }[code];
    if (msg) banner(msg, true);
  };

  function bargeIn() {
    Mouth.stop();
    st.bot.endedAt = Date.now();
    st.interrupted = true; st.pendingEnd = false;
    st.stats.interruptions++; renderStats();
    if (st.lastKamBubble) st.lastKamBubble.classList.add("cut");
    if (st.inFlight) abortTurn();
    setPhase("listening");
  }
  function abortTurn() {
    if (!st.inFlight) return;
    st.inFlight.abort(); st.inFlight = null; st.seq++;
    st.history.length = st.snapshot;               // drop the half-finished model/tool messages
  }

  // ----------------------------------- Turns --------------------------------------
  function handleSellerText(text) {
    if (!inCall()) return;
    clearSilence(); st.silenceStage = 0;
    addRow("bubble seller", text); caption("seller", text);
    Guard.learn(text);                              // numbers the seller says are fair to repeat
    st.heardAt = performance.now();
    if (st.inFlight) abortTurn();                  // seller added more while we were thinking
    let msg = text;
    if (st.interrupted) { msg = "[Seller interrupted you] " + text; st.interrupted = false; }
    const last = st.history[st.history.length - 1];
    if (last && last.role === "user" && last.parts[0] && typeof last.parts[0].text === "string") last.parts[0].text += " " + msg;
    else st.history.push({ role: "user", parts: [{ text: msg }] });
    runTurn(text);
  }

  async function runTurn(userText) {
    const seq = ++st.seq, ctrl = new AbortController();
    st.inFlight = ctrl; st.snapshot = st.history.length; st.botFresh = true;
    if (!Mouth.speaking) setPhase("thinking");
    try {
      const res = await Brain.turn({
        history: st.history, userText, getLang: () => st.lang, signal: ctrl.signal,
        onSpeech: (t) => { if (seq === st.seq) botSay(t); },
        onTool: (n, a, r) => { if (seq === st.seq) onTool(n, a, r); }
      });
      if (seq !== st.seq) return;
      st.inFlight = null;
      if (res.endCall) st.pendingEnd = true;
      if (res.text) {
        if (Brain.mode() === "scripted") st.history.push({ role: "model", parts: [{ text: res.text }] });
        botSay(res.text);
      }
      banner("");
    } catch (e) {
      if (seq !== st.seq || e.name === "AbortError") return;
      st.inFlight = null; st.history.length = st.snapshot;
      console.error(e);
      banner("AI brain error: " + e.message + (e.fatal ? " Open Settings and check the key." : ""), true);
      botSay(Brain.lines(st.lang).trouble);
    }
    settle();
  }

  // ------------------------------- Silence handling -------------------------------
  function clearSilence() { clearTimeout(st.silenceTimer); }
  function armSilence() {
    clearSilence();
    st.silenceTimer = setTimeout(() => {
      if (st.phase !== "listening" || Mouth.speaking) return;
      const line = st.silenceStage === 0 ? STILL_THERE[st.lang] : NO_RESPONSE[st.lang];
      if (st.silenceStage++ > 0) st.pendingEnd = true;
      const last = st.history[st.history.length - 1];
      if (last && last.role === "model" && last.parts[0] && typeof last.parts[0].text === "string") last.parts[0].text += " " + line;
      st.botFresh = true; botSay(line);
    }, st.silenceStage === 0 ? 12000 : 14000);
  }

  // ------------------------------- Call lifecycle ---------------------------------
  async function startCall(callType) {
    banner("");
    callType = callType === "outbound" ? "outbound" : "inbound";
    if (navigator.brave) return banner("Brave blocks browser speech recognition, so the KAM cannot hear you. Open this page in Google Chrome or Microsoft Edge.", true);
    if (!Ears.supported) banner("This browser has no speech recognition. Open this page in Chrome or Edge on a computer. You can still type below to test.", true);
    else {
      try {
        if (!navigator.mediaDevices) throw Object.assign(new Error("insecure"), { name: "Insecure" });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });   // triggers the permission prompt
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        return banner(e.name === "Insecure" ? "The microphone only works on https:// or http://localhost. See README for how to run it."
          : "Microphone permission was denied. Allow the microphone for this page and press Start call again.", true);
      }
    }
    T.resetSession(); Brain.reset(); if (Mouth.speaking) Mouth.stop();
    const alert = T.checkAlerts()[0];
    const greeting = callType === "outbound" && alert ? OUT_GREETING[st.lang](alert) : GREETING[st.lang];
    Guard.reset(); Guard.learn(T.checkAlerts());
    Brain.cfg.callType = callType;
    st.stats = { replyMs: [], tools: 0, verified: 0, flagged: 0, interruptions: 0 };
    $("transcript").innerHTML = ""; renderAll(); updateBadge();
    Object.assign(st, { callType, log: [], heardAt: 0, history: [], echoPending: false, interrupted: false, pendingEnd: false, silenceStage: 0, inFlight: null, botFresh: true, callStart: Date.now() });
    st.history.push({ role: "user", parts: [{ text: callType === "outbound"
      ? `[Outbound call. You phoned the seller because this alert fired: ${T.checkAlerts().map((a) => a.text).join("; ")}. He has picked up.]`
      : "[Inbound call. The seller phoned you. You have picked up.]" }] });
    st.history.push({ role: "model", parts: [{ text: greeting }] });
    $("callBtn").textContent = "End call"; $("callBtn").classList.add("end");
    $("outBtn").hidden = true; $("reportBtn").hidden = true;
    clearInterval(st.tick);
    st.tick = setInterval(() => {
      const s = Math.floor((Date.now() - st.callStart) / 1000);
      $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 500);
    setPhase("listening");
    addRow("sys", callType === "outbound" ? "Outbound call: KAM called the seller after an alert" : "Inbound call: seller called the KAM");
    if (Ears.supported) Ears.start(st.lang);
    botSay(greeting);
    if (!window.speechSynthesis) settle();
  }

  function endCall() {
    if (!inCall()) return;
    clearSilence(); clearInterval(st.tick);
    if (st.inFlight) { st.inFlight.abort(); st.inFlight = null; st.seq++; }
    Ears.stop(); Mouth.stop();
    setPhase("ended");
    $("callBtn").textContent = "Seller calls KAM"; $("callBtn").classList.remove("end");
    $("outBtn").hidden = false; $("reportBtn").hidden = false;
    addRow("sys", "Call ended · " + $("timer").textContent);
    const s = T.session;
    caption("kam", s.actions.length ? `Call ended. ${s.actions.length} actions on the tracker${s.followUp ? ", follow-up on " + s.followUp.date : ""}.` : "Call ended.");
  }

  // A plain-text record of the call: what was found, what was agreed, what happens next.
  function downloadReport() {
    const s = T.session, c = s.checked, q = st.stats;
    const avg = q.replyMs.length ? (q.replyMs.reduce((a, b) => a + b, 0) / q.replyMs.length / 1000).toFixed(1) + " s" : "n/a";
    const lines = [
      "VIRTUAL KAM - CALL REPORT (prototype, mock data)", "",
      `Seller: ${D.seller.name}, ${D.seller.shop}`,
      `Date: ${new Date().toLocaleString("en-IN")}   Duration: ${$("timer").textContent}`,
      `Call type: ${st.callType}   Language: ${st.lang === "hi" ? "Hindi" : "English"}   Brain: ${Brain.mode() === "gemini" ? Brain.cfg.model : "scripted backup"}`, "",
      "KEY ISSUES",
      c.inventory ? `- Inventory (main cause): ${X.b.outOfStock} products out of stock, was ${X.a.outOfStock}. Est. ${inr(X.stockoutLoss)} of sales lost.` : "- Inventory: not checked",
      c.cancellations ? `- Cancellations (contributing): ${X.stockCancels} of ${X.cancelledB} cancelled orders had no stock. Est. ${inr(X.extraCancelLoss)} lost.` : "- Cancellations: not checked",
      c.pricing ? `- Pricing: ruled out, average selling price unchanged at ${inr(X.b.asp)}.` : "- Pricing: not checked", "",
      "STOCK PRACTICES CHECKED", ...[...$("practices").querySelectorAll("li")].map((li) => "- " + li.innerText.replace(/\s*\n\s*/g, " | ")), "",
      "WHAT THE SELLER TOLD US", ...(s.sellerInputs.length ? s.sellerInputs.map((i) => `- [${i.topic}] ${i.note}`) : ["- nothing recorded"]), "",
      "ACTION PLAN", ...(s.actions.length ? s.actions.map((a) => `${a.priority}. ${a.title} | ${a.owner} | due ${a.due} | ${a.expected_impact}`) : ["- no plan agreed"]), "",
      "NEXT STEP", s.followUp ? `Follow-up call on ${s.followUp.date}: ${s.followUp.agenda} (simulated)` : "No follow-up booked", "",
      "WHATSAPP SUMMARY (simulated)", s.summary ? s.summary.message : "Not sent", "",
      "CALL QUALITY", `Avg time to first word: ${avg}   Tool calls: ${q.tools}   Figures checked: ${q.verified} ok, ${q.flagged} flagged   Interruptions: ${q.interruptions}`, "",
      "TRANSCRIPT", ...st.log
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    a.download = "virtual-kam-call-report.txt"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function switchLang(lang) {
    if (lang === st.lang) return;
    st.lang = lang; $("langSel").value = lang;
    if (inCall() && Ears.supported) Ears.start(lang);          // restart recognition in the new language
    if (lang === "hi" && Mouth.voices("hi").length === 0) banner("No Hindi voice is installed in this browser. Chrome and Edge on desktop include one.", true);
  }

  // ---------------------------------- View switch ---------------------------------
  // Seller view = only the call (what the seller experiences).
  // Agent view  = the call plus the panels that show what the agent sees and does.
  // Only the display changes. The agent runs the same way in both views.
  function setView(view) {
    view = view === "seller" ? "seller" : "agent";
    document.body.classList.toggle("view-seller", view === "seller");
    $("viewSeller").setAttribute("aria-pressed", String(view === "seller"));
    $("viewAgent").setAttribute("aria-pressed", String(view === "agent"));
    try { localStorage.setItem("kam_view", view); } catch (x) {}
    const box = $("transcript"); box.scrollTop = box.scrollHeight;
  }

  // --------------------------------- Settings -------------------------------------
  function updateBadge() {
    const b = $("brainBadge"), mode = Brain.mode();
    $("keyInput").closest("label").style.display = Brain.cfg.proxy ? "none" : "";   // server already has a key: hide the key box
    b.className = "badge" + (mode === "scripted" ? " scripted" : "");
    b.textContent = mode === "scripted" ? "Scripted backup · add a Gemini key in Settings" : "AI brain: " + Brain.cfg.model + (Brain.cfg.proxy && !Brain.cfg.apiKey ? " (server key)" : "");
  }
  Brain.onStatus = (model) => { if (model !== Brain.cfg.model) addRow("sys", `Switched to ${model} (first choice was busy)`); };

  function fillVoices() {
    [["voiceEn", "en"], ["voiceHi", "hi"]].forEach(([id, lang]) => {
      const sel = $(id), list = Mouth.voices(lang), best = Mouth.pickVoice(lang);
      sel.innerHTML = list.length ? list.map((v) => `<option ${best && v.name === best.name ? "selected" : ""}>${esc(v.name)}</option>`).join("") : "<option>No voice installed</option>";
    });
  }
  Mouth.onVoices = fillVoices;

  function init() {
    renderAll(); setPhase("idle");
    if (location.protocol === "file:") banner("Opened as a file: the browser will keep asking for the microphone. Run it on http://localhost or an https link instead (see README).", false);
    try { Brain.cfg.apiKey = sessionStorage.getItem("kam_key") || ""; Brain.cfg.model = sessionStorage.getItem("kam_model") || Brain.cfg.model; } catch (e) {}
    $("keyInput").value = Brain.cfg.apiKey;
    $("modelSel").innerHTML = Brain.MODELS.map((m) => `<option ${m === Brain.cfg.model ? "selected" : ""}>${m}</option>`).join("");
    fillVoices(); updateBadge();
    // On the hosted demo the key lives on the server, so the key field is not shown at all.
    Brain.detectProxy().then((hasServerKey) => {
      $("keyRow").hidden = hasServerKey; $("keyHelp").hidden = hasServerKey;
      updateBadge();
    });

    $("callBtn").onclick = () => (inCall() ? endCall() : startCall("inbound"));
    $("outBtn").onclick = () => startCall("outbound");
    $("reportBtn").onclick = downloadReport;
    $("orb").onclick = () => { if (st.phase === "speaking") bargeIn(); else if (!inCall()) startCall("inbound"); };
    $("langSel").onchange = (e) => switchLang(e.target.value);
    $("settingsBtn").onclick = () => $("settings").showModal();
    $("keyInput").oninput = (e) => { Brain.cfg.apiKey = e.target.value.trim(); try { sessionStorage.setItem("kam_key", Brain.cfg.apiKey); } catch (x) {} updateBadge(); };
    $("modelSel").onchange = (e) => { Brain.cfg.model = e.target.value; try { sessionStorage.setItem("kam_model", Brain.cfg.model); } catch (x) {} updateBadge(); };
    $("voiceEn").onchange = (e) => { Mouth.voiceOverride.en = e.target.value; };
    $("voiceHi").onchange = (e) => { Mouth.voiceOverride.hi = e.target.value; };
    $("bargeChk").onchange = (e) => { st.bargeIn = e.target.checked; };
    $("viewSeller").onclick = () => setView("seller");
    $("viewAgent").onclick = () => setView("agent");
    let savedView = "agent";
    try { savedView = localStorage.getItem("kam_view") || "agent"; } catch (x) {}
    setView(savedView);
    $("testVoice").onclick = () => { Mouth.stop(); Mouth.say(st.lang === "hi" ? "नमस्ते राजेश जी, बिक्री ₹1,35,000 रही।" : "Namaste Rajesh ji. Sales were ₹1,35,000, down 32.5%.", st.lang); };
    $("typeForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("typeInput").value.trim(); if (!v) return;
      $("typeInput").value = "";
      if (!inCall()) return banner("Start the call first, then type.", false);
      if (Mouth.speaking) bargeIn();
      handleSellerText(v);
    };
    window.addEventListener("beforeunload", () => { Mouth.stop(); Ears.stop(); });
  }
  init();

  window.KAM_APP = { st, startCall, endCall, downloadReport, setView };   // exposed for tests and for poking around in the console
})();
