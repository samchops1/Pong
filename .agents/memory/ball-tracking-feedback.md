---
name: Ball tracking & on-screen feedback (Pong Ref)
description: Why trajectory/speed may look absent, and how live feedback + throw thresholds work
---

# Ball tracking feedback

Ball position is found purely by **HSV color matching** (sampled by tapping the ball on the calibration screen). It is fragile: a small, fast, motion-blurred ball is easily missed, especially low-saturation (white) balls.

**If a user says "I don't see trajectory / speed":** the usual root cause is the color detector not picking up the ball, NOT the rendering. The game overlay now shows an on-canvas status badge ("Tracking ball" vs "No ball — re-sample color") so the user can tell which. If it says "No ball", they need to re-sample the ball color / loosen HSV tolerances.

**Rendering model (in `drawOverlays`):**
- A live glowing marker draws only while a detection is fresh (recent ms window).
- A continuous fading trail draws from the rolling `ballPositions` buffer when NOT in an active throw; segments with large time gaps or old age are skipped so no stale long lines appear.
- The parabola arc still renders during/after a registered throw from `throwBuffer`/`lastArcPoints`.

**Throw state machine is intentionally gap-tolerant:** start requires only `THROW_MIN_FRAMES-1` of the last frames moving (tolerates one dropped frame); mid-flight end waits several missing frames (not ~2) before ending. Make detection is unaffected because it still waits `DISAPPEAR_FOR_MAKE` missing frames on `postThrowBuffer` after the throw ends.

**Speed:** shown for EVERY throw (overlay), with a "PB" badge + commentary only on a new team record. Per-team fastest lives in the side panels.

**Why:** continuous feedback was missing — overlays only appeared after a fully-detected throw, so the view looked dead even when the camera worked.
