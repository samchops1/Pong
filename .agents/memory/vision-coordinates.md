---
name: Vision coordinate system (Pong Ref)
description: How table calibration corners map to cup layout u/v, and the side-across camera assumption
---

# Pong Ref vision geometry

**The CV assumes a SIDE-ACROSS camera** (camera on the long edge of the table looking across), NOT a top-down / down-the-table view.

**Calibration corners** (`calCorners`, array order is load-bearing):
- corners[0] = front-left  (near long edge, left end)  → world (u=0, v=0)
- corners[1] = front-right (near long edge, right end) → world (u=1, v=0)
- corners[2] = back-left   (far long edge, left end)   → world (u=0, v=1)
- corners[3] = back-right  (far long edge, right end)  → world (u=1, v=1)

`worldToCanvas(u,v,corners)` is a bilinear map of the unit square onto that quad.

**Axis semantics in side-across view:**
- u axis = table LENGTH (tableFt, ~8ft), runs left↔right along the front/back long edges.
- v axis = table WIDTH/DEPTH (~2ft, short), runs front↔back along the left/right end edges.
- Team A rack clusters at the LEFT end (low u ~0.06–0.16); Team B at the RIGHT (high u ~0.84–0.94). Both centered in v.

**Why this matters (dimensions swap vs a top-down view):**
- `pixPerFt` (for ball MPH) must divide the FRONT/BACK long edges by tableFt — those edges are the length. (A top-down build would divide the left/right edges instead.)
- Cup radius is estimated from the SHORT edges (left/right end edges = v extent), not the long edges.
- If you ever change `CUP_LAYOUTS`, keep cup `id`s stable — the on-screen rack schematic in app.js highlights by id and does NOT need to match CV spatial positions, only id consistency.

**How to apply:** Any change to cup placement, foul-line geometry, or speed calc must respect that length=u (long edges) and width=v (short edges). Don't reintroduce near/far depth-split racks — that's the old top-down model the user does not use.

## Foul lines (side-across)

Each team's foul line is their OWN END of the table, selected by `gs.shootingTeam`:
- Team A → left end (front-left→back-left), Team B → right end (front-right→back-right).

**Why:** Players stand at the short ends and throw across; a single fixed front-edge foul line is meaningless here.

**How to apply:** `foulSideDist()` normalizes the signed line distance using the table CENTER (`worldToCanvas(0.5,0.5)`) as the "inside" reference, so a positive result always means the elbow reached over onto the table regardless of corner winding. Never hardcode the sign — derive it from the center, or false fouls flip per orientation.
