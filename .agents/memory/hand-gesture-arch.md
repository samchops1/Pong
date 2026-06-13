---
name: HandGesture architecture
description: How the 4-finger island call gesture detection is built and integrated
---

# HandGesture module

**Rule:** The `HandGesture` module in `hands.js` is a separate IIFE that runs MediaPipe Hands at ~15fps via `setInterval(tick, 67)` on the same `game-video` element Vision uses. Do NOT fold it into vision.js — they share the video element but run independently.

**Why:** MediaPipe Pose (in vision.js) and MediaPipe Hands need separate detector instances. Running them concurrently on the same video is fine; they process frames independently.

**Palm-facing-camera detection:**
- Cross product of (wrist→indexMCP) × (wrist→pinkyMCP) in screen-space x/y
- MediaPipe Hands labels hands from camera's POV on raw (unmirrored) video
  - 'Left' label (user's right hand): palm toward camera → cross > 0
  - 'Right' label (user's left hand): palm toward camera → cross < 0
- If the app ever mirrors the video feed BEFORE sending to Hands, this logic inverts

**Trigger logic:**
- 20 consecutive frames detected → fire (requires ~1.3s hold)
- Decay 3x faster than build (gestureFrames -= 3 on non-detect)
- 3.5s cooldown after trigger

**Integration points:**
- HandGesture.start(video) called right after Vision.startTracking() in startGame()
- HandGesture.stop() called in recalibrate handler and at top of showWinScreen()
- Calls window.onIslandGesture() — top-level function in app.js (auto-global in vanilla JS)

**Guards in onIslandGesture():**
- No chandeliers, no rebuttal
- Shooter hasn't used their island call (islandCallsUsed[shooter])
- Opponent rack must have a lone cup (hasLoneCup + findLoneCupId)
