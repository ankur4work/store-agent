/**
 * StoreAgent voice chunk.
 *
 * ## Why this is a separate file
 *
 * `widget.js` ships on every page view of every storefront and has a hard 15 KB
 * gzipped budget, enforced in the build rather than reported afterwards. Voice
 * had grown to fill it — 79 bytes of headroom — and the next thing planned for
 * this path is a speech model with a 27 MB runtime, so the budget was not the
 * problem. Carrying the microphone on every page view was.
 *
 * `ARCHITECTURE §3.1` specified this from the start: "Voice chunk loads only
 * when the mic toggle is first pressed." It never got built, so one file has
 * been doing the work of three and being measured against the smallest of their
 * budgets. This is that chunk.
 *
 * A shopper who never presses the microphone now downloads none of it.
 *
 * ## The seam
 *
 * Registered as a factory on `window`, called once by the host with everything
 * it needs, and deleted immediately — a global that outlives its handoff is a
 * name another script on the merchant's page can collide with.
 *
 * The host passes references, not copies, for the two things that are mutated
 * (`els` and `state`) and an accessor for the one thing that is reassigned
 * (`CONFIG`, replaced wholesale when /api/config answers). Capturing that by
 * value would read an empty object forever.
 *
 * Everything about a voice turn lives in here. What crosses back out is eight
 * calls, listed at the bottom.
 *
 * ## Deliberately a pipeline, not speech-to-speech
 *
 * Speech-to-speech emits audio, so there is no text for the grounding validator
 * to check — and unlike a chat bubble, spoken audio cannot be retracted. We
 * only ever speak text the tripwire has already settled and validated, which
 * the gateway sends as `speak` events.
 */
(function () {
  'use strict';

  window.__storeagentVoice = function (host) {
    // Constants, captured once: these never change after the host boots.
    var API = host.API;
    var SHOP = host.SHOP;
    var BUILD = host.BUILD;

    // Live references. `els` is populated by the host's build() and `state` is
    // mutated in place by both sides; neither is ever reassigned, which is what
    // makes capturing them safe. Verified by a test.
    var els = host.els;
    var state = host.state;

    // Host behaviour this file calls into.
    var say = host.say;
    var persist = host.persist;
    var addMsg = host.addMsg;
    var stream = host.stream;
    var chosenLang = host.chosenLang;
    var pageLang = host.pageLang;

    // ---------- voice -------------------------------------------------------
    //
    // Deliberately a pipeline (STT -> grounded text turn -> TTS) rather than a
    // speech-to-speech model. Speech-to-speech emits audio, so there is no text
    // for the grounding validator to check — and unlike a chat bubble, spoken
    // audio cannot be retracted. We only ever speak text the tripwire has
    // already settled and validated, which the gateway sends as `speak` events.
    //
    // Mic permission is requested on the FIRST deliberate press, never on load.
    var voice = {
      on: false,
      recorder: null,
      /**
       * The active capture, whichever rung of the ladder produced it.
       *
       * `{ kind, stop(), active() }`. monitorSilence only ever asks "are you
       * recording" and "stop" — it used to ask a MediaRecorder directly, which
       * is why adding a second capture method needed this seam. See startCapture.
       */
      capture: null,
      /** Raw mono Float32 blocks, newest last. PCM rungs only. */
      pcm: [],
      pcmFrames: 0,
      /** One addModule per AudioContext, awaited by every later turn. */
      workletReady: null,
      /**
       * While this is in the future, loudness is measured but speech is not
       * counted. See the calibration window in monitorSilence.
       */
      calibratingUntil: 0,
      recognition: null,
      /** Which rung produced the live caption: 'ondevice', 'cloud', or null. */
      partials: null,
      interim: '',
      stream: null,
      chunks: [],
      queue: [],
      playing: null,
      ctx: null,
      analyser: null,
      // The analyser's input, and the stream it is wired to. Kept so a new
      // microphone can be reconnected — a graph left pointing at an ended
      // track reads silence forever.
      source: null,
      wiredTo: null,
      silenceSince: 0,
      // Set the moment playback is claimed, not when audio finally exists —
      // see enqueueSpeech. `gen` invalidates in-flight speech after a retraction.
      busy: false,
      gen: 0,
      spokeMs: 0,
      peak: 0,
      raf: 0,
    };

    /**
     * Report a milestone to the server. Owned by the host.
     *
     * The beacon itself is not voice-specific — the host sends one when the
     * shopper picks a language, and duplicating the fetch here would be two
     * copies of a redaction rule to keep in agreement. What IS voice-specific is
     * how much depends on it: this is the one path that cannot be tested from
     * outside a browser, because it needs a real microphone. Two attempts at the
     * endpointing bug were made blind, both wrong, and the server saw nothing
     * either time — a recorder that never stops never sends audio, so the logs
     * looked identical to "nobody tried it".
     *
     * No audio and no transcript ever. Only what happened, and the levels.
     */
    var voiceDiag = host.diag;

    /**
     * What this device could do, if we asked it to transcribe locally.
     *
     * Sent once per page, on the first mic press. The question it answers is not
     * rhetorical: on-device Whisper needs a WebGPU adapter and a connection that
     * can afford a model download, and whether that describes this store's
     * shoppers or only its developer is a fact about traffic, not about the
     * technology. Shipping it on an assumption is how you find out afterwards
     * that everyone was on a phone that fell back to the server anyway.
     *
     * Every probe is guarded and the whole thing is time-boxed, because this runs
     * on the path where the shopper has just pressed a microphone. It is reported
     * AFTER the mic is granted and never awaited by anything the shopper waits on.
     */
    var capsSent = false;

    function probeCaps() {
      var caps = {
        worklet: !!(window.AudioWorkletNode && window.AudioContext && AudioContext.prototype.audioWorklet !== undefined),
        sr: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        recorder: typeof MediaRecorder !== 'undefined',
        mem: navigator.deviceMemory || null,
        cores: navigator.hardwareConcurrency || null,
      };
      try {
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        caps.net = (c && c.effectiveType) || null;
        caps.saveData = !!(c && c.saveData);
      } catch (e) {
        caps.net = null;
      }

      // `requestAdapter()` is the only honest test — `navigator.gpu` exists on
      // devices that then fail to produce an adapter, and counting those as
      // capable would overstate the local path's reach. Time-boxed because it is
      // allowed to take as long as it likes.
      if (!navigator.gpu || !navigator.gpu.requestAdapter) {
        caps.webgpu = false;
        return Promise.resolve(caps);
      }
      return Promise.race([
        navigator.gpu.requestAdapter().then(
          function (a) { return !!a; },
          function () { return false; },
        ),
        new Promise(function (r) { setTimeout(function () { r(false); }, 400); }),
      ]).then(function (ok) {
        caps.webgpu = ok;
        return caps;
      });
    }

    function reportCaps() {
      if (capsSent) return;
      capsSent = true;
      try {
        probeCaps().then(function (caps) {
          voiceDiag('caps', { caps: caps });
        });
      } catch (e) {
        /* a census must never cost a shopper their voice turn */
      }
    }

    /**
     * The short rising chime a mic makes when it opens.
     *
     * Every voice UI a shopper has used — Google, YouTube, a phone assistant —
     * marks the moment it starts listening with a sound, and they have learned
     * to wait for it. Ours opened in silence, so there was no signal to speak
     * against: people talked before it was recording, or waited for something
     * that never came and were endpointed on their own hesitation.
     *
     * Synthesised rather than a file: two oscillator notes cost nothing, need
     * no asset on the critical path, and cannot 404 on a merchant's CDN.
     */
    /**
     * Paint the bars from a frequency spectrum.
     *
     * `buf` is the analyser's byte data; the bars sample across it so the
     * shape reflects the actual voice rather than one averaged number moving
     * every bar together. A floor of 0.12 keeps the bars visible at rest —
     * collapsed to nothing reads as broken, which is the opposite of what a
     * listening indicator is for.
     */
    function drawWave(buf, gain) {
      var bars = els.waveBars;
      if (!bars || !bars.length) return;
      var per = Math.max(1, Math.floor(buf.length / bars.length));
      for (var i = 0; i < bars.length; i++) {
        var sum = 0;
        for (var j = 0; j < per; j++) sum += buf[i * per + j] || 0;
        var v = (sum / per / 255) * (gain || 1);
        bars[i].style.transform = 'scaleY(' + Math.max(0.12, Math.min(1, v)).toFixed(3) + ')';
      }
    }

    /** Collapse the bars to rest. */
    function idleWave() {
      if (els.wave) els.wave.className = 'wave';
      (els.waveBars || []).forEach(function (b) {
        b.style.transform = 'scaleY(0.15)';
      });
    }

    /**
     * Animate the bars from the SPOKEN audio while the assistant replies.
     *
     * A second analyser, on the playback element rather than the microphone.
     * Without it the bars freeze the moment the shopper stops talking and the
     * widget looks hung through the part where it is actually answering.
     */
    function watchPlayback(audio) {
      try {
        if (!voice.ctx) return;
        if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();
        var src = voice.ctx.createMediaElementSource(audio);
        var an = voice.ctx.createAnalyser();
        an.fftSize = 128;
        // Through the analyser AND on to the speakers — a MediaElementSource
        // re-routes the audio, so skipping this connection mutes the reply.
        src.connect(an).connect(voice.ctx.destination);
        var buf = new Uint8Array(an.frequencyBinCount);
        if (els.wave) els.wave.className = 'wave speaking';
        var tick = function () {
          if (voice.playing !== audio) return idleWave();
          an.getByteFrequencyData(buf);
          drawWave(buf, 1.6);
          voice.playRaf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        // Safari throws if an element is re-sourced. The reply still plays.
      }
    }

    function cue(kind) {
      try {
        if (!voice.ctx) return;
        if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();
        var now = voice.ctx.currentTime;
        // Up to start, down to finish — the direction people already read as
        // "go" and "done".
        var notes = kind === 'start' ? [660, 880] : [660, 440];
        notes.forEach(function (hz, i) {
          var osc = voice.ctx.createOscillator();
          var gain = voice.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = hz;
          // Quiet, and shaped — a square-edged beep at full volume in a
          // shopper's ear is a reason to close the widget.
          gain.gain.setValueAtTime(0.0001, now + i * 0.07);
          gain.gain.exponentialRampToValueAtTime(0.06, now + i * 0.07 + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.07);
          osc.connect(gain).connect(voice.ctx.destination);
          osc.start(now + i * 0.07);
          osc.stop(now + i * 0.07 + 0.08);
        });
      } catch (e) {
        /* a missing chime must never stop the mic working */
      }
    }

    function setVoiceState(s) {
      if (els.mic) els.mic.dataset.state = s;
      if (els.status) {
        els.status.textContent =
          s === 'listening' ? 'Listening…' : s === 'speaking' ? 'Speaking' : s === 'thinking' ? 'Thinking…' : 'Ready';
      }
    }

    async function toggleVoice() {
      if (voice.on) {
        voiceDiag('mic_off');
        return stopVoice(true);
      }
      voiceDiag('mic_on', {
        hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        hasRecorder: typeof MediaRecorder !== 'undefined',
        mime: typeof MediaRecorder === 'undefined' ? null : pickMime(),
      });
      warmUpload();
      try {
        voice.stream = await navigator.mediaDevices.getUserMedia({
          /**
           * Stated, not left to the browser.
           *
           * These three default differently per browser and per OS, and they
           * were previously requested without the channel and rate hints — so a
           * laptop with a stereo array handed back two channels which were then
           * downmixed anyway, at 48 kHz, and uploaded at three times the bytes
           * the recogniser reads.
           *
           * `sampleRate` is a hint that most browsers ignore, which is why the
           * capture path resamples regardless rather than trusting it. Asking
           * costs nothing and occasionally works.
           */
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (e) {
        voiceDiag('mic_denied', { error: String((e && e.name) || e) });
        // Permission denied is a normal outcome, not an error state. Fall back
        // to text without ceremony.
        els.voicebar.classList.remove('on');
        addMsg('bot', 'I couldn’t get microphone access — type instead and I’ll help the same way.');
        return;
      }
      voice.on = true;
      els.voicebar.classList.add('on');
      // After permission, so a shopper who declines is never profiled, and never
      // awaited — the census must not sit between the press and the chime.
      reportCaps();
      startCapture();
    }

    /**
     * Open the connection to the gateway before the shopper finishes speaking.
     *
     * The upload that follows is the first request of the turn, so it pays for
     * DNS, TCP and the TLS handshake — a few hundred milliseconds on a phone,
     * spent entirely inside the window where the shopper is waiting to be
     * answered. Pressing the mic is several seconds of warning that a request is
     * coming, and this is the whole of what it costs to use it.
     *
     * `preconnect` rather than a probe request: no bytes, no log line, and the
     * browser will drop it harmlessly if it decides otherwise.
     */
    function warmUpload() {
      try {
        if (!API || voice.warmed) return;
        voice.warmed = true;
        var l = document.createElement('link');
        l.rel = 'preconnect';
        l.href = API;
        l.crossOrigin = 'anonymous';
        document.head.appendChild(l);
      } catch (e) {
        /* a missed handshake is slower, not broken */
      }
    }

    function stopVoice(full) {
      cancelAnimationFrame(voice.raf);
      cancelAnimationFrame(voice.playRaf);
      stopRecognition();
      idleWave();
      /**
       * Tapping the mic off DISCARDS the recording. It used to submit it.
       *
       * `stop()` on a MediaRecorder fires `onstop` asynchronously, after
       * `voice.on` has already been cleared — and the old handler uploaded
       * anything over 1200 bytes without asking whether the turn was still
       * wanted. So pressing stop sent the half-sentence anyway and the assistant
       * answered a question the shopper had visibly cancelled.
       *
       * Ending a turn on the endpointer passes `true`; every other caller here
       * means "stop listening", which is not the same thing as "send it".
       */
      if (voice.capture && voice.capture.active()) voice.capture.stop(false);
      if (full && voice.stream) voice.stream.getTracks().forEach(function (t) { t.stop(); });
      if (full) {
        voice.on = false;
        voice.stream = null;
        els.voicebar.classList.remove('on');
        stopPlayback();
      }
      setVoiceState('idle');
    }

    /**
     * The upload sample rate, and why it is not the microphone's.
     *
     * Mirrors TARGET_RATE in packages/voice/src/wav.ts — pinned by a test,
     * because two copies of a number is how they drift.
     *
     * A browser hands back 44.1 or 48 kHz because that is what the hardware runs
     * at. Every speech recogniser in use resamples to 16 kHz internally before it
     * looks at the audio, so the extra bandwidth carries no information the
     * decoder will ever read — and it carries three times the bytes. A
     * four-second turn is 384 KB at 48 kHz and 128 KB at 16 kHz, which on a
     * phone's uplink is the largest single term in time-to-transcript, larger
     * than the recogniser's own latency.
     */
    var UPLOAD_RATE = 16000;

    /** Stop growing the buffer past this, if the endpointer ever fails to fire. */
    var MAX_CAPTURE_SECONDS = 25;

    /**
     * The capture worklet, as source.
     *
     * Inlined and loaded from a blob URL rather than served as a file: widget.js
     * ships as one asset under a 15 KB gzipped budget enforced in
     * scripts/build-widget.mjs, and a second network request on the mic path is
     * exactly the latency this change exists to remove.
     *
     * Buffers to 2048 frames before posting — about 23 messages a second instead
     * of the 375 that posting every 128-frame render quantum would cost.
     */
    var WORKLET_SRC =
      'class P extends AudioWorkletProcessor{' +
      'constructor(){super();this.buf=new Float32Array(2048);this.n=0}' +
      'process(inputs){' +
      'var ch=inputs[0]&&inputs[0][0];' +
      'if(ch){for(var i=0;i<ch.length;i++){this.buf[this.n++]=ch[i];' +
      'if(this.n===this.buf.length){this.port.postMessage(this.buf.slice(0));this.n=0}}}' +
      'return true}}' +
      'registerProcessor("sa-capture",P)';

    function pushPcm(block) {
      if (!block || !block.length) return;
      if (voice.pcmFrames > MAX_CAPTURE_SECONDS * (voice.ctx ? voice.ctx.sampleRate : 48000)) return;
      voice.pcm.push(block);
      voice.pcmFrames += block.length;
    }

    /**
     * A uniform handle over whichever rung captured the audio.
     *
     * monitorSilence only ever asks "are you still recording" and "stop". It used
     * to ask a MediaRecorder those questions directly, which is the reason adding
     * a second capture method needed a seam at all.
     */
    function pcmCapture(kind, teardown) {
      var live = true;
      return {
        kind: kind,
        active: function () { return live; },
        stop: function (submit) {
          if (!live) return;
          live = false;
          try {
            teardown();
          } catch (e) {
            /* the graph is going away regardless */
          }
          var blob = submit === false ? null : pcmToWav();
          voice.pcm = [];
          voice.pcmFrames = 0;
          if (submit !== false) onCaptured(blob, kind);
        },
      };
    }

    /**
     * Capture raw PCM off the graph the level meter already built.
     *
     * This replaces MediaRecorder → decodeAudioData → downmix → re-encode with a
     * tap on the microphone source. Two things fall out of it: the encode/decode
     * round trip disappears from every turn, and the samples exist as the shopper
     * speaks rather than only after the container is closed — which is what makes
     * a 16 kHz upload free instead of another pass over the audio.
     *
     * Returns the rung's name, or null if none of them worked.
     */
    async function startPcmCapture() {
      var ctx = voice.ctx;
      if (!ctx || !voice.source) return null;

      if (ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          if (!voice.workletReady) {
            var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
            voice.workletReady = ctx.audioWorklet.addModule(url).then(
              function () {
                URL.revokeObjectURL(url);
              },
              function (e) {
                URL.revokeObjectURL(url);
                throw e;
              },
            );
          }
          await voice.workletReady;
          var node = new AudioWorkletNode(ctx, 'sa-capture');
          node.port.onmessage = function (e) {
            pushPcm(e.data);
          };
          voice.source.connect(node);
          // Deliberately NOT connected to the destination. A worklet runs whether
          // or not its output goes anywhere, and routing the microphone to the
          // speakers is how a shopper hears themselves half a second late.
          voice.capture = pcmCapture('worklet', function () {
            node.port.onmessage = null;
            voice.source.disconnect(node);
          });
          return 'worklet';
        } catch (e) {
          // A worklet can fail for reasons that have nothing to do with support —
          // a blob URL blocked by a merchant's CSP, most likely. Say so, because
          // otherwise this silently costs every shopper on that store the faster
          // path and nothing anywhere reports it.
          voiceDiag('worklet_failed', { error: String((e && e.message) || e) });
          voice.workletReady = null;
        }
      }

      try {
        if (!ctx.createScriptProcessor) return null;
        var sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = function (e) {
          // Copied, not referenced: the buffer is reused by the next callback.
          pushPcm(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        voice.source.connect(sp);
        /**
         * A ScriptProcessorNode does not run unless its output reaches the
         * destination — and the microphone must not. A zero gain satisfies both
         * requirements, which is the only reason this node exists.
         */
        var mute = ctx.createGain();
        mute.gain.value = 0;
        sp.connect(mute);
        mute.connect(ctx.destination);
        voice.capture = pcmCapture('script', function () {
          sp.onaudioprocess = null;
          voice.source.disconnect(sp);
          sp.disconnect();
          mute.disconnect();
        });
        return 'script';
      } catch (e) {
        voiceDiag('script_processor_failed', { error: String((e && e.message) || e) });
      }
      return null;
    }

    /** Concatenate, resample to 16 kHz, and write a WAV. */
    function pcmToWav() {
      if (!voice.pcmFrames) return null;
      var rate = voice.ctx ? voice.ctx.sampleRate : 48000;
      var all = new Float32Array(voice.pcmFrames);
      var at = 0;
      for (var i = 0; i < voice.pcm.length; i++) {
        all.set(voice.pcm[i], at);
        at += voice.pcm[i].length;
      }
      return wavBlob(resampleTo(all, rate, UPLOAD_RATE), UPLOAD_RATE);
    }

    /**
     * Resample by averaging each output sample's input window.
     *
     * Mirrors `resample` in packages/voice/src/wav.ts. The averaging IS the
     * anti-alias filter: decimating 48 kHz to 16 kHz by picking every third
     * sample folds everything above 8 kHz back down into the speech band, so
     * sibilance and room hiss reappear as energy nobody produced. One multiply
     * per input sample removes it.
     */
    function resampleTo(samples, from, to) {
      if (from === to || !samples.length) return samples;
      var ratio = from / to;
      var out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
      if (ratio <= 1) {
        for (var i = 0; i < out.length; i++) {
          var pos = i * ratio;
          var lo = Math.floor(pos);
          var hi = Math.min(samples.length - 1, lo + 1);
          var frac = pos - lo;
          out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
        }
        return out;
      }
      for (var j = 0; j < out.length; j++) {
        var start = Math.floor(j * ratio);
        var end = Math.min(samples.length, Math.floor((j + 1) * ratio));
        var sum = 0;
        for (var k = start; k < end; k++) sum += samples[k];
        out[j] = end > start ? sum / (end - start) : samples[start] || 0;
      }
      return out;
    }

    /** Mono 16-bit PCM WAV. Mirrors encodeWav in packages/voice/src/wav.ts. */
    function wavBlob(samples, rate) {
      var view = new DataView(new ArrayBuffer(44 + samples.length * 2));
      var ascii = function (off, s) {
        for (var k = 0; k < s.length; k++) view.setUint8(off + k, s.charCodeAt(k));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (var i = 0; i < samples.length; i++) {
        var v = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      return new Blob([view.buffer], { type: 'audio/wav' });
    }

    async function startCapture() {
      voice.pcm = [];
      voice.pcmFrames = 0;
      voice.chunks = [];
      voice.capture = null;
      voice.recorder = null;
      voice.interim = '';

      // Builds the AudioContext, the analyser and the microphone source. The PCM
      // tap hangs off that same graph, so it has to exist first — and the tick it
      // starts will not endpoint while `voice.capture` is still null.
      monitorSilence();

      var kind = await startPcmCapture();
      if (kind === null) kind = startRecorderCapture();

      setVoiceState('listening');
      if (els.wave) els.wave.className = 'wave live';
      if (els.live) els.live.textContent = 'Listening…';
      voice.recognition = startRecognition();
      /**
       * One beacon per turn, carrying which rung produced the live caption.
       *
       * The three fields together are what make it actionable, and they are
       * counted server-side: `partials=cloud` with `state=downloadable` is a
       * merchant who has not enabled installs, while `partials=cloud` with
       * `state=error` is a Permissions-Policy blocking us. Those need different
       * answers and are otherwise indistinguishable — on-device recognition is
       * chosen by a probe, on a device we cannot see, so "it worked", "it
       * silently never ran" and "it ran for nobody" all look the same from here.
       */
      voiceDiag('capture_start', {
        interim: !!voice.recognition,
        capture: kind,
        partials: voice.partials || 'none',
        mode: onDeviceMode(),
        state: onDevice.state || 'unprobed',
        rate: voice.ctx ? voice.ctx.sampleRate : null,
      });
      // Plays through the same AudioContext, so it has to follow monitorSilence.
      cue('start');
    }

    /**
     * Last resort: the old MediaRecorder path, kept whole.
     *
     * Reached when there is no worklet and no ScriptProcessorNode — an unusual
     * browser, or a Content-Security-Policy that blocks the blob URL the worklet
     * loads from. It is slower and it is the container that produced every
     * fabricated transcript in this project's history, so it is third. It is
     * still here because the alternative on such a device is no voice at all.
     */
    function startRecorderCapture() {
      if (typeof MediaRecorder === 'undefined') return null;
      voice.chunks = [];
      var rec = new MediaRecorder(voice.stream, { mimeType: pickMime() });
      voice.recorder = rec;
      var discard = false;
      rec.ondataavailable = function (e) { if (e.data.size) voice.chunks.push(e.data); };
      rec.onstop = function () {
        // A cancelled turn ends here and goes no further, so `null` reaching
        // onCaptured means one thing everywhere: we meant to send and had
        // nothing. See the dead-capture path there.
        if (discard) return;
        onCaptured(new Blob(voice.chunks, { type: rec.mimeType }), 'recorder');
      };
      /**
       * No timeslice.
       *
       * `start(100)` asks for a chunk every 100ms, and nothing here wants them —
       * the blob is only ever read once, on stop. What it does do is force the
       * encoder to emit a fragmented stream, where the first chunk carries the
       * header and the rest are bare clusters with no duration. Concatenated back
       * into a file, that is a container a decoder is entitled to give up on
       * partway through, and a decoder that has run out of audio does not stop —
       * it invents.
       */
      rec.start();
      voice.capture = {
        kind: 'recorder',
        active: function () { return rec.state === 'recording'; },
        // MediaRecorder cannot be cancelled synchronously, so the intent is
        // recorded here and read in onstop above.
        stop: function (submit) {
          discard = submit === false;
          if (rec.state !== 'inactive') rec.stop();
        },
      };
      return 'recorder';
    }

    /**
     * One place every capture rung ends up, so the gates below cannot diverge.
     *
     * A cancelled turn never arrives here, so `blob` is null for exactly one
     * reason: the endpointer asked for the audio and the capture had none.
     */
    function onCaptured(blob, kind) {
      // The recogniser has done its job once the utterance is over; leaving it
      // running would keep a second microphone consumer alive through
      // transcription and the spoken answer.
      stopRecognition();
      var spoke = Math.round(voice.spokeMs);
      voiceDiag('captured', {
        bytes: blob ? blob.size : 0,
        type: blob ? blob.type : null,
        capture: kind,
        spokeMs: spoke,
      });
      /**
       * A capture that delivered nothing at all.
       *
       * The graph was connected, the endpointer fired, and not one sample
       * arrived — a worklet that never ran, a track that ended underneath us, a
       * context left suspended. Returning quietly here is what a first draft of
       * this did, and it left the panel reading "Listening…" forever with a
       * capture that had already stopped: nothing would endpoint again, because
       * nothing was recording.
       *
       * So it ends the turn and says so. An unexplained dead end is the failure
       * mode this whole path has been fighting.
       */
      if (blob === null) {
        voiceDiag('capture_empty', { capture: kind, spokeMs: spoke });
        if (els.live) els.live.textContent = "I didn't catch that — tap to try again.";
        endVoiceTurn();
        return;
      }

      /**
       * Bytes are not speech, and this gate only counted bytes.
       *
       * A few seconds of a quiet room is comfortably more than 1200 bytes of
       * opus, so silence was uploaded like any other turn — and a decoder handed
       * silence does not return nothing, it returns something. That is where
       * "context:", "###" and a Polish shopping list came from: every one of them
       * was a capture in which nobody had said a word.
       *
       * We already know whether anyone spoke — spokeMs is what the endpointer
       * uses to decide the turn is over. Asking it here costs nothing and removes
       * the entire class at the source, before the request.
       *
       * A meter reading nothing at all, though, is a broken meter and not a quiet
       * room. Gating on a signal without checking the signal exists is how this
       * once went from "sometimes invents a shopper" to "does not work at all":
       * the analyser was wired to a dead stream, every reading was zero, and so
       * every real sentence was discarded as silence. A real microphone in a real
       * room produces a non-zero peak within a frame or two, so an exact zero
       * across a whole capture means the level is not measuring anything — and
       * then we trust the recording and send it. The worst case is the
       * fabrication filter earning its keep server-side; silently disabling the
       * feature is not on the list.
       */
      if (spoke < MIN_SPEECH_MS && (voice.peak || 0) > 0) {
        voiceDiag('discarded_silence', { bytes: blob.size, spokeMs: spoke });
        if (els.live) els.live.textContent = "I didn't catch that — tap to try again.";
        endVoiceTurn();
        return;
      }
      if (spoke < MIN_SPEECH_MS) {
        // Uploading anyway, but say so: this is the level meter failing, and
        // it is the only place that failure is visible.
        voiceDiag('level_meter_dead', { bytes: blob.size, peak: voice.peak || 0 });
      }
      if (blob.size > 1200) transcribeAndSend(blob);
      else if (voice.on) startCapture(); // too short to be speech
    }

    function pickMime() {
      var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      for (var i = 0; i < candidates.length; i++) {
        if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      }
      return '';
    }

    // Energy-based endpointing — deciding the shopper has stopped talking.
    //
    // This used to compare loudness against a hard-coded `level > 12`. That
    // number is only meaningful in a silent room. On a storefront with music
    // playing, a fan, traffic, or a busy shop, the ambient level sits ABOVE 12
    // permanently — so silence was never detected, the recorder never stopped,
    // and the shopper finished speaking to an assistant that just kept
    // listening. Nothing errored; it simply never answered.
    //
    // So the threshold is measured rather than assumed. The quietest recent
    // level is the room's noise floor, and speech is what rises clearly above
    // it. A room being loud no longer means the shopper is talking.
    //
    // Silence windows mirror packages/voice/src/endpoint.ts. That module varies
    // the wait by what was actually said — 260ms after a finished question,
    // 1100ms after "something warm and" — but it needs a transcript, and here
    // there is only loudness. `base` is the right choice when nothing is known.
    // Mirrors THRESHOLDS in packages/voice/src/endpoint.ts. Pinned by a test,
    // because two copies of a number is how they drift.
    var ENDPOINT_COMPLETE_MS = 260;  // a finished question — answer promptly
    var ENDPOINT_SILENCE_MS = 550;   // nothing conclusive either way
    var ENDPOINT_HANGING_MS = 1100;  // ends mid-thought — do not cut in
    var MIN_SPEECH_MS = 250;       // shorter than this is a cough, not a turn
    /**
     * The window in which the room is measured and the shopper is not.
     *
     * Starts at 180ms so it does not measure our own opening chime, which is an
     * acoustic event we caused and not the room. 300ms of it is enough for a
     * stable mean at ~60 frames a second, and short enough that a shopper who
     * starts talking straight away loses no words — capture runs from t=0; only
     * the speech accounting waits.
     */
    var CALIBRATE_FROM_MS = 180;
    var CALIBRATE_TO_MS = 480;
    var MAX_UTTERANCE_MS = 20000;  // a hard stop, so noise cannot record forever
    var IDLE_GIVE_UP_MS = 8000;    // heard nothing at all — mic muted or dead

    /** Words that almost never end an utterance. Mirrors endpoint.ts. */
    var HANGING = (
      "and but or so because if when while that which the a an my your this these those some any " +
      "to for with about from in on at of like um uh er hmm well maybe actually just is are was " +
      "were do does can could would should i i'm it's its you we they he she"
    ).split(' ');
    var QUESTION_OPENERS =
      /^(?:do|does|did|is|are|was|were|can|could|will|would|should|have|has|what|when|where|why|who|which|how)\b/i;

    /**
     * How long to wait on silence, given what has been said so far.
     *
     * The server has carried this logic since Phase 3 and it has never run: it
     * needs a transcript, and the widget only ever had loudness, so every
     * utterance got the same 550ms. 400ms after "how much is the wool coat?"
     * means finished; the same 400ms after "something warm and" means still
     * thinking, and cutting in there is both rude and wrong.
     *
     * With interim text there is finally something to read.
     */
    function silenceWindowFor(transcript) {
      var text = (transcript || '').trim();
      /**
       * No recogniser means no evidence, so do not cut in.
       *
       * The 550ms default assumes we read the transcript and found nothing
       * conclusive. When the browser has no SpeechRecognition at all there is
       * no transcript to read, and every utterance silently took the
       * shortest-but-one window — so an ordinary mid-sentence pause ended the
       * turn. The diagnostics show it plainly: `interim:false` on every
       * capture, and one turn endpointed on 426ms of speech.
       *
       * A fragment is worse than a wait. Half a sentence is not transcribed
       * as half a sentence — the decoder fills the gap, and that invention
       * is where "Kaņepju piens" came from on an English storefront.
       */
      if (text === '' && !voice.recognition) return ENDPOINT_HANGING_MS;
      if (text === '') return ENDPOINT_SILENCE_MS;
      var lastWord = (/([a-z']+)[^a-z']*$/i.exec(text) || ['', ''])[1].toLowerCase();
      if (HANGING.indexOf(lastWord) !== -1) return ENDPOINT_HANGING_MS;
      if (/[.!?]$/.test(text)) return ENDPOINT_COMPLETE_MS;
      if (QUESTION_OPENERS.test(text) && text.split(/\s+/).length >= 3) return ENDPOINT_COMPLETE_MS;
      return ENDPOINT_SILENCE_MS;
    }

    /**
     * Live interim text, from the browser's own recogniser.
     *
     * Display only. The authoritative transcript still comes from the server,
     * which is language-locked and identical in every browser — this just
     * fills the gap between speaking and being answered, which was silent and
     * made the widget feel like it had stopped responding.
     *
     * It also, finally, gives the endpointer a transcript to judge.
     *
     * Firefox has no SpeechRecognition; there it simply does not run and
     * everything else behaves exactly as before.
     */
    /**
     * On-device recognition: what the browser can do without sending audio away.
     *
     * Chrome exposes `SpeechRecognition.available()` and `install()` with a
     * `processLocally` flag, backed by language packs the browser downloads and
     * manages itself. That is worth reaching for twice over: the shopper's voice
     * stops leaving their machine, and the interim transcript arrives without a
     * network round trip — which is what lets the endpointer tell a pause
     * mid-sentence from the end of a question.
     *
     * State is probed ONCE per page and never awaited on the path to the chime.
     * The first turn therefore behaves exactly as it does today, and later turns
     * use whatever the probe found. Awaiting an availability check between the
     * shopper pressing the microphone and the sound that tells them to speak
     * would trade the thing we are buying for the thing we are buying it with.
     */
    var onDevice = { probed: false, state: null, installing: false, installed: null };

    /** The merchant's choice. See ShopSettings.onDeviceSpeech. */
    function onDeviceMode() {
      var m = host.config().onDeviceSpeech;
      return m === 'off' || m === 'on' || m === 'auto' ? m : 'auto';
    }

    /**
     * The language tag to ask for a pack in.
     *
     * Our languages are bare ISO-639-1 codes, which are valid BCP-47 — but the
     * packs a browser installs are regioned, and one that holds "en-US" can
     * answer "unavailable" for "en". So the shopper's own locale wins when it is
     * the same language, and the bare code is the fallback.
     *
     * 'auto' means the merchant asked for detection and there is no single
     * language to request a pack for; the browser's own locale is the only
     * honest guess available.
     */
    function langTag() {
      var l = (els.lang && els.lang.value) || chosenLang();
      var nav = navigator.language || 'en-US';
      if (!l || l === 'auto') return nav;
      if (nav.toLowerCase().indexOf(l.toLowerCase() + '-') === 0) return nav;
      return l;
    }

    function probeOnDevice(SR) {
      onDevice.probed = true;
      if (typeof SR.available !== 'function') {
        onDevice.state = 'unsupported';
        return;
      }
      var tag = langTag();
      try {
        // Quality is left at its default. MDN documents a `quality` option, and
        // depending on it would mean branching on an experimental parameter whose
        // only effect here is to make availability read stricter — which would
        // turn a working local recogniser into an unavailable one.
        Promise.resolve(SR.available({ langs: [tag], processLocally: true }))
          .then(function (state) {
            onDevice.state = String(state);
            voiceDiag('ondevice', { state: onDevice.state, lang: tag, mode: onDeviceMode() });
          })
          .catch(function (e) {
            // Blocked by a Permissions-Policy, most likely: access to this is
            // controlled by the `on-device-speech-recognition` directive, and a
            // merchant's theme or CDN can withhold it. Not an error we can fix
            // from here, and the cloud rung below is unaffected.
            onDevice.state = 'error';
            voiceDiag('ondevice', { state: 'error', reason: String((e && e.name) || e) });
          });
      } catch (e) {
        onDevice.state = 'error';
      }
    }

    /**
     * Install the language pack, between turns and never during one.
     *
     * A pack is tens of megabytes the browser fetches and stores. Starting that
     * while someone is mid-sentence would compete with the upload they are
     * waiting on, so it is scheduled from the end of a turn — and only when the
     * merchant has asked for it, because it spends the shopper's bandwidth.
     */
    function maybeInstallOnDevice() {
      if (onDevice.installing || onDevice.state !== 'downloadable') return;
      if (onDeviceMode() !== 'on') return;
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR || typeof SR.install !== 'function') return;
      // Not on a metered or slow connection. `saveData` is the shopper saying so
      // explicitly, and ignoring it to install a speech model would be rude.
      try {
        var c = navigator.connection || {};
        if (c.saveData === true) return;
        if (c.effectiveType && /^(slow-2g|2g|3g)$/.test(c.effectiveType)) return;
      } catch (e) {
        /* no Network Information API: proceed, the browser manages the download */
      }
      onDevice.installing = true;
      var tag = langTag();
      try {
        Promise.resolve(SR.install({ langs: [tag], processLocally: true }))
          .then(function (ok) {
            onDevice.installed = ok === true;
            if (ok === true) onDevice.state = 'available';
            voiceDiag('ondevice_install', { ok: ok === true, lang: tag });
          })
          .catch(function (e) {
            voiceDiag('ondevice_install', { ok: false, reason: String((e && e.name) || e) });
          })
          .then(function () {
            onDevice.installing = false;
          });
      } catch (e) {
        onDevice.installing = false;
      }
    }

    function startRecognition() {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return null;
      // Background, once per page. Never awaited — see the note on `onDevice`.
      if (!onDevice.probed) probeOnDevice(SR);
      var local = onDevice.state === 'available' && onDeviceMode() !== 'off';
      try {
        var rec = new SR();
        if (local) {
          /**
           * Not a hint. `processLocally = true` is a requirement: the recogniser
           * either stays on the device or refuses to start, which is the whole
           * point — a flag that silently fell back to the cloud would make the
           * privacy claim in the admin copy untrue.
           */
          rec.processLocally = true;
        }
        /**
         * The storefront's language, then the browser's — never a hard-coded
         * en-US.
         *
         * A shopper on a Spanish storefront speaking Spanish got interim text
         * in English, because the recogniser had been pinned to en-US and
         * will cheerfully transliterate whatever it hears into the language
         * it was told to expect. `<html lang>` is what the merchant's theme
         * declares, which is the best available statement of who the shop is
         * for; the browser's own language is the fallback.
         *
         * The authoritative transcript is unaffected either way — the server
         * detects the language independently — so a wrong guess here costs
         * the live caption, not the answer.
         */
        /**
         * The language the shopper picked, then the page, then the browser.
         *
         * This used to start at the page's `<html lang>`, on the grounds that a
         * wrong guess costs the caption and not the answer. It still does — but
         * the shopper now chooses a microphone language explicitly, and that
         * choice is the most specific statement available of what they are about
         * to speak. It is also the tag the on-device pack is requested in, so
         * using anything else here would caption in one language and recognise
         * locally in another.
         */
        rec.lang =
          langTag() ||
          host.scriptLang ||
          document.documentElement.getAttribute('lang') ||
          navigator.language ||
          'en-US';
        rec.interimResults = true;
        rec.continuous = true;
        rec.onresult = function (e) {
          var text = '';
          for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
          voice.interim = text.trim();
          if (voice.interim && els.live) els.live.textContent = voice.interim;
        };
        // A recogniser that dies must never take the recording with it.
        rec.onerror = function () {};
        rec.onend = function () {};
        rec.start();
        voice.partials = local ? 'ondevice' : 'cloud';
        return rec;
      } catch (e) {
        /**
         * One retry, without the local requirement.
         *
         * `processLocally = true` makes the recogniser refuse rather than fall
         * back, which is what makes it trustworthy — and it means a pack that has
         * been evicted since the probe throws here. A live caption is worth more
         * than where it came from, so the cloud rung gets one attempt, and the
         * probe result is corrected so the next turn does not repeat this.
         */
        if (local) {
          onDevice.state = 'unavailable';
          voiceDiag('ondevice_failed', { reason: String((e && e.name) || e) });
          return startRecognition();
        }
        voice.partials = null;
        return null;
      }
    }

    function stopRecognition() {
      if (!voice.recognition) return;
      try {
        voice.recognition.onresult = null;
        voice.recognition.stop();
      } catch (e) {}
      voice.recognition = null;
    }


    function monitorSilence() {
      if (!voice.ctx) {
        voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
        voice.analyser = voice.ctx.createAnalyser();
        voice.analyser.fftSize = 512;
      }
      /**
       * Rewire the analyser whenever the microphone itself changes.
       *
       * This used to be part of the block above, so the graph was built once
       * and bound to whatever stream existed on the FIRST voice turn. Ending a
       * turn releases the microphone, so the next turn calls getUserMedia
       * again and gets a new stream — while the analyser stayed connected to
       * the old, ended one. A dead track produces all-zero frequency data, so
       * every reading after the first turn was level 0, floor 0, peak 0.
       *
       * It was invisible for as long as nothing depended on the level: the
       * endpointer's unconditional backstop stopped the recorder anyway and
       * the audio was uploaded regardless. The moment the upload started
       * asking "did anyone actually speak", the answer was permanently no and
       * voice stopped working entirely from the second turn on.
       */
      if (voice.wiredTo !== voice.stream) {
        if (voice.source) {
          try {
            voice.source.disconnect();
          } catch (e) {
            /* already gone with its stream */
          }
        }
        voice.source = voice.ctx.createMediaStreamSource(voice.stream);
        voice.source.connect(voice.analyser);
        voice.wiredTo = voice.stream;
      }
      // Resume matters on iOS/Safari, where the context starts suspended and
      // every level reads 0 — which looks exactly like silence forever.
      if (voice.ctx.state === 'suspended' && voice.ctx.resume) voice.ctx.resume();

      var buf = new Uint8Array(voice.analyser.frequencyBinCount);
      var startedAt = performance.now();
      voice.silenceSince = startedAt;
      voice.spokeMs = 0;
      // Both seeded from the signal, never assumed. `floorRaw` chases the
      // quietest level seen, `peak` the loudest.
      var floorRaw = 255;
      var peak = 0;
      var last = startedAt;
      // How many frames the calibration window actually contributed. Zero means
      // it never ran, which is a different state from "the room measured zero".
      var calibFrames = 0;
      var calibSum = 0;

      function tick() {
        if (!voice.on) return;
        voice.analyser.getByteFrequencyData(buf);
        // The same data the endpointer reads, shown to the shopper.
        drawWave(buf, 2.2);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i];
        var level = sum / buf.length;
        var now = performance.now();
        var dt = now - last;
        last = now;

        /**
         * Measure the room before believing anything about the shopper.
         *
         * The floor used to be seeded by whatever arrived first, which on this
         * path is the shopper — everybody presses the mic and starts talking.
         * So the floor became the speaking level, the threshold then demanded
         * they exceed their own voice by half again, nothing registered as
         * speech, and nothing registered as the end of it: the recorder ran
         * until the hard timeout. The `peak * 0.5` clamp below was added to stop
         * that, and it is a backstop doing a measurement's job.
         *
         * Now there is an explicit window. It starts AFTER the opening chime,
         * which is an acoustic event of our own making and not the room; and
         * while it is open, loudness is measured but speech is not counted, so a
         * shopper who talks immediately cannot poison the reading. Their words
         * are still recorded — capture begins before this tick does — only the
         * "did anyone speak" accounting waits.
         */
        var sinceStart = now - startedAt;
        var calibrating = sinceStart < CALIBRATE_TO_MS;
        if (sinceStart >= CALIBRATE_FROM_MS && calibrating) {
          calibSum += level;
          calibFrames++;
          // The room, as measured, plus a little headroom for its own variance.
          floorRaw = calibSum / calibFrames;
        }

        // Fall to a new quiet level at once, climb back very slowly — so a gap
        // between words re-reads the room honestly while a passing truck does
        // not raise the floor for good.
        if (!calibrating) {
          if (level < floorRaw) floorRaw = level;
          else floorRaw += (level - floorRaw) * 0.002;
        }
        if (level > peak) peak = level;
        else peak *= 0.9997;
        // Published so the upload gate can tell "the room was quiet" from "the
        // meter is not working" — see the peak check in onCaptured.
        voice.peak = peak;

        // The floor stays CAPPED against the peak.
        //
        // With the calibration window above, this is no longer the only thing
        // standing between a talkative shopper and a mic that never stops. It is
        // kept because a real noise floor is never half the peak, so the clamp
        // still catches a reading poisoned some other way — a cough during
        // calibration, a door, someone else's voice.
        voice.floor = Math.min(floorRaw, peak * 0.5);

        // Whichever is higher: clear of the room, or a real fraction of how
        // loud this speaker actually is. The first handles a noisy shop, the
        // second a quiet room with a soft voice.
        var threshold = Math.max(6, voice.floor + 6, peak * 0.3);
        // Speech is not counted until the room has been measured. See above.
        var speaking = level > threshold && !calibrating;

        if (speaking) {
          voice.silenceSince = now;
          voice.spokeMs += dt;
          // Barge-in: talking over playback cancels audio AND the generation.
          if (voice.playing && voice.spokeMs > 160) {
            stopPlayback();
            host.abortInflight();
          }
        }

        // Whichever rung captured this turn. Null until startCapture has chosen
        // one, which is why the tick can safely start before capture exists.
        var recording = !!(voice.capture && voice.capture.active());
        // Varies with what has actually been said, where a transcript exists.
        var window_ = silenceWindowFor(voice.interim);
        var quietLongEnough =
          voice.spokeMs > MIN_SPEECH_MS && now - voice.silenceSince > window_;
        // UNCONDITIONAL. The previous version required speech to have been
        // detected before it would fire, which made it useless in exactly the
        // case it existed for: when speech detection is what failed, the
        // backstop was disabled too and the recorder never stopped at all.
        var tooLong = now - startedAt > MAX_UTTERANCE_MS;
        // Nothing heard at all — a muted or dead mic. Stop and start a fresh
        // capture rather than sitting in a listening state that cannot end.
        var heardNothing = voice.spokeMs === 0 && now - startedAt > IDLE_GIVE_UP_MS;

        var reading = {
          level: Math.round(level * 10) / 10,
          floor: Math.round(voice.floor * 10) / 10,
          peak: Math.round(peak * 10) / 10,
          threshold: Math.round(threshold * 10) / 10,
          spokeMs: Math.round(voice.spokeMs),
          elapsedMs: Math.round(now - startedAt),
          waitMs: window_,
          words: voice.interim ? voice.interim.split(/s+/).length : 0,
          // Frames the room measurement actually got. Zero here with a wrong
          // threshold means the window never ran, which is a different bug from
          // the window measuring the wrong thing.
          calib: calibFrames,
        };

        if (recording && (quietLongEnough || tooLong || heardNothing)) {
          reading.reason = quietLongEnough ? 'silence' : tooLong ? 'max-duration' : 'no-speech';
          voiceDiag('endpoint', reading);
          // `true`: the endpointer is the one caller that means "send it".
          voice.capture.stop(true);
          return;
        }

        // A heartbeat while still listening. The failure mode being chased is
        // one where the recorder NEVER stops — so a report sent only on stop is
        // never sent at all, which is exactly why the server saw nothing the
        // last two times. This makes "still listening, and here is why" visible.
        if (now - (voice.lastBeat || 0) > 3000) {
          voice.lastBeat = now;
          voiceDiag('listening', reading);
        }

        voice.raf = requestAnimationFrame(tick);
      }
      voice.raf = requestAnimationFrame(tick);
    }


    /**
     * Re-encode the recording as plain 16-bit PCM WAV before uploading.
     *
     * What MediaRecorder hands back is a container, and containers are where
     * this keeps going wrong: a codec parameter in the MIME type once had
     * every upload rejected outright, and a fragmented WebM with no duration
     * is a file a decoder may stop reading partway through. It does not
     * report that. It transcribes what it got and invents the rest, which is
     * how one English sentence came back as Urdu, then Turkish, then Latvian,
     * then Russian — different every time, which is the signature of a
     * decoder working from almost nothing.
     *
     * decodeAudioData uses the browser's own decoder on its own output, so
     * it reads the file correctly whatever the container. WAV then has no
     * opinions: a header, then samples, with the length written down. There
     * is nothing left to misparse.
     *
     * Falls back to the original blob if anything fails — a worse upload
     * beats no upload.
     */
    async function toWav(blob) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx || !blob.arrayBuffer) return blob;
        var ctx = voice.ctx && voice.ctx.state !== 'closed' ? voice.ctx : new Ctx();
        var audio = await ctx.decodeAudioData(await blob.arrayBuffer());
        // The number we have never been able to see. If this is a fraction of
        // what the endpointer measured, the container was the problem.
        voiceDiag('decoded', {
          seconds: Math.round(audio.duration * 100) / 100,
          rate: audio.sampleRate,
          spokeMs: Math.round(voice.spokeMs),
        });
        if (!audio.duration) return blob;

        var len = audio.length;
        var chans = audio.numberOfChannels;
        var mono = new Float32Array(len);
        for (var c = 0; c < chans; c++) {
          var src = audio.getChannelData(c);
          for (var i = 0; i < len; i++) mono[i] += src[i] / chans;
        }

        // Downsampled and written by the same two functions the PCM rungs use.
        // This path used to hand-roll its own header and upload at the
        // microphone's native rate, so the fallback paid three times the bytes
        // for audio no recogniser reads at that rate.
        return wavBlob(resampleTo(mono, audio.sampleRate, UPLOAD_RATE), UPLOAD_RATE);
      } catch (e) {
        voiceDiag('wav_failed', { error: String((e && e.message) || e) });
        return blob;
      }
    }

    async function transcribeAndSend(raw) {
      // The PCM rungs already produce a 16 kHz WAV. Only the MediaRecorder
      // fallback needs the decode-and-re-encode pass, which is most of what the
      // capture rework removed — running it on a WAV would decode our own file
      // and write it back out at the microphone's rate, undoing the saving.
      var blob = raw.type === 'audio/wav' ? raw : await toWav(raw);
      setVoiceState('thinking');
      var startedAt = performance.now();
      try {
        // ?shop= so the gateway can read THIS merchant's voice language. The
        // same pattern the widget bundle and rate limiter already use.
        var r = await fetch(API + '/api/voice/transcribe?shop=' + encodeURIComponent(SHOP || ''), {
          method: 'POST',
          // The shopper's own choice, falling back to the storefront locale
          // only if the picker never rendered.
          headers: {
            'content-type': blob.type || 'audio/webm',
            'x-storefront-lang': (els.lang && els.lang.value) || chosenLang() || pageLang(),
          },
          body: blob,
        });
        var d = await r.json();
        var text = (d && d.text ? d.text : '').trim();
        /**
         * What the shopper actually waited for.
         *
         * The eval harness measures the server: audio in, transcript out. It
         * cannot see the upload, and the upload is the part that changed — 16 kHz
         * instead of 48 kHz is three times fewer bytes, and on a phone the bytes
         * ARE the latency. This is the only number that includes it, which makes
         * it the one that says whether the change reached anybody.
         *
         * No transcript and no audio: a duration, a size, and a rate.
         */
        voiceDiag('transcript', {
          ms: Math.round(performance.now() - startedAt),
          bytes: blob.size,
          rate: blob.type === 'audio/wav' ? UPLOAD_RATE : null,
          heard: text !== '',
        });
        // Nothing heard. Ending the turn says so; restarting silently did not.
        if (!text) {
          /**
           * Say so. An empty transcript was the one failure with no visible
           * consequence — the turn simply ended, the panel went back to
           * Ready, and from the outside that is indistinguishable from the
           * assistant ignoring you. It is also the most common failure now
           * that fabricated foreign-language transcripts are rejected
           * server-side, so it is the message shoppers will see most.
           */
          voiceDiag('transcript_empty');
          if (els.live) els.live.textContent = "I didn't catch that — tap the mic and try again.";
          if (els.status) els.status.textContent = "Didn't catch that";
          endVoiceTurn();
          return;
        }
        els.live.textContent = text;
        addMsg('user', text);
        state.messages.push({ role: 'user', text: text });
        persist();
        stream(text, true);
      } catch (e) {
        voiceDiag('transcribe_error', { error: String((e && e.message) || e) });
        endVoiceTurn();
      }
    }

    /**
     * Close the voice turn: chime down, release the microphone, back to idle.
     *
     * Called from every path a turn can end on — spoken answer finished,
     * nothing transcribed, transcription failed, the turn errored. Each of
     * those used to restart capture instead, so a failure was indistinguishable
     * from success and the mic stayed open through both.
     */
    function endVoiceTurn() {
      if (!voice.on) return;
      cue('end');
      voiceDiag('turn_end');
      stopVoice(true);
      // Between turns, never during one: a language pack is tens of megabytes and
      // would compete with the upload the shopper is waiting on.
      maybeInstallOnDevice();
    }

    function enqueueSpeech(text, audioId) {
      voice.queue.push({ text: text, id: audioId });
      /**
       * `voice.playing` is the WRONG thing to gate on, and it sounded like two
       * people talking over each other.
       *
       * playNext awaits the speech request before it ever assigns
       * voice.playing, so for the whole round trip the queue looks idle. A
       * second sentence arriving in that window — and answers arrive in
       * sentence-sized chunks, so there always is one — started its own
       * playNext, and both assigned voice.playing and called play(). Two
       * voices, reading different sentences, at the same time.
       *
       * voice.busy is set synchronously below, so there is no window.
       */
      if (!voice.busy) playNext();
    }

    async function playNext() {
      // Synchronously, before any await. This is the whole fix.
      voice.busy = true;
      // `{text, id}` since the gateway started announcing an audio id alongside
      // each utterance — the id is what makes progressive playback possible.
      var utterance = voice.queue.shift();
      if (!utterance) {
        voice.playing = null;
        voice.busy = false;
        // ONE SHOT: press, speak, get answered, done — the way every mic a
        // shopper has used behaves.
        //
        // This used to hand the turn straight back and start listening again.
        // An always-open mic is a different product: it holds the microphone
        // indefinitely, records the room between questions, and gives no
        // moment where the shopper can tell whether it is still listening. It
        // also meant a failed turn looped silently, which is most of why voice
        // looked dead rather than broken.
        endVoiceTurn();
        return;
      }
      var gen = voice.gen;

      /**
       * Play straight off the response, without waiting for the end of it.
       *
       * This is the TTS fix. Pointing a media element at a URL hands the download
       * to the browser's own media stack, which starts decoding at the first
       * frames — measured, the first audio bytes exist 760 ms into a synthesis
       * that takes 1819 ms to finish, and `await r.blob()` here used to pay the
       * whole 1819 before making a sound. The server streams chunked WAV with no
       * content-length precisely so this works.
       *
       * Needs a GET, which is why the gateway announces an `audioId` on the
       * `speak` event rather than taking the text in the querystring: the reply
       * text would otherwise end up in proxy access logs.
       */
      if (utterance.id) {
        try {
          var streamed = await playFrom(
            API + '/api/voice/speak?id=' + encodeURIComponent(utterance.id) +
              '&shop=' + encodeURIComponent(SHOP || ''),
            gen,
          );
          if (streamed) return;
        } catch (e) {
          // Fall through and buffer it the old way. One slow sentence beats a
          // silent one, and a browser that cannot stream our WAV is still a
          // browser a shopper is standing in.
          voiceDiag('tts_stream_failed', { error: String((e && e.message) || e) });
        }
      }

      try {
        var r = await fetch(API + '/api/voice/speak?shop=' + encodeURIComponent(SHOP || ''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: utterance.text }),
        });
        if (!r.ok) throw new Error('tts');
        var url = URL.createObjectURL(await r.blob());
        /**
         * Was this answer retracted while we were fetching its audio?
         *
         * The grounding tripwire discards a partial answer and starts again,
         * and stopPlayback clears the queue — but it cannot reach a request
         * already in flight. That audio used to arrive afterwards and play,
         * so the assistant said the retracted sentence and then contradicted
         * itself with the corrected one.
         */
        if (gen !== voice.gen) {
          URL.revokeObjectURL(url);
          voice.busy = false;
          return;
        }
        var audio = new Audio(url);
        voice.playing = audio;
        setVoiceState('speaking');
        watchPlayback(audio);
        audio.onended = function () { URL.revokeObjectURL(url); playNext(); };
        audio.onerror = function () { URL.revokeObjectURL(url); playNext(); };
        await audio.play();
      } catch (e) {
        playNext(); // a failed utterance must not stall the queue
      }
    }

    /**
     * Start playback from a streaming URL. Resolves true once it is playing.
     *
     * Rejects if the element cannot play it at all, so the caller can fall back to
     * buffering. The distinction that matters is *before* playback versus during:
     * an error before the first frame is a format the browser refused and is worth
     * retrying another way, whereas one partway through is a truncated stream and
     * the queue should simply move on.
     */
    function playFrom(url, gen) {
      return new Promise(function (resolve, reject) {
        if (gen !== voice.gen) {
          voice.busy = false;
          resolve(true);
          return;
        }
        var audio = new Audio();
        audio.preload = 'auto';
        /**
         * Required, and not for the fetch — for the analyser.
         *
         * The waveform is driven by `createMediaElementSource`, and a media
         * element loaded cross-origin without this is *tainted*: Web Audio hands
         * back silence rather than an error, so the shopper sees the bar move and
         * hears nothing. The blob URLs this replaces were same-origin, which is
         * why it never came up before. The gateway already answers CORS for the
         * storefront origin on every route, so a failure here means the storefront
         * is not an allowed origin — and that falls back to the buffered path.
         */
        audio.crossOrigin = 'anonymous';
        audio.src = url;
        var started = false;

        audio.onerror = function () {
          if (started) {
            playNext();
            resolve(true);
          } else {
            reject(new Error('stream'));
          }
        };
        audio.onended = function () {
          playNext();
          resolve(true);
        };

        audio
          .play()
          .then(function () {
            // The retraction may have landed while the element was buffering.
            if (gen !== voice.gen) {
              audio.pause();
              voice.busy = false;
              resolve(true);
              return;
            }
            started = true;
            voice.playing = audio;
            setVoiceState('speaking');
            watchPlayback(audio);
            resolve(true);
          })
          .catch(function (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    }

    function stopPlayback() {
      if (voice.playing) {
        voice.playing.pause();
        voice.playing = null;
      }
      voice.queue.length = 0;
      voice.busy = false;
      // Invalidates any speech request still in flight, so a retracted
      // sentence cannot arrive late and be spoken after its correction.
      voice.gen++;
    }


    /**
     * Everything the host is allowed to do to a voice turn.
     *
     * Small on purpose. The host knows whether a turn is in progress and can
     * start, stop and feed one; it cannot reach the microphone, the endpointer,
     * the capture ladder or the playback queue, because every bug this path has
     * had came from those being reachable from somewhere else.
     */
    return {
      toggle: toggleVoice,
      stop: stopVoice,
      isOn: function () {
        return voice.on;
      },
      // Playing, or about to: a sentence waiting in the queue is still speech
      // the shopper has not heard yet, and ending the turn there cuts it off.
      isSpeaking: function () {
        return !!voice.playing || voice.queue.length > 0;
      },
      enqueueSpeech: enqueueSpeech,
      stopPlayback: stopPlayback,
      endTurn: endVoiceTurn,
    };
  };
})();
