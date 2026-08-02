/**
 * Input bar — device picker, level meter and instrument monitoring.
 *
 * The plugin buries the microphone picker in the setup grid, which assumes a
 * host that already had audio configured. On the open web the input IS the
 * first decision: a player with a guitar plugged into an interface has to pick
 * that interface, and until they do, nothing in the app can work. So the picker
 * is lifted into the page's top bar, a first-run panel explains the choice, and
 * a live meter answers the only question that matters — "is it hearing me?".
 *
 * The picker element itself is the plugin's own <select id="nt-mic">, moved
 * here rather than duplicated: screen.js keeps reading it exactly as before
 * (utils/ui.js resolves ids outside the mounted root too).
 *
 * The meter runs its own capture, and releases it the moment a session starts —
 * the game opens the device itself, and two readers of one interface is a good
 * way to get neither.
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'note_trainer_input_ok';
    const SILENCE_RMS = 0.004;      // below this, treat as room noise
    const HEARD_RMS = 0.02;         // sustained above this = the instrument is coming through
    const HEARD_MS = 250;

    const state = {
        stream: null, ctx: null, source: null, analyser: null, monitorGain: null,
        raf: null, buf: null, aboveSince: 0, heard: false, monitoring: false,
        starting: false, suspendedForGame: false,
    };

    let els = {};

    function stored(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }
    function store(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* private mode */ }
    }

    // The chosen device lives where the plugin already keeps it, so the two
    // never disagree: screen.js reads the <select> when a session starts, and
    // reloads the same value from here on the next visit.
    const MIC_KEY = 'slopsmith_note_trainer_settings';
    function storedDevice() {
        try { return (JSON.parse(stored(MIC_KEY) || '{}') || {}).deviceId || ''; }
        catch (_) { return ''; }
    }
    function storeDevice(deviceId) {
        let cfg = {};
        try { cfg = JSON.parse(stored(MIC_KEY) || '{}') || {}; } catch (_) { cfg = {}; }
        cfg.deviceId = deviceId;
        store(MIC_KEY, JSON.stringify(cfg));
    }

    const VOL_KEY = 'note_trainer_monitor_volume';
    function storedVolume() {
        const v = parseInt(stored(VOL_KEY) || '', 10);
        return Number.isFinite(v) ? Math.max(0, Math.min(150, v)) : 80;
    }
    function applyMonitorGain() {
        if (!state.monitorGain) return;
        const vol = els.volume ? Number(els.volume.value) : storedVolume();
        state.monitorGain.gain.value = state.monitoring ? vol / 100 : 0;
    }

    // ── UI ────────────────────────────────────────────────────────────
    function build() {
        const slot = document.getElementById('nt-input');
        const select = document.getElementById('nt-mic');
        if (!slot || !select) return false;

        // Take the plugin's own picker out of the setup grid, label and all.
        const field = select.closest('.nt-field');
        slot.appendChild(select);
        if (field) field.remove();
        select.classList.add('nt-input-select');
        select.setAttribute('aria-label', T('input.device'));

        const meter = document.createElement('div');
        meter.className = 'nt-meter';
        meter.title = T('input.meter_title');
        meter.innerHTML = '<i></i>';

        const status = document.createElement('span');
        status.className = 'nt-input-status';

        const volume = document.createElement('input');
        volume.type = 'range';
        volume.className = 'nt-input-volume';
        volume.min = '0'; volume.max = '150'; volume.step = '5';
        volume.value = String(storedVolume());
        volume.title = T('input.volume_title');
        volume.setAttribute('aria-label', T('input.volume_title'));

        const monitor = document.createElement('button');
        monitor.type = 'button';
        monitor.className = 'nt-input-monitor';
        monitor.setAttribute('aria-pressed', 'false');
        monitor.title = T('input.monitor_title');
        monitor.textContent = '🎧';

        slot.appendChild(meter);
        slot.appendChild(status);
        slot.appendChild(monitor);
        slot.appendChild(volume);

        els = { slot, select, meter, bar: meter.firstElementChild, status, monitor, volume };

        select.addEventListener('change', () => {
            storeDevice(select.value);
            restart();
        });
        monitor.addEventListener('click', toggleMonitor);
        volume.addEventListener('input', () => {
            store(VOL_KEY, volume.value);
            applyMonitorGain();
        });
        return true;
    }

    // setStatus and onboardingStep translate the key they are handed:
    // i18n-used: input.not_set, input.opening, input.listening, input.faint,
    // i18n-used: input.heard, input.in_game, input.denied, input.failed,
    // i18n-used: input.monitor_on, input.play_title, input.play_body,
    // i18n-used: input.heard_title, input.heard_body, input.denied_title, input.denied_body
    function setStatus(key, cls) {
        if (!els.status) return;
        els.status.textContent = key ? T(key) : '';
        els.status.className = 'nt-input-status' + (cls ? ' is-' + cls : '');
    }

    // ── First run ─────────────────────────────────────────────────────
    // Shown until the app has actually heard the instrument once. It is the one
    // piece of onboarding this app needs, so it is a panel, not a tooltip.
    function showOnboarding() {
        if (document.getElementById('nt-input-hint')) return;
        const box = document.createElement('div');
        box.className = 'nt-input-hint';
        box.id = 'nt-input-hint';
        box.innerHTML =
            '<div class="nt-ih-body">'
            + '<b>' + T('input.onboard_title') + '</b>'
            + '<p>' + T('input.onboard_body') + '</p>'
            + '</div>'
            + '<div class="nt-ih-actions">'
            + '<button type="button" class="nt-ih-go">' + T('input.enable') + '</button>'
            + '<button type="button" class="nt-ih-skip">' + T('input.later') + '</button>'
            + '</div>';
        const host = document.querySelector('.nt-topbar');
        if (host && host.parentNode) host.parentNode.insertBefore(box, host.nextSibling);
        // Push the screen down instead of covering it: the panel is an
        // instruction, not an interruption.
        document.body.classList.add('has-input-hint');
        box.querySelector('.nt-ih-go').addEventListener('click', () => {
            box.querySelector('.nt-ih-go').disabled = true;
            start(true);
        });
        box.querySelector('.nt-ih-skip').addEventListener('click', dismissOnboarding);
    }

    function onboardingStep(titleKey, bodyKey) {
        const box = document.getElementById('nt-input-hint');
        if (!box) return;
        box.querySelector('.nt-ih-body').innerHTML =
            '<b>' + T(titleKey) + '</b><p>' + T(bodyKey) + '</p>';
    }

    function dismissOnboarding() {
        const box = document.getElementById('nt-input-hint');
        if (box) box.remove();
        document.body.classList.remove('has-input-hint');
    }

    // ── Capture ───────────────────────────────────────────────────────
    async function start(fromOnboarding) {
        if (state.stream || state.starting) return;
        state.starting = true;
        setStatus('input.opening', '');
        try {
            const deviceId = els.select ? els.select.value : '';
            state.stream = await navigator.mediaDevices.getUserMedia({
                audio: deviceId
                    ? { deviceId: { exact: deviceId }, echoCancellation: false,
                        noiseSuppression: false, autoGainControl: false }
                    : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
        } catch (e) {
            state.starting = false;
            setStatus(e && e.name === 'NotAllowedError' ? 'input.denied' : 'input.failed', 'err');
            if (fromOnboarding) onboardingStep('input.denied_title', 'input.denied_body');
            const go = document.querySelector('.nt-ih-go');
            if (go) go.disabled = false;
            return;
        }
        state.starting = false;

        // With permission granted the device list finally has real names.
        await repopulateDevices();

        const Ctx = window.AudioContext || window.webkitAudioContext;
        state.ctx = new Ctx();
        if (state.ctx.state === 'suspended') { try { await state.ctx.resume(); } catch (_) {} }
        state.source = state.ctx.createMediaStreamSource(state.stream);
        state.analyser = state.ctx.createAnalyser();
        state.analyser.fftSize = 1024;
        state.analyser.smoothingTimeConstant = 0.2;
        state.source.connect(state.analyser);

        state.monitorGain = state.ctx.createGain();
        state.monitorGain.gain.value = 0;
        state.source.connect(state.monitorGain);
        state.monitorGain.connect(state.ctx.destination);
        applyMonitorGain();

        state.buf = new Float32Array(state.analyser.fftSize);
        state.heard = false;
        state.aboveSince = 0;
        setStatus('input.listening', '');
        if (fromOnboarding) onboardingStep('input.play_title', 'input.play_body');
        loop();
    }

    function stop() {
        if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
        if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
        if (state.ctx) { state.ctx.close().catch(() => {}); state.ctx = null; }
        state.source = state.analyser = state.monitorGain = null;
        if (els.bar) els.bar.style.width = '0%';
    }

    function restart() {
        const wasRunning = !!state.stream;
        stop();
        if (wasRunning) start(false);
    }

    async function repopulateDevices() {
        if (!els.select) return;
        const want = els.select.value || storedDevice();
        let devices = [];
        try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return; }
        const inputs = devices.filter((d) => d.kind === 'audioinput');
        els.select.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = T('mic.automatic');
        els.select.appendChild(auto);
        inputs.forEach((d, i) => {
            const o = document.createElement('option');
            o.value = d.deviceId;
            o.textContent = d.label || T('mic.numbered', { n: i + 1 });
            els.select.appendChild(o);
        });
        els.select.value = inputs.some((d) => d.deviceId === want) ? want : '';
    }

    // ── Meter ─────────────────────────────────────────────────────────
    // Decibel scale over a 60 dB window: a guitar's quiet passages sit far
    // below full scale, and a linear bar would look dead for most of what a
    // player actually does. Exported so it can be checked without a browser.
    function levelPercent(rms) {
        const db = 20 * Math.log10(rms || 1e-6);
        return Math.max(0, Math.min(100, (db + 60) * (100 / 60)));
    }

    function loop() {
        state.raf = requestAnimationFrame(loop);
        if (!state.analyser) return;
        state.analyser.getFloatTimeDomainData(state.buf);
        let sum = 0;
        for (let i = 0; i < state.buf.length; i++) sum += state.buf[i] * state.buf[i];
        const rms = Math.sqrt(sum / state.buf.length);

        const pct = levelPercent(rms);
        if (els.bar) els.bar.style.width = pct.toFixed(1) + '%';
        if (els.meter) els.meter.classList.toggle('is-hot', rms > HEARD_RMS);

        const now = performance.now();
        if (rms > HEARD_RMS) {
            if (!state.aboveSince) state.aboveSince = now;
            if (!state.heard && now - state.aboveSince > HEARD_MS) confirmHeard();
        } else {
            state.aboveSince = 0;
            if (!state.heard) setStatus(rms > SILENCE_RMS ? 'input.faint' : 'input.listening', '');
        }
    }

    function confirmHeard() {
        state.heard = true;
        store(STORAGE_KEY, '1');
        setStatus('input.heard', 'ok');
        const box = document.getElementById('nt-input-hint');
        if (box) {
            onboardingStep('input.heard_title', 'input.heard_body');
            box.classList.add('is-ok');
            setTimeout(dismissOnboarding, 2600);
        }
    }

    // ── Monitoring (hear the instrument through the app) ───────────────
    function toggleMonitor() {
        state.monitoring = !state.monitoring;
        applyMonitorGain();
        els.monitor.classList.toggle('is-on', state.monitoring);
        if (els.volume) els.volume.classList.toggle('is-on', state.monitoring);
        els.monitor.setAttribute('aria-pressed', String(state.monitoring));
        if (state.monitoring) {
            setStatus('input.monitor_on', 'ok');
            // Feedback only happens when speakers and mic share a room; an
            // instrument on a cable never howls, so this is offered as a fix
            // for a symptom, not stated as a fact.
            if (els.monitor) els.monitor.title = T('input.monitor_title');
            showHowlHint();
            if (!state.stream) start(false);
        } else if (state.stream) {
            setStatus(state.heard ? 'input.heard' : 'input.listening', state.heard ? 'ok' : '');
        }
    }

    // Shown once per visit when monitoring goes on. Feedback only happens when
    // speakers and a microphone share a room — an instrument on a cable never
    // howls — so this is offered as the cure for a symptom, not as a rule.
    let howlShown = false;
    function showHowlHint() {
        if (howlShown) return;
        howlShown = true;
        const tip = document.createElement('div');
        tip.className = 'nt-input-tip';
        tip.textContent = T('input.howl_hint');
        const host = document.querySelector('.nt-topbar');
        if (!host || !host.parentNode) return;
        host.parentNode.insertBefore(tip, host.nextSibling);
        const close = () => tip.remove();
        tip.addEventListener('click', close);
        setTimeout(close, 9000);
    }

    // ── While a session is running ─────────────────────────────────────
    // The game opens the device itself. If nobody is listening through the app
    // we let go of it — one reader is tidier. But if monitoring is on, playing
    // is exactly when the player needs to hear themselves, so the capture stays
    // up: browsers happily give the same input to two readers.
    function watchGame() {
        const root = document.getElementById('note-trainer-root');
        if (!root) return;
        const playing = () => root.classList.contains('is-playing')
            || root.classList.contains('is-ear')
            || root.classList.contains('is-rhythm');
        const sync = () => {
            if (playing()) {
                // Starting a session is a decision: the first-run panel has had
                // its say and should get out of the way.
                dismissOnboarding();
                if (state.monitoring) return;              // keep hearing yourself
                if (state.stream) { state.suspendedForGame = true; stop(); setStatus('input.in_game', ''); }
            } else if (state.suspendedForGame) {
                state.suspendedForGame = false;
                start(false);
            }
        };
        new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
    }

    function init() {
        if (!build()) return;
        watchGame();
        // Coming back with a device already chosen: start the meter straight
        // away, since permission is already granted and nothing needs asking.
        if (stored(STORAGE_KEY)) {
            repopulateDevices().then(() => start(false));
        } else {
            showOnboarding();
            setStatus('input.not_set', 'warn');
        }
    }

    window.noteTrainerInput = { init, stop, levelPercent };
})();
