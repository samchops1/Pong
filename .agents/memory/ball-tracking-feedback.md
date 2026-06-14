---
name: Ball tracking, color matching & on-screen feedback (Pong Ref)
description: How HSV ball detection works, why it over-matches, and how live feedback + throw thresholds behave
---

# Ball tracking & color matching

Ball position is found purely by **HSV color matching** of a sampled ball color. It is fragile and was the #1 source of "nothing works" reports.

## Saturation matching is a one-sided FLOOR, not a band
The original matcher used a symmetric band `|s - sampledSat| <= satTol` with a large default — this matched washed-out warm walls/table/skin whenever a saturated ball was sampled, painting almost the whole frame green. Correct model:
- **Colored ball** (sampledSat >= ~22): require hue within tol AND `s >= max(25, sampledSat - satTol)` (a floor). This rejects desaturated background that merely shares the ball's hue.
- **White/pale ball** (sampledSat < ~22): hue is meaningless, so match low saturation + brightness only. A white ball on a white table/wall is **inherently** unseparable by color — steer users to an **orange** ball.
**Why:** desaturated surfaces share hue with the ball; only saturation separates them.

## Sampling must bias toward saturated pixels
`sampleBallColor` medians a small patch. A naive median of a patch around a *small* ball on a bright table samples the background → low saturation → drops into pale mode → everything green. Fix: collect patch pixels, and if a decent fraction are colored (s>=35), take the median of ONLY those; else fall back to the overall median (and warn).

## One matcher, one source of truth
The calibration green-mask preview MUST call the exact same matcher as the live tracker (`Vision.matchesBall`). A second hand-rolled copy will drift and lie about what the game detects.

## Diagnosing in the field
The in-game overlay shows a status badge ("Tracking ball" vs "No ball — re-sample color"). If a user says trajectory/speed/makes don't work, the usual cause is the color detector, not the rendering or the make-detection logic. Make detection (`checkCupMake`) only fires when real ball positions land near a cup before disappearing, so bad tracking silently disables it.

## Rendering & throw state machine
- Live glowing marker draws only while a detection is fresh; a fading trail draws from `ballPositions` when not in an active throw (stale/old segments skipped).
- Throw start tolerates one dropped frame; mid-flight end waits several missing frames. Make detection is unaffected (still waits `DISAPPEAR_FOR_MAKE` missing frames after the throw ends).
- Speed shows for EVERY throw (overlay); "PB" badge + commentary only on a new team record; per-team fastest lives in the side panels.
