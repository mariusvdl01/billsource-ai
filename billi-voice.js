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
    conversationMaxSilence: 2     // consecutive silent turns before the session auto-ends
  };

  const BilliVoice = {
    cfg: null, state: "idle", lang: null, _rec: null, _mr: null, _chunks: [], _audio: null, _btn: null, _langBtn: null,
    _convo: false, _silence: 0, _gotResult: false,

    init(userCfg) {
      this.cfg = Object.assign({}, DEFAULTS, userCfg || {});
      this.lang = this.cfg.lang;
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
      if (this._convo) setTimeout(() => { if (this._convo) this._startListening(); }, this.cfg.conversationRestartMs);
      else this._setState("idle");
    },
    _noInput() {           // listening ended with no speech captured
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
        await this._speak(reply);
      } catch (e) { this._fail(e); }
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
      u.lang = this.lang;
      const v = (speechSynthesis.getVoices() || []).find(x => x.lang === this.lang)
        || (speechSynthesis.getVoices() || []).find(x => x.lang.startsWith(this.lang.split("-")[0]));
      if (v) u.voice = v;
      u.onend = () => this._endTurn();
      speechSynthesis.cancel(); speechSynthesis.speak(u);
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
@keyframes billiPulse{0%{box-shadow:0 0 0 0 rgba(47,182,230,.5)}70%{box-shadow:0 0 0 16px rgba(47,182,230,0)}100%{box-shadow:0 0 0 0 rgba(47,182,230,0)}}`;
      document.head.appendChild(css);
    }
  };

  const MIC_SVG = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';

  window.BilliVoice = BilliVoice;
  // self-init if a config object is present
  if (window.BILLI_VOICE_CONFIG) {
    if (document.readyState !== "loading") BilliVoice.init(window.BILLI_VOICE_CONFIG);
    else document.addEventListener("DOMContentLoaded", () => BilliVoice.init(window.BILLI_VOICE_CONFIG));
  }
})();
