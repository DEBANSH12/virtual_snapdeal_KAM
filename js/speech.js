/* ============================================================================
 * speech.js — the voice layer. Browser Web Speech API for both directions:
 *   ears  = SpeechRecognition (speech-to-text, streaming interim results)
 *   mouth = speechSynthesis   (text-to-speech, sentence by sentence)
 * Also: number-to-words so "₹1,35,000" is spoken as
 * "one lakh thirty-five thousand rupees".
 * ========================================================================== */
(function () {
  // ---------- Numbers to spoken words (Indian system) -------------------------
  const ONES = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const TENS = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""); }
  function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    return (h ? ONES[h] + " hundred" + (r ? " " : "") : "") + (r || !h ? below100(r) : "");
  }
  function intToWords(n) {
    n = Math.floor(Math.abs(n));
    if (n === 0) return "zero";
    const parts = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(intToWords(crore) + " crore");
    if (lakh) parts.push(below100(lakh) + " lakh");
    if (thousand) parts.push(below100(thousand) + " thousand");
    if (n) parts.push(below1000(n));
    return parts.join(" ");
  }
  function numberToWords(str) {
    const clean = String(str).replace(/,/g, "");
    const [i, d] = clean.split(".");
    let out = intToWords(parseInt(i, 10) || 0);
    if (d && /[1-9]/.test(d)) out += " point " + d.replace(/0+$/, "").split("").map((c) => ONES[+c]).join(" ");
    return out;
  }

  // Turn display text into text that a TTS voice reads well.
  function toSpeech(text, lang) {
    let s = String(text).replace(/[*_#`~|]/g, "").replace(/\s+/g, " ").trim();
    if (lang === "hi") {
      // The Hindi voice reads digits in Hindi; it only needs symbols replaced and commas removed.
      s = s.replace(/(?:₹|Rs\.?)\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)/gi, (_, n) => n.replace(/,/g, "") + " रुपये");
      s = s.replace(/(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?%/g, (_, n) => n.replace(/,/g, "") + " प्रतिशत");
      s = s.replace(/(\d),(?=\d)/g, "$1");
      return s;
    }
    s = s.replace(/(?:₹|Rs\.?)\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)(\s?(lakhs?|crores?|thousand))?/gi,
      (_, n, _u, unit) => numberToWords(n) + (unit ? " " + unit.replace(/s$/i, "") : "") + " rupees");
    s = s.replace(/(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?%/g, (_, n) => numberToWords(n) + " percent");
    s = s.replace(/\b\d{1,3}(?:,\d{2,3})+\b|\b\d{4,}\b/g, (n) => numberToWords(n)); // big bare numbers
    s = s.replace(/(\d)x\b/g, "$1 times");
    return s;
  }

  function splitSentences(text) {
    // Break after . ! ? or the Hindi danda, but only when a space follows (so 32.5 stays whole).
    return String(text).split(/(?<=[.!?।])\s+/).map((x) => x.trim()).filter(Boolean);
  }

  // ---------- Mouth: text-to-speech with a sentence queue ---------------------
  const synth = window.speechSynthesis;
  const Mouth = {
    queue: [], speaking: false, voiceOverride: {}, onStart: null, onDrained: null, _wd: null, _gen: 0, _cancelAt: 0, _starting: false,

    voices(lang) {
      const all = synth ? synth.getVoices() : [];
      const want = lang === "hi" ? "hi" : "en";
      return all.filter((v) => v.lang.toLowerCase().startsWith(want));
    },
    pickVoice(lang) {
      const list = this.voices(lang);
      const chosen = this.voiceOverride[lang] && list.find((v) => v.name === this.voiceOverride[lang]);
      if (chosen) return chosen;
      const score = (v) => {
        const n = v.name.toLowerCase(), l = v.lang.toLowerCase().replace("_", "-");
        let s = 0;
        if (l === (lang === "hi" ? "hi-in" : "en-in")) s += 10;
        if (/natural|neural|online/.test(n)) s += 6;         // Edge's neural voices sound best
        if (/google/.test(n)) s += 3;
        if (/neerja|swara|heera|kalpana|aditi|raveena|female|veena|lekha/.test(n)) s += 2; // Priya is female
        if (lang !== "hi" && l === "en-gb") s += 1;
        return s;
      };
      return list.slice().sort((a, b) => score(b) - score(a))[0] || null;
    },

    say(text, lang) {
      if (!synth) return;
      const spoken = toSpeech(text, lang);
      splitSentences(spoken).forEach((s) => this.queue.push({ text: s, lang }));
      if (!this.speaking && !this._starting) { this._starting = true; this._next(); }
    },
    _next() {
      clearTimeout(this._wd);
      // Chrome can swallow an utterance spoken right after cancel(); wait a moment.
      const wait = 140 - (Date.now() - this._cancelAt);
      if (wait > 0 && this.queue.length) { this._wd = setTimeout(() => this._next(), wait); return; }
      this._starting = false;
      const item = this.queue.shift();
      if (!item) {
        const was = this.speaking; this.speaking = false;
        if (was && this.onDrained) this.onDrained();
        return;
      }
      const gen = this._gen;
      const u = new SpeechSynthesisUtterance(item.text);
      const v = this.pickVoice(item.lang);
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = item.lang === "hi" ? "hi-IN" : "en-IN"; }
      u.rate = 1.03; u.pitch = 1.0;
      const done = () => { if (gen !== this._gen || u._done) return; u._done = true; this._next(); };
      u.onend = done; u.onerror = done;
      if (!this.speaking) { this.speaking = true; if (this.onStart) this.onStart(); }
      synth.speak(u);
      // Chrome sometimes never fires onend. This watchdog keeps the call moving.
      this._wd = setTimeout(done, 4000 + item.text.length * 110);
    },
    stop() {                       // used for barge-in and hang-up
      this._gen++; this.queue = []; clearTimeout(this._wd);
      this.speaking = false; this._starting = false; this._cancelAt = Date.now();
      if (synth) synth.cancel();
    }
  };
  if (synth) synth.onvoiceschanged = () => { if (Mouth.onVoices) Mouth.onVoices(); };

  // ---------- Ears: speech-to-text, kept running for the whole call -----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Ears = {
    supported: !!SR, rec: null, wanted: false, lang: "en",
    finalBuf: "", interim: "", ignored: new Set(), seen: new Set(), _timer: null,
    onInterim: null,   // (text) live caption while the seller is speaking
    onUtterance: null, // (text) a finished seller turn
    onError: null,     // (code)
    PAUSE_MS: 950,     // silence that ends the seller's turn

    start(lang) {
      if (!SR) return;
      this.lang = lang || this.lang; this.wanted = true;
      if (this.rec) { try { this.rec.abort(); } catch (e) {} }
      const rec = new SR();
      rec.lang = this.lang === "hi" ? "hi-IN" : "en-IN";
      rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.onstart = () => { this.ignored.clear(); this.seen.clear(); };
      rec.onresult = (e) => this._onResult(e);
      rec.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return; // normal, onend restarts
        if (this.onError) this.onError(e.error);
        if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") this.wanted = false;
      };
      rec.onend = () => {            // Chrome stops after a silence. Restart while the call is live.
        if (this.rec !== rec) return;
        if (this.wanted) setTimeout(() => { if (this.wanted && this.rec === rec) { try { rec.start(); } catch (e) {} } }, 150);
      };
      this.rec = rec; this.finalBuf = ""; this.interim = "";
      try { rec.start(); } catch (e) {}
    },
    stop() {
      this.wanted = false; clearTimeout(this._timer);
      if (this.rec) { try { this.rec.abort(); } catch (e) {} }
      this.rec = null; this.finalBuf = ""; this.interim = "";
    },
    _onResult(e) {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (this.ignored.has(i)) continue;
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { this.finalBuf += " " + t; this.ignored.add(i); }
        else { interim += t; this.seen.add(i); }
      }
      this.interim = interim;
      const live = (this.finalBuf + " " + interim).trim();
      if (live && this.onInterim) this.onInterim(live);
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), this.PAUSE_MS);
    },
    _flush() {
      const text = (this.finalBuf + " " + this.interim).replace(/\s+/g, " ").trim();
      if (this.interim) this.seen.forEach((i) => this.ignored.add(i)); // avoid a late duplicate final
      this.finalBuf = ""; this.interim = "";
      if (text && this.onUtterance) this.onUtterance(text);
    }
  };

  window.KAM_SPEECH = { Mouth, Ears, toSpeech, numberToWords, splitSentences };
})();
