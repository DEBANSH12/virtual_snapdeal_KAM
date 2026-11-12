/* ============================================================================
 * brain.js — decides what the KAM says next.
 *
 * Main brain  : Gemini (REST generateContent) with function calling.
 *               Loop: model -> tool calls -> tool results -> model -> ... -> speech.
 * Backup brain: a small scripted flow that uses the SAME tools. It runs only
 *               when no API key/proxy is available, so the voice demo still
 *               works. The UI labels it clearly; it is not AI.
 * ========================================================================== */
(function () {
  const T = window.KAM_TOOLS, P = window.KAM_PROMPT, D = window.KAM_DATA;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");

  const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-flash-latest"];
  const cfg = { apiKey: "", model: MODELS[0], proxy: false, callType: "inbound" };
  const noThinking = new Set();      // models that rejected thinkingConfig
  let activeModel = null;

  const LINES = {
    en: {
      repeat: "Sorry, I didn't catch that. Could you say it again?",
      trouble: "Sorry, I'm having trouble reaching my systems. Could you say that once more?",
      bye: `Thank you, ${D.seller.spokenName}. We will get your sales back on track. Have a good day.`,
      filler: { get_account_overview: "One moment, let me pull up your account.", get_inventory_report: "Let me check your stock.",
        get_cancellation_report: "Let me look at your cancellations.", get_pricing_and_visibility: "Let me check your pricing and traffic.",
        get_sales_bridge: "Let me break that down.", estimate_recovery: "Let me work out a plan for you.", commit_action_plan: "Let me note this plan down.",
        get_product_movement: "Let me see which products move fast and which are stuck.", get_stock_plan: "Let me work out your reorder levels.",
        get_customer_enquiries: "Let me see what customers are asking for.", get_dispatch_report: "Let me check your dispatch times." }
    },
    hi: {
      repeat: "माफ़ कीजिए, मैं ठीक से सुन नहीं पाई। क्या आप दोबारा बोलेंगे?",
      trouble: "माफ़ कीजिए, सिस्टम से जुड़ने में दिक्कत आ रही है। क्या आप एक बार फिर बोलेंगे?",
      bye: `धन्यवाद, राजेश जी। हम मिलकर आपकी बिक्री वापस लाएँगे। आपका दिन शुभ हो।`,
      filler: { get_account_overview: "एक मिनट, मैं आपका अकाउंट खोलती हूँ।", get_inventory_report: "मैं आपका स्टॉक देखती हूँ।",
        get_cancellation_report: "मैं कैंसिलेशन देखती हूँ।", get_pricing_and_visibility: "मैं दाम और ट्रैफ़िक देखती हूँ।",
        get_sales_bridge: "मैं इसका हिसाब देखती हूँ।", estimate_recovery: "मैं आपके लिए प्लान बनाती हूँ।", commit_action_plan: "मैं यह प्लान नोट कर लेती हूँ।",
        get_product_movement: "मैं देखती हूँ कौन सा प्रोडक्ट तेज़ बिकता है और कौन सा रुका हुआ है।", get_stock_plan: "मैं आपके रीऑर्डर लेवल निकालती हूँ।",
        get_customer_enquiries: "मैं देखती हूँ ग्राहक क्या माँग रहे हैं।", get_dispatch_report: "मैं डिस्पैच का समय देखती हूँ।" }
    }
  };
  const L = (lang) => LINES[lang === "hi" ? "hi" : "en"];

  // ------------------------------- Gemini ---------------------------------------
  function buildBody(history, lang, withThinking) {
    const generationConfig = { temperature: 0.6, maxOutputTokens: 2048 };
    if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: "low" }; // keep latency low for voice
    return {
      systemInstruction: { parts: [{ text: P.buildSystemPrompt(lang, cfg.callType) }] },
      contents: history,
      tools: [{ functionDeclarations: P.TOOL_DECLARATIONS }],
      generationConfig
    };
  }

  async function post(model, body, outerSignal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (outerSignal) { if (outerSignal.aborted) ctrl.abort(); else outerSignal.addEventListener("abort", onAbort); }
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      if (cfg.proxy) {
        return await fetch("api/gemini", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, body }), signal: ctrl.signal });
      }
      return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
        body: JSON.stringify(body), signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
    }
  }

  // One model request, with retries and automatic fallback to the next model.
  async function generate(history, lang, signal) {
    const chain = [cfg.model, ...MODELS.filter((m) => m !== cfg.model)];
    let lastErr = new Error("No model answered.");
    for (const model of chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) throw abortError();
        let res;
        try { res = await post(model, buildBody(history, lang, !noThinking.has(model)), signal); }
        catch (e) {
          if (signal && signal.aborted) throw abortError();
          lastErr = new Error(e.name === "AbortError" ? `${model} timed out.` : "Network error: " + e.message);
          await sleep(400); continue;
        }
        if (res.ok) {
          const json = await res.json();
          if (model !== activeModel) { activeModel = model; if (Brain.onStatus) Brain.onStatus(model); }
          return json;
        }
        let detail = ""; try { detail = (await res.text()).slice(0, 400); } catch (e) {}
        const msg = (detail.match(/"message":\s*"([^"]+)"/) || [])[1] || detail;
        if (/API key/i.test(detail) || res.status === 401 || res.status === 403) {
          const err = new Error("Gemini rejected the API key: " + msg); err.fatal = true; throw err;
        }
        lastErr = new Error(`${model}: ${res.status} ${msg}`);
        if (res.status === 400 && !noThinking.has(model)) { noThinking.add(model); attempt--; continue; } // retry once without thinkingConfig
        if (res.status === 429 || res.status >= 500) { await sleep(700); continue; }                      // busy: retry, then next model
        break;                                                                                             // 404 etc: next model
      }
    }
    throw lastErr;
  }
  function abortError() { const e = new Error("aborted"); e.name = "AbortError"; return e; }

  // One seller turn: keep calling the model until it answers in words.
  async function geminiTurn({ history, getLang, signal, onSpeech, onTool }) {
    let spoke = false, emptyRetries = 0;
    for (let step = 0; step < 7; step++) {
      const json = await generate(history, getLang(), signal);
      if (signal && signal.aborted) throw abortError();
      const cand = json.candidates && json.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      const calls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();

      if (!calls.length) {
        if (!text) { if (emptyRetries++ < 1) continue; return { text: L(getLang()).repeat }; }
        history.push({ role: "model", parts });
        return { text };
      }

      // The model asked for tools. Keep its parts untouched (they carry thought signatures).
      history.push({ role: "model", parts });
      if (text) { onSpeech(text); spoke = true; }
      else if (!spoke) {
        const f = calls.map((c) => L(getLang()).filler[c.functionCall.name]).find(Boolean);
        if (f) { onSpeech(f); spoke = true; }       // fills the silence while tools run
      }
      let endCall = false;
      const responses = calls.map((p) => {
        const { name, args, id } = p.functionCall;
        const result = T.run(name, args);
        onTool(name, args || {}, result);
        if (name === "end_call") endCall = true;
        const fr = { name, response: result }; if (id) fr.id = id;
        return { functionResponse: fr };
      });
      history.push({ role: "user", parts: responses });
      if (endCall) return { text: spoke ? "" : L(getLang()).bye, endCall: true };
    }
    return { text: L(getLang()).repeat };
  }

  // --------------------------- Scripted backup brain ----------------------------
  const script = { stage: 0, lastSay: null };
  function scriptedTurn({ userText, getLang, onTool }) {
    const run = (name, args) => { const r = T.run(name, args); onTool(name, args || {}, r); return r; };
    const ji = D.seller.spokenName;
    const dayName = (n, lang) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString(lang === "hi" ? "hi-IN" : "en-IN", { weekday: "long" }); };
    const txt = userText.toLowerCase();

    if (/\bhindi\b|हिंदी|हिन्दी/.test(txt) && getLang() !== "hi") { run("set_language", { language: "hi" }); return { text: "ज़रूर, हम हिंदी में बात करते हैं। " + (script.lastSay ? script.lastSay("hi") : "") }; }
    if (/\benglish\b|अंग्रेज़ी|इंग्लिश/.test(txt) && getLang() !== "en") { run("set_language", { language: "en" }); return { text: "Sure, let us continue in English. " + (script.lastSay ? script.lastSay("en") : "") }; }
    if (/\b(repeat|again|pardon)\b|दोबारा|फिर से/.test(txt) && script.lastSay) return { text: script.lastSay(getLang()) };

    const stages = [
      () => {
        const o = run("get_account_overview"), i = run("get_inventory_report", { top_n: 3 });
        const [a, b] = i.top_products_by_lost_sales;
        return (lang) => lang === "hi"
          ? `${ji}, आपका अकाउंट मेरे सामने खुला है। इस महीने बिक्री ${o.change.sales_drop_pct}% कम हुई है, ${inr(o.last_month.sales_rupees)} से ${inr(o.this_month.sales_rupees)} पर आ गई है। दाम वही है, यानी ऑर्डर कम आए हैं। सबसे बड़ी बात यह है कि ${i.out_of_stock_now} प्रोडक्ट स्टॉक में नहीं हैं, पिछले महीने सिर्फ़ ${i.out_of_stock_last_month} थे। इन प्रोडक्ट का स्टॉक क्यों खत्म हुआ?`
          : `I have your account open, ${ji}. Sales are down ${o.change.sales_drop_pct}% this month, from ${inr(o.last_month.sales_rupees)} to ${inr(o.this_month.sales_rupees)}. Your price has not changed, so this is about fewer orders. The big change is ${i.out_of_stock_now} products out of stock, up from ${i.out_of_stock_last_month}, including your ${a.name} and ${b.name}. What happened with the stock on these?`;
      },
      () => {
        run("log_seller_input", { topic: "inventory", note: userText });
        const i = run("get_inventory_report", { top_n: 3 }), c = run("get_cancellation_report");
        return (lang) => lang === "hi"
          ? `समझ गई, धन्यवाद। डेटा भी यही कहता है: स्टॉक खत्म होने से इस महीने करीब ${inr(i.est_sales_lost_to_stockouts_rupees)} की बिक्री गई। कैंसिलेशन भी ${c.cancellation_rate_last_month_pct}% से ${c.cancellation_rate_this_month_pct}% हो गया है, और ${c.orders_cancelled_this_month} में से ${c.reasons_this_month[0].orders} ऑर्डर इसलिए कैंसिल हुए क्योंकि प्रोडक्ट स्टॉक में था ही नहीं। आप सेलर पैनल पर स्टॉक कैसे अपडेट करते हैं, हाथ से या अपने आप?`
          : `Understood, thank you. That fits the data: stockouts cost you about ${inr(i.est_sales_lost_to_stockouts_rupees)} this month, which is most of the drop. Cancellations also went from ${c.cancellation_rate_last_month_pct}% to ${c.cancellation_rate_this_month_pct}%, and ${c.reasons_this_month[0].orders} of the ${c.orders_cancelled_this_month} cancelled orders were for products that were not actually in stock. How do you update stock on your seller panel, by hand or automatically?`;
      },
      () => {
        run("log_seller_input", { topic: "cancellations", note: userText });
        const v = run("get_pricing_and_visibility");
        return (lang) => lang === "hi"
          ? `ठीक है। मैंने दाम और ट्रैफ़िक भी देखा। आपका औसत दाम ${inr(v.avg_selling_price_this_month)} ही है और स्टोर पर आने वाले ग्राहक लगभग उतने ही हैं, यानी ग्राहक आ रहे हैं पर प्रोडक्ट स्टॉक में नहीं मिल रहा। अभी दाम घटाने या विज्ञापन पर खर्च करने की ज़रूरत नहीं है। क्या इस महीने आपने कोई दाम बदला या कोई प्रमोशन बंद किया?`
          : `Got it. I also checked pricing and traffic. Your average price is unchanged at ${inr(v.avg_selling_price_this_month)} and store visits are almost the same, so customers are still coming but finding products sold out. I would not cut prices or spend on ads right now. Did you change any prices or stop any promotion this month?`;
      },
      () => {
        run("log_seller_input", { topic: "pricing", note: userText });
        const mv = run("get_product_movement"), sp = run("get_stock_plan", {}), en = run("get_customer_enquiries");
        const r = run("estimate_recovery", { restock_top_n: 3 });
        const first = en.most_requested_sold_out_products[0];
        const out = sp.fast_movers.filter((f) => f.status === "out of stock").slice(0, 3);
        run("commit_action_plan", { actions: [
          { title: "Restock fast movers: " + out.map((f) => `${f.name} (${f.order_now_units} units)`).join(", "), owner: "Seller", due: dayName(2, "en"), expected_impact: `About ${inr(r.monthly_sales_recovered_by_restocking_rupees)} a month; ${en.customers_waiting_for_restock_total} customers are waiting` },
          { title: `Reorder ${sp.about_to_run_out.join(" and ")} now, and use min/max levels for all fast movers`, owner: "Seller", due: "This week", expected_impact: "Stops the next stockout; reorder at min, order up to max" },
          { title: "Mark sold-out products out of stock the same day", owner: "Seller", due: "From today", expected_impact: `Cancellations back towards 8%, about ${inr(r.monthly_sales_recovered_by_cancellations_back_to_8pct_rupees)} a month` },
          { title: "Sell oldest stock first (FIFO) and clear slow stock with a small offer", owner: "Seller", due: "Within 2 weeks", expected_impact: `Frees part of ${inr(mv.money_locked_in_slow_stock_rupees)} locked in ${mv.slow_movers_with_excess_stock.length} slow products` }
        ] });
        return (lang) => lang === "hi"
          ? `धन्यवाद। मैंने थोड़ा और गहराई से देखा। आपके ${mv.fast_movers} सबसे तेज़ बिकने वाले प्रोडक्ट में से ${mv.fast_movers_out_of_stock_count} स्टॉक में नहीं हैं, और ${en.customers_waiting_for_restock_total} ग्राहक उनके लौटने का इंतज़ार कर रहे हैं। दूसरी तरफ़ करीब ${inr(mv.money_locked_in_slow_stock_rupees)} का माल धीमे बिकने वाले प्रोडक्ट में फँसा है। तो पहला काम, तेज़ बिकने वाले तीन प्रोडक्ट वापस लाइए; इससे महीने में करीब ${inr(r.monthly_sales_recovered_by_restocking_rupees)} लौटेंगे। दूसरा, हर तेज़ प्रोडक्ट के लिए कम से कम और ज़्यादा से ज़्यादा स्टॉक तय कीजिए, ताकि खत्म होने से पहले ऑर्डर हो जाए। बाकी बातें मैं व्हाट्सऐप पर भेज रही हूँ। क्या आप ${dayName(2, "hi")} तक स्टॉक का ऑर्डर दे सकते हैं?`
          : `Thanks. I looked one level deeper. ${mv.fast_movers_out_of_stock_count} of your ${mv.fast_movers} fastest-selling products are sold out, and ${en.customers_waiting_for_restock_total} customers are waiting for them, starting with the ${first.name}. Meanwhile about ${inr(mv.money_locked_in_slow_stock_rupees)} is sitting in slow products. So first, restock your top three fast movers; that brings back about ${inr(r.monthly_sales_recovered_by_restocking_rupees)} a month. Second, set a minimum and maximum stock level for each fast mover, so you reorder before it runs out. The rest is in the WhatsApp summary. Can you place the restock order by ${dayName(2, "en")}?`;
      },
      () => {
        run("log_seller_input", { topic: "commitment", note: userText });
        const r = run("estimate_recovery", { restock_top_n: 3 });
        const f = run("schedule_followup", { days_from_now: 3, agenda: "Check restock status and cancellation rate" });
        run("send_summary", { message: `Namaste ${ji}. Summary of our call: sales fell mainly because best sellers went out of stock, which also pushed up cancellations. Plan: 1) Restock ${r.restock_products.join(", ")}. 2) Reorder at the minimum level, order up to the maximum. 3) Mark sold-out products out of stock the same day. 4) Sell oldest stock first and clear slow stock. Expected recovery: about ${inr(r.total_monthly_recovery_rupees)} a month. I will call you on ${f.date}. - Priya, Virtual KAM` });
        return (lang) => lang === "hi"
          ? `बहुत बढ़िया। संक्षेप में: असली वजह आपके सबसे ज़्यादा बिकने वाले प्रोडक्ट का स्टॉक खत्म होना है, और उसी से कैंसिलेशन भी बढ़ा। आप तीन प्रोडक्ट का स्टॉक वापस लाएँगे और स्टॉक रोज़ अपडेट रखेंगे, इससे महीने में करीब ${inr(r.total_monthly_recovery_rupees)} की बिक्री लौट सकती है। मैंने यह सब व्हाट्सऐप पर भेज दिया है और ${dayName(3, "hi")} को मैं आपको दोबारा कॉल करूँगी। क्या मैं और कोई मदद कर सकती हूँ?`
          : `Perfect. To summarise: the main issue is stockouts on your best sellers, which also pushed up cancellations. You will restock the top three and keep stock counts updated, which should recover about ${inr(r.total_monthly_recovery_rupees)} a month. I have sent this on WhatsApp, and I will call you on ${f.date} to check the restock. Is there anything else I can help with?`;
      }
    ];

    if (script.stage >= stages.length) { run("end_call"); return { text: L(getLang()).bye, endCall: true }; }
    script.lastSay = stages[script.stage++]();
    return { text: script.lastSay(getLang()) };
  }

  // ------------------------------- Public API -----------------------------------
  const Brain = {
    MODELS, cfg, onStatus: null,
    mode() { return cfg.apiKey || cfg.proxy ? "gemini" : "scripted"; },
    lines: L,
    reset() { script.stage = 0; script.lastSay = null; activeModel = null; },
    async turn(opts) {
      if (this.mode() === "gemini") return geminiTurn(opts);
      await sleep(350);                                   // small pause so it does not feel abrupt
      if (opts.signal && opts.signal.aborted) throw abortError();
      const out = scriptedTurn(opts);
      if (opts.getLang() === "hi" && out.text) out.text = out.text.split(D.seller.spokenName).join("राजेश जी");
      return out;
    },
    // Ask the hosting page if a server-side proxy with a key is available (see api/gemini.js).
    async detectProxy() {
      if (!/^https?:/.test(location.protocol)) return false;
      try {
        const r = await fetch("api/gemini", { method: "GET" });
        const j = r.ok ? await r.json() : null;
        cfg.proxy = !!(j && j.ok === true);
      } catch (e) { cfg.proxy = false; }
      return cfg.proxy;
    }
  };
  window.KAM_BRAIN = Brain;
})();
