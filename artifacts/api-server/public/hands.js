/* ─────────────────────── HAND GESTURE DETECTION ─────────────────────── */
/*  Detects "4 fingers up, palm facing camera" to trigger island call.
 *  Uses MediaPipe Hands (CDN) on the same game-video element.
 *  Requires a ~1 second sustained hold to avoid false positives
 *  (a throw motion completes in <0.5 s and palm faces away from camera).
 */

window.HandGesture = (() => {
  let hands        = null;
  let video        = null;
  let running      = false;
  let intervalId   = null;
  let gestureFrames = 0;
  let lastTriggerAt = 0;

  const HOLD_FRAMES  = 20;    // consecutive detections needed (~1.3 s at 15 fps)
  const MARGIN       = 0.04;  // min y-gap (normalized) for "finger extended"
  const COOLDOWN_MS  = 3500;  // prevent re-trigger for 3.5 s after a call

  /* ── Finger state checks ── */

  function fourFingersUp(lm) {
    // Index (8,6), middle (12,10), ring (16,14), pinky (20,18)
    // Tip y must be meaningfully ABOVE (smaller y) its PIP joint
    return [[8,6],[12,10],[16,14],[20,18]]
      .every(([tip, pip]) => lm[tip].y < lm[pip].y - MARGIN);
  }

  function thumbNotFisted(lm) {
    // Thumb tip (4) above its IP joint (3) — not curled inward around a ball
    return lm[4].y < lm[3].y;
  }

  /* ── Palm orientation via cross product ── */
  // Vectors: wrist(0) → index MCP(5), wrist(0) → pinky MCP(17)
  // Cross-product z-component sign tells us which face of the hand is toward camera.
  // MediaPipe Hands "Left" label = user's right hand in raw (unmirrored) video.
  //   palm toward camera → cross > 0
  // MediaPipe Hands "Right" label = user's left hand (unmirrored).
  //   palm toward camera → cross < 0
  // When video is CSS-mirrored for display the labels swap, but the raw frame
  // sent to Hands is always unmirrored, so this logic is stable.
  function palmFacingCamera(lm, handedness) {
    const v1x = lm[5].x  - lm[0].x,  v1y = lm[5].y  - lm[0].y;
    const v2x = lm[17].x - lm[0].x,  v2y = lm[17].y - lm[0].y;
    const cross = v1x * v2y - v1y * v2x;
    return handedness === 'Left' ? cross > 0 : cross < 0;
  }

  /* ── Position guard: hand must be raised, not at table level ── */
  function handRaisedClearly(lm) {
    return lm[0].y < 0.72; // wrist in upper 72 % of frame
  }

  /* ── Results callback ── */
  function onResults(results) {
    if (!running) return;

    const lms  = results.multiHandLandmarks || [];
    const hnds = results.multiHandedness    || [];
    let detected = false;

    for (let i = 0; i < lms.length; i++) {
      const lm   = lms[i];
      const side = hnds[i]?.label || 'Right';
      if (
        fourFingersUp(lm)        &&
        thumbNotFisted(lm)       &&
        palmFacingCamera(lm, side) &&
        handRaisedClearly(lm)
      ) {
        detected = true;
        break;
      }
    }

    if (detected) {
      gestureFrames++;
      if (gestureFrames === HOLD_FRAMES) {
        const now = Date.now();
        if (now - lastTriggerAt > COOLDOWN_MS) {
          lastTriggerAt = now;
          // Call the app-level handler (defined in app.js as a global function)
          if (typeof window.onIslandGesture === 'function') window.onIslandGesture();
        }
        gestureFrames = 0; // reset — requires another full hold to re-trigger
      }
    } else {
      // Decay 3× faster than build — stray frames don't reset a near-complete hold
      gestureFrames = Math.max(0, gestureFrames - 3);
    }
  }

  /* ── MediaPipe Hands init ── */
  function initHands() {
    if (hands) return Promise.resolve(true);
    if (typeof Hands === 'undefined') {
      console.warn('[HandGesture] MediaPipe Hands not loaded — island gesture disabled');
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      try {
        hands = new Hands({
          locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
        });
        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 0,             // Lite model — lowest latency
          minDetectionConfidence: 0.65,
          minTrackingConfidence: 0.55
        });
        hands.onResults(onResults);
        resolve(true);
      } catch(e) {
        console.warn('[HandGesture] Init error:', e);
        hands = null;
        resolve(false);
      }
    });
  }

  /* ── Per-tick: send a frame to Hands at ~15 fps ── */
  async function tick() {
    if (!running || !hands || !video) return;
    if ((video.readyState || 0) < 2) return; // video not ready yet
    try { await hands.send({ image: video }); }
    catch(e) { /* suppress transient errors silently */ }
  }

  /* ── Public API ── */
  return {
    async start(videoEl) {
      video = videoEl;
      running = true;
      gestureFrames = 0;
      const ok = await initHands();
      if (!ok) return;
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(tick, 67); // ~15 fps
      console.log('[HandGesture] Active — hold 4 fingers toward camera to call island');
    },

    stop() {
      running = false;
      gestureFrames = 0;
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    }
  };
})();
