/*
 * billi-voice.js — drop-in voice-to-voice for the Billi PWA
 * ---------------------------------------------------------
 * Wraps voice I/O around your EXISTING chat pipeline. It does not replace it.
 *   voice-in (STT)  ->  your /api/billi/chat (or your sendMessage hook)  ->  voice-out (TTS)
 *
 * Engines, chosen automatically per device:
 *   STT: Web Speech API (Android/desktop Chrome) | MediaRecorder -> /api/voice/stt (iOS/Safari fallback)
 *   TTS: server "Billi voice" /api/voice/tts (recommended) | browser speechSynthesis (free fallback)
 *
 * Audio plays through whatever output is selected on the phone — i.e. your Bluetooth speaker.
 * No wake word in-browser: this is tap-to-talk. ("Hey Billi" needs the dedicated device/native app.)
 *
 * Configure via window.BILLI_VOICE_CONFIG (see billi-voice.integration.html), then this self-inits.
 */
(function () {
  "use strict";

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const DEFAULTS = {
    chatEndpoint: "/api/billi/chat",
    sttEndpoint: "/api/voice/stt",
    ttsEndpoint: "/api/voice/tts",
    persona: "auto",
    voice: "auto",          // 'auto' | 'browser' | 'billi'(server)
    lang: "en-ZA",
    languages: [{ code: "en-ZA", label: "EN" }, { code: "af-ZA", label: "AF" }, { code: "zu-ZA", label: "ZU" }],
    buttonId: null,         // bind to an existing element id; otherwise a floating button is injected
    sendMessage: null,      // async (text) => replyString   <-- recommended: reuse your chat pipeline
    getSessionId: null,     // () => sessionId  (used only when sendMessage is not provided)
    maxRecordMs: 15000,

    // always-on conversation mode (hands-free back-and-forth)
    conversation: false,          // true = a tap starts a session; false = tap is one turn (long-press starts a session)
    conversationRestartMs: 400,   // pause after Billi speaks before re-opening the mic
    conversationMaxSilence: 2,    // consecutive silent turns before the session auto-ends

    // ---- voice design ----
    profile: "warm",              // "warm" (Billi) | "machine" (Superintelligence). Switchable in the picker.
    profiles: {
      warm:    { rate: 0.95, pitch: 1.08 },   // warm, soothing
      machine: { rate: 0.82, pitch: 0.72 }    // lower, slower, flatter — cold "Ultron" feel
    },
    rate: null, pitch: null,      // optional hard overrides; leave null to use the active profile
    // default voice, tried in order (name/lang fragments). Warm US female first.
    voicePreference: ["samantha", "google us english", "microsoft aria", "microsoft jenny online",
                      "ava", "allison", "english (united states)", "en-us", "en-gb"],
    showVoicePicker: true,        // ⚙ menu by the mic so users can choose + remember a voice
    // ---- long replies ----
    summarize: true,              // speak a short summary of long replies, then offer to read the rest
    summarizeEndpoint: null,      // set to "/api/voice/summarize" for a true AI summary; else first-sentences fallback
    longReplyChars: 320,          // a reply longer than this (or >longReplySentences) is summarised
    longReplySentences: 3,
    // ---- local commands (free — never sent to the model) ----
    commands: true,               // recognise "stop" / "save" locally instead of sending to chat
    onSave: null                  // async (format) => void   — called for "save", format is 'pdf' | 'word'
  };

  const BilliVoice = {
    cfg: null, state: "idle", lang: null, _rec: null, _mr: null, _chunks: [], _audio: null, _btn: null, _langBtn: null,
    _convo: false, _silence: 0, _gotResult: false,
    _awaitContinue: false, _pendingFull: null, _voice: null, _picker: null, _awaitSaveFormat: false,

    init(userCfg) {
      this.cfg = Object.assign({}, DEFAULTS, userCfg || {});
      this.lang = this.cfg.lang;
      try { const sp = localStorage.getItem("billi_voice_profile"); if (sp && this.cfg.profiles[sp]) this.cfg.profile = sp; } catch (e) {}
      if (window.speechSynthesis) { try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => { this._voice = null; }; } catch (e) {} }
      this._mountUI();
      this._emit("ready", { stt: this._sttEngine(), tts: this._ttsEngine() });
      return this;
    },

    // ---- engine selection ----------------------------------------------------
    _sttEngine() {
      // Web Speech recognition is unreliable on iOS/Safari -> use server STT there if available.
      if (SR && !isIOS) return "webspeech";
      if (this.cfg.sttEndpoint) return "server";
      return SR ? "webspeech" : "none";
    },
    _ttsEngine() {
      if (this.cfg.voice === "browser") return "browser";
      if (this.cfg.voice === "billi") return this.cfg.ttsEndpoint ? "server" : "browser";
      // auto: prefer the branded server voice when configured, else browser
      return this.cfg.ttsEndpoint ? "server" : (window.speechSynthesis ? "browser" : "none");
    },

    // ---- public control ------------------------------------------------------
    toggle() {
      if (this._convo) return this.stopConversation();           // a tap during a session ends it
      if (this.state === "listening") return this._stopListening();
      if (this.state === "speaking") { this._stopSpeaking(); return this._startListening(); } // barge-in
      if (this.state === "thinking") return; // ignore while waiting on Billi
      if (this.cfg.conversation) return this.startConversation();
      return this._startListening();                             // single turn
    },

    // ---- always-on conversation mode ----------------------------------------
    startConversation() {
      this._convo = true; this._silence = 0;
      if (this._btn) this._btn.setAttribute("data-convo", "on");
      this._emit("conversation", { active: true });
      this._startListening();
    },
    stopConversation() {
      this._convo = false;
      if (this._btn) this._btn.removeAttribute("data-convo");
      this._emit("conversation", { active: false });
      this._stopListening(); this._stopSpeaking(); this._setState("idle");
    },
    _endTurn() {            // Billi finished speaking (or had nothing to say)
      if (this._awaitContinue || this._awaitSaveFormat) { setTimeout(() => { if (this._awaitContinue || this._awaitSaveFormat) this._startListening(); }, this.cfg.conversationRestartMs); return; }
      if (this._convo) setTimeout(() => { if (this._convo) this._startListening(); }, this.cfg.conversationRestartMs);
      else this._setState("idle");
    },
    _noInput() {           // listening ended with no speech captured
      if (this._awaitContinue || this._awaitSaveFormat) { this._awaitContinue = false; this._awaitSaveFormat = false; this._pendingFull = null; return this._convo ? this._endTurn() : this._setState("idle"); }
      if (!this._convo) return this._setState("idle");
      if (++this._silence >= this.cfg.conversationMaxSilence) return this.stopConversation();
      this._endTurn();     // re-open the mic for another try
    },

    // ---- STT -----------------------------------------------------------------
    async _startListening() {
      this._setState("listening");
      try {
        if (this._sttEngine() === "webspeech") return this._listenWebSpeech();
        if (this._sttEngine() === "server") return this._listenRecord();
        throw new Error("No speech-to-text engine available on this device.");
      } catch (e) { this._fail(e); }
    },

    _listenWebSpeech() {
      const rec = new SR();
      this._rec = rec; this._gotResult = false;
      rec.lang = this.lang; rec.interimResults = false; rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        this._gotResult = true; this._silence = 0;
        const text = e.results[0][0].transcript.trim();
        this._emit("transcript", { text });
        this._handle(text);
      };
      rec.onerror = (e) => { if (e.error === "no-speech" || e.error === "aborted") return; this._fail(new Error("STT: " + e.error)); };
      rec.onend = () => { this._rec = null; if (!this._gotResult && this.state === "listening") this._noInput(); };
      rec.start();
    },

    async _listenRecord() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      this._mr = mr; this._chunks = [];
      mr.ondataavailable = (ev) => ev.data.size && this._chunks.push(ev.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        this._setState("thinking");
        try {
          const blob = new Blob(this._chunks, { type: mime || "audio/webm" });
          const fd = new FormData();
          fd.append("audio", blob, "speech.webm");
          fd.append("lang", this.lang);
          const r = await fetch(this.cfg.sttEndpoint, { method: "POST", body: fd, credentials: "same-origin" });
          if (!r.ok) throw new Error("STT server " + r.status);
          const { text } = await r.json();
          this._emit("transcript", { text });
          if (text) { this._silence = 0; this._handle(text); } else this._noInput();
        } catch (e) { this._fail(e); }
      };
      mr.start();
      this._recTimer = setTimeout(() => this._stopListening(), this.cfg.maxRecordMs);
    },

    _stopListening() {
      clearTimeout(this._recTimer);
      if (this._rec) { try { this._rec.stop(); } catch (e) {} this._rec = null; }
      if (this._mr && this._mr.state !== "inactive") { try { this._mr.stop(); } catch (e) {} }
    },

    // ---- chat ----------------------------------------------------------------
    async _handle(text) {
      const t = (text || "").trim();

      // 0) answering "PDF or Word?" after a save command
      if (this._awaitSaveFormat) {
        this._awaitSaveFormat = false;
        if (this._isCancel(t)) return this._speak("Okay, cancelled.");
        const fmt = /\b(word|doc|docx|microsoft)\b/i.test(t) ? "word" : (/\b(pdf)\b/i.test(t) ? "pdf" : null);
        if (!fmt) { this._awaitSaveFormat = true; return this._speak("PDF or Word?"); }   // re-ask once
        return this._doSave(fmt);
      }

      // 1) "continue" after a summarised long reply
      if (this._awaitContinue) {
        this._awaitContinue = false;
        if (/\b(continue|carry on|go on|yes|yeah|ya|read|rest|more|full|please)\b/i.test(t)) {
          const full = this._pendingFull; this._pendingFull = null;
          this._emit("transcript", { text: t });
          return this._speak(this._clean(full));   // read the whole thing
        }
        this._pendingFull = null;   // not "continue" — fall through and treat as a new question
      }

      // 2) local commands — handled here, NEVER sent to the model (no message consumed)
      if (this.cfg.commands) {
        if (this._isStop(t)) {
          this._stopSpeaking(); this._awaitContinue = false; this._pendingFull = null;
          if (this._convo) this.stopConversation(); else this._setState("idle");
          return;
        }
        if (this._isCancel(t)) { this._awaitContinue = false; this._pendingFull = null; return this._convo ? this._endTurn() : this._setState("idle"); }
        if (this._isSave(t)) {
          if (typeof this.cfg.onSave === "function") { this._awaitSaveFormat = true; return this._speak("Sure. PDF or Word?"); }
          return this._speak("Saving isn't set up here yet.");
        }
      }

      this._setState("thinking");
      try {
        let reply;
        if (typeof this.cfg.sendMessage === "function") {
          // Recommended: reuse your existing pipeline (it renders the bubbles + does persona routing)
          reply = await this.cfg.sendMessage(text);
        } else {
          const body = {
            session_id: this.cfg.getSessionId ? this.cfg.getSessionId() : undefined,
            persona: this.cfg.persona, message: text, client: "voice"
          };
          const r = await fetch(this.cfg.chatEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), credentials: "same-origin"
          });
          if (!r.ok) throw new Error("chat " + r.status);
          const data = await r.json();
          reply = data.reply || "";
        }
        this._emit("reply", { text: reply });
        // long reply -> speak a short summary, then offer to read the rest
        if (this.cfg.summarize && this._isLong(reply)) {
          const summary = await this._summarize(reply);
          this._pendingFull = reply;
          this._awaitContinue = true;
          await this._speak(summary + ". Want me to read the full answer? Say continue.");
        } else {
          await this._speak(this._clean(reply));
        }
      } catch (e) { this._fail(e); }
    },

    // ---- speech text shaping -------------------------------------------------
    _clean(t) {            // strip markdown so TTS says words, not "asterisk"
      if (!t) return "";
      return String(t)
        .replace(/```[\s\S]*?```/g, ". ")               // code fences
        .replace(/`([^`]+)`/g, "$1")                      // inline code
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")             // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")          // links -> text
        .replace(/^\s{0,3}#{1,6}\s*/gm, "")               // headings
        .replace(/^\s*>\s?/gm, "")                         // blockquotes
        .replace(/^\s*[-*+]\s+/gm, ". ")                  // bullets -> pause
        .replace(/^\s*\d+\.\s+/gm, ". ")                  // numbered list -> pause
        .replace(/\*\*([^*]+)\*\*/g, "$1")                // bold **
        .replace(/__([^_]+)__/g, "$1")                     // bold __
        .replace(/\*([^*]+)\*/g, "$1")                     // italic *
        .replace(/_([^_]+)_/g, "$1")                        // italic _
        .replace(/~~([^~]+)~~/g, "$1")                      // strikethrough
        .replace(/[*_#`~|>]/g, " ")                         // any leftover symbols
        .replace(/\s+([.,!?;:])/g, "$1")                   // tidy spaces before punctuation
        .replace(/\.{2,}/g, ".")                            // collapse ...
        .replace(/\s{2,}/g, " ")                            // collapse spaces
        .trim();
    },
    _isLong(t) {
      const c = this._clean(t);
      const sentences = (c.match(/[.!?]+(\s|$)/g) || []).length;
      return c.length > this.cfg.longReplyChars || sentences > this.cfg.longReplySentences;
    },
    async _summarize(full) {
      if (this.cfg.summarizeEndpoint) {       // true AI summary, if a route is wired
        try {
          const r = await fetch(this.cfg.summarizeEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: full }), credentials: "same-origin"
          });
          if (r.ok) { const d = await r.json(); if (d && d.summary) return this._clean(d.summary); }
        } catch (e) { console.warn("[BilliVoice] summarize endpoint failed, using fallback", e); }
      }
      return this._extract(this._clean(full), 2);   // fallback: first 1-2 sentences
    },
    _extract(text, n) {
      const parts = text.replace(/([.!?])\s+/g, "$1\n").split("\n").filter(Boolean);
      return parts.slice(0, n).join(" ");
    },

    // ---- local command recognition (kept deliberately tight to avoid false hits) ----
    _words(t) { return t.trim().split(/\s+/).filter(Boolean); },
    _isStop(t) {
      const w = this._words(t);
      return w.length <= 4 && /\b(stop|quiet|enough|halt|shush|silence)\b/i.test(t)
        || /^(end|never mind|nevermind|shut up|stop talking|be quiet|that'?s enough)\b/i.test(t.trim());
    },
    _isCancel(t) { const w = this._words(t); return w.length <= 4 && /\b(cancel|never mind|nevermind|forget it|no thanks)\b/i.test(t); },
    _isSave(t) {
      const w = this._words(t);
      if (w.length <= 2 && /^(save|download|export)\b/i.test(t.trim())) return true;   // "save", "download it"
      return /\b(save|download|export)\b/i.test(t) && /\b(this|that|it|chat|conversation|response|answer|reply|everything)\b/i.test(t);
    },
    _doSave(fmt) {
      this._speak(fmt === "word" ? "Saving the conversation as Word. Check your downloads." : "Saving the conversation as a PDF. Check your downloads.");
      try { Promise.resolve(this.cfg.onSave(fmt)); } catch (e) { console.error("[BilliVoice] save failed", e); }
    },

    // ---- TTS -----------------------------------------------------------------
    async _speak(text) {
      if (!text) return this._endTurn();
      this._setState("speaking");
      try {
        if (this._ttsEngine() === "server") return await this._speakServer(text);
        if (this._ttsEngine() === "browser") return this._speakBrowser(text);
        this._endTurn();
      } catch (e) {
        // if the branded voice fails, fall back to the browser voice rather than going silent
        if (window.speechSynthesis) return this._speakBrowser(text);
        this._fail(e);
      }
    },

    async _speakServer(text) {
      const r = await fetch(this.cfg.ttsEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang: this.lang }), credentials: "same-origin"
      });
      if (!r.ok) throw new Error("TTS server " + r.status);
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url); this._audio = a;
      a.onended = () => { URL.revokeObjectURL(url); this._endTurn(); };
      await a.play(); // routes to the connected Bluetooth speaker
    },

    _speakBrowser(text) {
      const u = new SpeechSynthesisUtterance(text);
      const v = this._pickVoice();
      if (v) { u.voice = v; u.lang = v.lang || this.lang; } else { u.lang = this.lang; }
      u.rate = this._effRate(); u.pitch = this._effPitch();
      u.onend = () => this._endTurn();
      u.onerror = () => this._endTurn();
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    },
    _pickVoice() {
      if (this._voice) return this._voice;
      const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
      if (!vs.length) return null;
      try { const saved = localStorage.getItem("billi_voice_name"); if (saved) { const sv = vs.find(x => x.name === saved); if (sv) return (this._voice = sv); } } catch (e) {}
      const has = (x, p) => ((x.name || "") + " " + (x.lang || "")).toLowerCase().indexOf(p) >= 0;
      const prefs = this.cfg.voicePreference || [];
      for (let i = 0; i < prefs.length; i++) { const hit = vs.find(x => has(x, prefs[i].toLowerCase())); if (hit) return (this._voice = hit); }
      const female = vs.filter(x => /female|woman|samantha|libby|sonia|hazel|aria|amy|emma|tessa|karen|moira/i.test(x.name || ""));
      const pool = female.length ? female : vs;
      const langs = ["en-za", "en-gb", "en-au", "en-ie", "en"];
      for (let j = 0; j < langs.length; j++) { const v = pool.find(x => (x.lang || "").toLowerCase().indexOf(langs[j]) === 0); if (v) return (this._voice = v); }
      return (this._voice = pool[0] || vs[0] || null);
    },
    listVoices() {   // call BilliVoice.listVoices() in the console to see what your device offers
      const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
      try { console.table(vs.map(v => ({ name: v.name, lang: v.lang, default: v.default }))); } catch (e) { console.log(vs); }
      return vs;
    },

    _stopSpeaking() {
      if (this._audio) { try { this._audio.pause(); } catch (e) {} this._audio = null; }
      if (window.speechSynthesis) speechSynthesis.cancel();
    },

    // ---- UI ------------------------------------------------------------------
    _mountUI() {
      let btn = this.cfg.buttonId && document.getElementById(this.cfg.buttonId);
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "billi-mic";
        btn.className = "billi-mic";
        document.body.appendChild(btn);
        this._injectStyles();
        // language chip
        if (this.cfg.languages.length > 1) {
          const lb = document.createElement("button");
          lb.className = "billi-lang"; lb.textContent = this._labelFor(this.lang);
          lb.onclick = () => this._cycleLang(lb);
          document.body.appendChild(lb); this._langBtn = lb;
        }
        // voice picker (gear)
        if (this.cfg.showVoicePicker && window.speechSynthesis) {
          const gb = document.createElement("button");
          gb.className = "billi-voice-btn"; gb.setAttribute("aria-label", "Choose Billi's voice");
          gb.innerHTML = GEAR_SVG; gb.onclick = () => this._togglePicker();
          document.body.appendChild(gb);
        }
      }
      btn.setAttribute("aria-label", "Talk to Billi");
      btn.innerHTML = MIC_SVG;
      let held = false, ht = null;
      const down = () => { held = false; ht = setTimeout(() => { held = true; if (!this._convo) this.startConversation(); }, 600); };
      const up = () => clearTimeout(ht);
      btn.addEventListener("pointerdown", down);
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointerleave", up);
      btn.addEventListener("click", () => { if (held) { held = false; return; } this.toggle(); });
      this._btn = btn;
      this._setState("idle");
    },

    _labelFor(code) { const l = this.cfg.languages.find(x => x.code === code); return l ? l.label : code; },
    _cycleLang(el) {
      const i = this.cfg.languages.findIndex(x => x.code === this.lang);
      this.lang = this.cfg.languages[(i + 1) % this.cfg.languages.length].code;
      el.textContent = this._labelFor(this.lang);
      this._emit("lang", { lang: this.lang });
    },

    // ---- voice selection + character profiles ----
    setVoice(name) {
      const v = ((window.speechSynthesis && speechSynthesis.getVoices()) || []).find(x => x.name === name);
      if (v) { this._voice = v; try { localStorage.setItem("billi_voice_name", name); } catch (e) {} this._emit("voice", { name }); }
      return v;
    },
    setProfile(name) {
      if (!this.cfg.profiles[name]) return;
      this.cfg.profile = name;
      try { localStorage.setItem("billi_voice_profile", name); } catch (e) {}
      this._emit("profile", { profile: name });
    },
    _effRate() { return this.cfg.rate != null ? this.cfg.rate : (this.cfg.profiles[this.cfg.profile] || this.cfg.profiles.warm).rate; },
    _effPitch() { return this.cfg.pitch != null ? this.cfg.pitch : (this.cfg.profiles[this.cfg.profile] || this.cfg.profiles.warm).pitch; },
    _sample() {
      const txt = this.cfg.profile === "machine" ? "Superintelligence online." : "Hi, I'm Billi. How can I help?";
      try { speechSynthesis.cancel(); } catch (e) {}
      const u = new SpeechSynthesisUtterance(txt);
      const v = this._pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = this._effRate(); u.pitch = this._effPitch();
      speechSynthesis.speak(u);
    },
    _togglePicker() { (this._picker && this._picker.style.display === "block") ? this._closePicker() : this._openPicker(); },
    _closePicker() { if (this._picker) this._picker.style.display = "none"; },
    _openPicker() {
      if (!this._picker) { this._picker = document.createElement("div"); this._picker.className = "billi-picker"; document.body.appendChild(this._picker); }
      const p = this._picker; p.style.display = "block";
      const vs = ((window.speechSynthesis && speechSynthesis.getVoices()) || []).filter(v => /^en/i.test(v.lang));
      const cur = this._pickVoice();
      let html = '<div class="billi-pk-h">Voice</div><div class="billi-pk-list">';
      if (!vs.length) html += '<div class="billi-pk-empty">No voices loaded yet — reopen in a moment.</div>';
      vs.forEach(v => {
        const sel = (cur && cur.name === v.name) ? " sel" : "";
        html += '<button class="billi-pk-v' + sel + '" data-v="' + v.name.replace(/"/g, "&quot;") + '">' + v.name + ' <span>' + v.lang + '</span></button>';
      });
      html += '</div><div class="billi-pk-h">Character</div><div class="billi-pk-row">' +
        '<button class="billi-pk-c' + (this.cfg.profile === "warm" ? " sel" : "") + '" data-p="warm">Warm · Billi</button>' +
        '<button class="billi-pk-c' + (this.cfg.profile === "machine" ? " sel" : "") + '" data-p="machine">Machine</button></div>' +
        '<button class="billi-pk-close">Done</button>';
      p.innerHTML = html;
      p.querySelectorAll(".billi-pk-v").forEach(b => b.onclick = () => { this.setVoice(b.getAttribute("data-v")); this._sample(); this._openPicker(); });
      p.querySelectorAll(".billi-pk-c").forEach(b => b.onclick = () => { this.setProfile(b.getAttribute("data-p")); this._sample(); this._openPicker(); });
      p.querySelector(".billi-pk-close").onclick = () => this._closePicker();
    },

    _setState(s) {
      this.state = s;
      if (this._btn) this._btn.setAttribute("data-state", s);
      this._emit("state", { state: s });
    },
    _fail(err) { console.error("[BilliVoice]", err); this._emit("error", { message: String(err && err.message || err) }); this._setState("idle"); },
    _emit(name, detail) { document.dispatchEvent(new CustomEvent("billi:" + name, { detail })); },

    _injectStyles() {
      if (document.getElementById("billi-voice-css")) return;
      const css = document.createElement("style"); css.id = "billi-voice-css";
      css.textContent = `
.billi-mic{position:fixed;right:18px;bottom:18px;width:62px;height:62px;border:none;border-radius:50%;
  background:#F69B2D;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.28);display:flex;align-items:center;
  justify-content:center;z-index:9999;cursor:pointer;transition:transform .15s,background .2s}
.billi-mic:active{transform:scale(.94)}
.billi-mic svg{width:26px;height:26px;fill:#fff}
.billi-mic[data-state="listening"]{background:#2FB6E6;animation:billiPulse 1.1s infinite}
.billi-mic[data-state="thinking"]{background:#F2B233}
.billi-mic[data-state="speaking"]{background:#36D399}
.billi-mic[data-state="error"]{background:#E5573F}
.billi-mic[data-convo="on"]{box-shadow:0 0 0 3px #fff,0 0 0 6px #2FB6E6,0 6px 18px rgba(0,0,0,.3)}
.billi-lang{position:fixed;right:24px;bottom:86px;min-width:34px;height:26px;padding:0 8px;border:none;border-radius:13px;
  background:#15212a;color:#EAF6FF;font:600 12px Arial;z-index:9999;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.25)}
.billi-voice-btn{position:fixed;right:24px;bottom:200px;width:34px;height:34px;border:none;border-radius:50%;
  background:#15212a;z-index:9999;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}
.billi-voice-btn svg{width:18px;height:18px;fill:#EAF6FF}
.billi-picker{position:fixed;right:16px;bottom:244px;width:250px;max-height:54vh;overflow:auto;display:none;z-index:10002;
  background:#0e1622;border:1px solid #24323e;border-radius:14px;padding:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);font-family:Arial,sans-serif}
.billi-pk-h{color:#7FB7D8;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin:6px 4px 4px}
.billi-pk-list{display:flex;flex-direction:column;gap:4px}
.billi-pk-v{text-align:left;background:#15212a;border:1px solid transparent;color:#EAF6FF;font-size:13px;padding:8px 10px;border-radius:9px;cursor:pointer}
.billi-pk-v span{color:#8FA0AE;font-size:11px}
.billi-pk-v.sel{border-color:#F69B2D;background:#1d2a36}
.billi-pk-empty{color:#8FA0AE;font-size:12px;padding:8px}
.billi-pk-row{display:flex;gap:6px;margin-top:4px}
.billi-pk-c{flex:1;background:#15212a;border:1px solid transparent;color:#EAF6FF;font-size:12.5px;padding:8px;border-radius:9px;cursor:pointer}
.billi-pk-c.sel{border-color:#F69B2D;background:#1d2a36}
.billi-pk-close{width:100%;margin-top:8px;background:#F69B2D;border:none;color:#fff;font-weight:700;font-size:13px;padding:9px;border-radius:9px;cursor:pointer}
@keyframes billiPulse{0%{box-shadow:0 0 0 0 rgba(47,182,230,.5)}70%{box-shadow:0 0 0 16px rgba(47,182,230,0)}100%{box-shadow:0 0 0 0 rgba(47,182,230,0)}}`;
      document.head.appendChild(css);
    }
  };

  const MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  const GEAR_SVG = '<svg viewBox="0 0 24 24"><path d="M19.14 12.94a7.5 7.5 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.5 7.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96a7 7 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>';

  window.BilliVoice = BilliVoice;
  // self-init if a config object is present
  if (window.BILLI_VOICE_CONFIG) {
    if (document.readyState !== "loading") BilliVoice.init(window.BILLI_VOICE_CONFIG);
    else document.addEventListener("DOMContentLoaded", () => BilliVoice.init(window.BILLI_VOICE_CONFIG));
  }
})();
