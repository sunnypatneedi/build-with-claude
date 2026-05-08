// Step progression + tactile feedback.
//
// Each step of the install flow ends with a "next" button (or in the
// case of steps 3/4, an action that auto-completes on success). When
// a step finishes:
//   1. The button morphs into a ✓ pill
//   2. A short Web-Audio chirp plays (same C-major-ish ascending
//      arpeggio Claudachi uses for its "play" cue on the device, so
//      the page sounds like a sibling of the pet)
//   3. The step itself gets the .completed class (green check, soft
//      gradient)
//   4. The page smooth-scrolls to the next step
//   5. The next step gets .current and pulses to draw attention
//   6. The progress bar advances, animated with a spring curve
//
// Auto-complete hooks:
//   - Step 3 listens for esp-web-tools' state-changed event with
//     state==='finished'
//   - Step 4 listens for our own claudachi:step-complete event,
//     dispatched from flasher.js when the apps push wraps up
//   - Step 5 only completes when the user clicks the celebrate
//     button (no auto path; the user has to actually use Claudachi)

(function () {
  "use strict";

  const TOTAL_STEPS = 5;
  let audioCtx = null;

  // Tiny ascending arpeggio for the completion ding. Frequencies
  // mirror claudachi.py's _CUE_PLAY (C-E-G ish at audible levels).
  function chirp() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const t0 = audioCtx.currentTime;
      const notes = [
        { freq: 523, t: 0,    dur: 0.08 },
        { freq: 659, t: 0.08, dur: 0.08 },
        { freq: 988, t: 0.16, dur: 0.16 },
      ];
      for (const n of notes) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(n.freq, t0 + n.t);
        // Soft envelope so notes don't click.
        g.gain.setValueAtTime(0.0001, t0 + n.t);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + n.t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.dur);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + n.t);
        o.stop(t0 + n.t + n.dur + 0.02);
      }
    } catch (e) {
      // No audio is fine — the visual feedback still lands.
    }
  }

  function celebrateBurst() {
    // Confetti rain from above, in the brand palette.
    const colors = ["#cc785c", "#f0eee6", "#e8a0a0", "#9ccc9a", "#e8b05c"];
    const burst = document.createElement("div");
    burst.className = "celebrate-burst";
    document.body.appendChild(burst);
    const N = 60;
    for (let i = 0; i < N; i++) {
      const c = document.createElement("div");
      c.className = "confetti";
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 0.3 + "s";
      c.style.animationDuration = 1.6 + Math.random() * 1.2 + "s";
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      burst.appendChild(c);
    }
    setTimeout(() => burst.remove(), 3500);
  }

  function updateProgress() {
    const done = document.querySelectorAll(".step.completed").length;
    const fill = document.getElementById("progress-fill");
    const count = document.getElementById("progress-count");
    if (fill) fill.style.width = (done / TOTAL_STEPS) * 100 + "%";
    if (count) count.textContent = done;
  }

  function markCurrent(stepEl) {
    document.querySelectorAll(".step.current").forEach((s) =>
      s.classList.remove("current")
    );
    if (stepEl) {
      stepEl.classList.add("current");
      // Strip the .current class after the pulse so it can re-fire if
      // the user comes back to this step later.
      setTimeout(() => stepEl.classList.remove("current"), 1500);
    }
  }

  function completeStep(stepId, opts = {}) {
    const step = document.querySelector(`.step[data-step="${stepId}"]`);
    if (!step || step.classList.contains("completed")) return;

    step.classList.add("completed");
    chirp();
    updateProgress();

    const nextId = opts.nextId;
    if (nextId) {
      const next = document.getElementById(nextId);
      if (next) {
        // Wait a beat so the ✓ animation is visible before we scroll.
        setTimeout(() => {
          next.scrollIntoView({ behavior: "smooth", block: "start" });
          markCurrent(next);
        }, 450);
      }
    }
  }

  function wireNextButtons() {
    document.querySelectorAll(".next-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("completing")) return;
        btn.classList.add("completing");

        const stepId = btn.dataset.step;
        const nextId = btn.dataset.next;
        const celebrate = btn.dataset.celebrate === "true";

        // Run the button morph animation, THEN mark the step
        // complete + advance. The 0.55s matches the keyframe.
        setTimeout(() => {
          completeStep(stepId, { nextId });
          if (celebrate) celebrateBurst();
        }, 450);
      });
    });
  }

  function wireEspWebTools() {
    const installBtn = document.querySelector("esp-web-install-button");
    if (!installBtn) return;
    // ESP Web Tools fires state-changed with detail = { state: ... }.
    // We watch for 'finished' to auto-complete step 3.
    installBtn.addEventListener("state-changed", (e) => {
      const state = e.detail && e.detail.state;
      if (state === "finished") {
        completeStep("step-3", { nextId: "step-4" });
      }
    });
  }

  function wireFlasherHook() {
    // flasher.js dispatches this after a successful apps push.
    document.addEventListener("claudachi:step-complete", (e) => {
      const stepId = e.detail && e.detail.step;
      const nextId = e.detail && e.detail.nextId;
      if (stepId) completeStep(stepId, { nextId });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireNextButtons();
    wireEspWebTools();
    wireFlasherHook();
    updateProgress();
  });
})();
