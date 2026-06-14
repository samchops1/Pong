/* vision.js — Computer Vision Engine for Pong Ref
   Exposes window.Vision */
(function () {
'use strict';

/* ── Cup layouts in normalized table coordinates ──
   Side-across camera view: the table LENGTH runs left↔right.
   u=0 left end (Team A), u=1 right end (Team B);
   v=0 front long edge (near camera), v=1 back long edge.
   Each rack is a triangle clustered at its own end: the wide base sits on
   the end line, and the apex points toward the center of the table.
   Rows step ~0.035 in u (toward center); cups step ~0.155 in v (across width). */
const CUP_LAYOUTS = {
  10: {
    teamA: [
      {id:1,u:0.060,v:0.270},{id:2,u:0.060,v:0.423},{id:3,u:0.060,v:0.577},{id:4,u:0.060,v:0.730},
      {id:5,u:0.095,v:0.345},{id:6,u:0.095,v:0.500},{id:7,u:0.095,v:0.655},
      {id:8,u:0.130,v:0.423},{id:9,u:0.130,v:0.577},
      {id:10,u:0.165,v:0.500}
    ],
    teamB: [
      {id:1,u:0.940,v:0.270},{id:2,u:0.940,v:0.423},{id:3,u:0.940,v:0.577},{id:4,u:0.940,v:0.730},
      {id:5,u:0.905,v:0.345},{id:6,u:0.905,v:0.500},{id:7,u:0.905,v:0.655},
      {id:8,u:0.870,v:0.423},{id:9,u:0.870,v:0.577},
      {id:10,u:0.835,v:0.500}
    ]
  },
  6: {
    teamA: [
      {id:1,u:0.060,v:0.345},{id:2,u:0.060,v:0.500},{id:3,u:0.060,v:0.655},
      {id:4,u:0.095,v:0.423},{id:5,u:0.095,v:0.577},
      {id:6,u:0.130,v:0.500}
    ],
    teamB: [
      {id:1,u:0.940,v:0.345},{id:2,u:0.940,v:0.500},{id:3,u:0.940,v:0.655},
      {id:4,u:0.905,v:0.423},{id:5,u:0.905,v:0.577},
      {id:6,u:0.870,v:0.500}
    ]
  }
};

/* State */
let video, canvas, ctx;
let calibration = null;
let ballHSV = null;
let cupLayout = null;
// Manual fine-tune of the projected cup template (corrects camera perspective).
let cupAdjust = { teamA: {dx:0, dy:0}, teamB: {dx:0, dy:0}, scale: 1, radiusMul: 1 };
let ballPositions = [];   // rolling 30-frame buffer
let throwBuffer = [];     // positions during active throw
let throwActive = false;
let postThrowBuffer = null;  // {positions, disappearFrames} for cup detection
let ballDisappearFrames = 0;
let lastBallSeenAt = 0;    // ms timestamp of most recent ball detection
let lastBallPos = null;    // {x,y} of most recent ball detection
let lastArcPoints = [];
let arcFade = 0.4;
let poseDetector = null;
let poseLandmarks = null;
let poseConfidence = 0;
let lastPoseTime = 0;
let lastFoulTime = -Infinity;
let foulFlashUntil = 0;
let trackingActive = false;
let animId = null;
let throwCbs = {};
let getGameState = null;
let lastSpeed = 0;
let frameCount = 0;
let cvCanvas = null, cvCtx = null, cvScale = 1;  // downscaled offscreen buffer for CV
let poseInFlight = false;
let maskPreviewActive = false;
let maskPreviewCanvas = null;
let maskPreviewCtx = null;

let hsvTol = { hue: 16, sat: 40, valFloor: 70 };

const BALL_MIN_PX = 4;
const BALL_MAX_PX = 500;
const THROW_MIN_FRAMES = 3;
const POSE_INTERVAL_MS = 150;
const CV_MAX_WIDTH = 640;   // ball detection runs on a buffer no wider than this
const DISAPPEAR_FOR_MAKE = 8;
const FOUL_DEBOUNCE_MS = 3000;
const FOUL_GRACE_PX = 12;

/* ── Math helpers ── */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = max === 0 ? 0 : d / max;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, v: max * 100 };
}

function matchesBall(r, g, b) {
  if (!ballHSV) return false;
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < hsvTol.valFloor) return false;
  // White / very light ball: hue is unreliable at low saturation, so match on
  // low saturation + brightness only. (A white ball on a white table/wall is
  // inherently hard to isolate — a colored ball tracks far better.)
  if (ballHSV.sat < 22) {
    return s <= ballHSV.sat + hsvTol.sat;
  }
  // Colored ball: hue must be close AND the pixel must be at least roughly as
  // saturated as the sample (one-sided floor). This rejects washed-out walls,
  // table, and skin that happen to share the ball's hue but are desaturated.
  const dh = Math.min(Math.abs(h - ballHSV.hue), 360 - Math.abs(h - ballHSV.hue));
  if (dh > hsvTol.hue) return false;
  // Clamp the floor with a small absolute minimum so a weakly-colored sample
  // can't admit broad swaths of desaturated background.
  return s >= Math.max(25, ballHSV.sat - hsvTol.sat);
}

/* Bilinear interpolation: world [u,v] → canvas [x,y] */
function worldToCanvas(u, v, corners) {
  // corners: [front-left, front-right, back-left, back-right] (side-across view)
  // u: 0 = left end (Team A) → 1 = right end (Team B); v: 0 = front edge → 1 = back edge
  const c = corners;
  return {
    x: (1-u)*(1-v)*c[0].x + u*(1-v)*c[1].x + (1-u)*v*c[2].x + u*v*c[3].x,
    y: (1-u)*(1-v)*c[0].y + u*(1-v)*c[1].y + (1-u)*v*c[2].y + u*v*c[3].y
  };
}

function polyBounds(poly) {
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/* Connected-component blob detection on 1-bit mask */
function findLargestBlob(mask, w, h) {
  const vis = new Uint8Array(w * h);
  let best = null;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || vis[i]) continue;
    const queue = [i]; vis[i] = 1;
    let head = 0, sx = 0, sy = 0, cnt = 0, touchesEdge = false;
    while (head < queue.length && cnt < BALL_MAX_PX * 2) {
      const idx = queue[head++];
      const bx = idx % w, by = (idx / w) | 0;
      sx += bx; sy += by; cnt++;
      if (bx === 0 || bx === w-1 || by === 0 || by === h-1) touchesEdge = true;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = bx+dx, ny = by+dy;
        if (nx<0||ny<0||nx>=w||ny>=h) continue;
        const ni = ny*w+nx;
        if (mask[ni] && !vis[ni]) { vis[ni]=1; queue.push(ni); }
      }
    }
    if (touchesEdge) continue;
    if (cnt >= BALL_MIN_PX && cnt <= BALL_MAX_PX && (!best || cnt > best.cnt)) {
      best = { cx: sx/cnt, cy: sy/cnt, cnt };
    }
  }
  return best;
}

/* Lazily (re)size the offscreen CV buffer to a downscaled copy of the display
   canvas. Ball detection runs here so a fast ball is found cheaply enough to
   process EVERY frame. cvScale = cvWidth / displayWidth (<= 1). */
function ensureCvCanvas() {
  const fullW = canvas.width || 640, fullH = canvas.height || 480;
  const scale = Math.min(1, CV_MAX_WIDTH / fullW);
  const cw = Math.max(1, Math.round(fullW * scale));
  const ch = Math.max(1, Math.round(fullH * scale));
  if (!cvCanvas) {
    cvCanvas = document.createElement('canvas');
    cvCtx = cvCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (cvCanvas.width !== cw || cvCanvas.height !== ch) {
    cvCanvas.width = cw; cvCanvas.height = ch;
  }
  cvScale = cw / fullW;
}

/* Find the ball blob inside an ROI ImageData (full-resolution per-pixel scan,
   STEP=1 — the buffer is already downscaled). Returns center in ROI-local
   coordinates, or null. */
function findBallInRoi(imageData) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const pi = i * 4;
    mask[i] = matchesBall(data[pi], data[pi+1], data[pi+2]) ? 1 : 0;
  }
  const blob = findLargestBlob(mask, width, height);
  if (!blob) return null;
  return { x: blob.cx, y: blob.cy, cnt: blob.cnt };
}

/* Least-squares parabola fit: y = a*x^2 + b*x + c */
function fitParabola(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let sx=0, sx2=0, sx3=0, sx4=0, sy=0, sxy=0, sx2y=0;
  for (const {x,y} of pts) {
    sx+=x; sx2+=x*x; sx3+=x*x*x; sx4+=x*x*x*x;
    sy+=y; sxy+=x*y; sx2y+=x*x*y;
  }
  const m = [[n,sx,sx2],[sx,sx2,sx3],[sx2,sx3,sx4]];
  const r = [sy,sxy,sx2y];
  for (let c=0; c<3; c++) {
    let maxR=c;
    for (let row=c+1; row<3; row++) if (Math.abs(m[row][c])>Math.abs(m[maxR][c])) maxR=row;
    [m[c],m[maxR]]=[m[maxR],m[c]]; [r[c],r[maxR]]=[r[maxR],r[c]];
    if (Math.abs(m[c][c])<1e-9) return null;
    for (let row=c+1; row<3; row++) {
      const f=m[row][c]/m[c][c];
      for (let j=c;j<3;j++) m[row][j]-=f*m[c][j];
      r[row]-=f*r[c];
    }
  }
  if (Math.abs(m[2][2])<1e-9) return null;
  const a=r[2]/m[2][2];
  const b=(r[1]-m[1][2]*a)/m[1][1];
  const c2=(r[0]-m[0][1]*b-m[0][2]*a)/m[0][0];
  return {a,b,c:c2};
}

function arcFromParabola(parab, pts, steps=60) {
  if (!pts.length || !parab) return [];
  const xs = pts.map(p=>p.x);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const {a,b,c} = parab;
  const out = [];
  for (let i=0;i<=steps;i++) {
    const x = minX+(maxX-minX)*i/steps;
    out.push({x, y: a*x*x+b*x+c});
  }
  return out;
}

/* Line-side test for foul detection */
function signedLineDist(px, py, p1, p2) {
  return (p2.x-p1.x)*(py-p1.y)-(p2.y-p1.y)*(px-p1.x);
}

/* Active foul line = the shooting team's END of the table (side-across view).
   Team A shoots from the LEFT end, Team B from the RIGHT end. */
function activeFoulLine(shootingTeam) {
  if (!calibration) return null;
  return shootingTeam === 'B' ? calibration.foulLineB : calibration.foulLineA;
}

/* Signed distance from a point to a foul line, normalized so POSITIVE means the
   point is on the table (center) side of that end line — i.e. the elbow reached
   over. Using the table center as reference makes the sign robust regardless of
   corner ordering. */
function foulSideDist(ex, ey, line) {
  const raw = signedLineDist(ex, ey, line.p1, line.p2);
  const ins = signedLineDist(calibration.center.x, calibration.center.y, line.p1, line.p2);
  return ins >= 0 ? raw : -raw;
}

/* ── Cup Position Computation ── */
function computeCupPixelPositions(corners, count, side) {
  const layout = CUP_LAYOUTS[count];
  if (!layout) return [];
  const worldCups = layout[side];
  // Estimate cup radius from the table's SHORT (depth) dimension —
  // the left/right end edges in the side-across view (v axis extent).
  const leftLen  = Math.hypot(corners[2].x-corners[0].x, corners[2].y-corners[0].y);
  const rightLen = Math.hypot(corners[3].x-corners[1].x, corners[3].y-corners[1].y);
  const avgW = (leftLen+rightLen)/2;
  const r = Math.max(8, Math.min(60, avgW * 0.08 * (cupAdjust.radiusMul || 1)));

  // Project the template, then apply the user's manual fine-tune: scale the rack
  // about its own centroid (spread) and shift it (drag), per team. This corrects
  // for camera perspective the flat bilinear projection cannot capture.
  const adj = cupAdjust[side] || { dx: 0, dy: 0 };
  const sc = cupAdjust.scale || 1;
  const proj = worldCups.map(cup => {
    const px = worldToCanvas(cup.u, cup.v, corners);
    return { id: cup.id, x: px.x, y: px.y };
  });
  let cx = 0, cy = 0;
  for (const p of proj) { cx += p.x; cy += p.y; }
  cx /= proj.length || 1; cy /= proj.length || 1;
  return proj.map(p => ({
    id: p.id,
    x: cx + (p.x - cx) * sc + adj.dx,
    y: cy + (p.y - cy) * sc + adj.dy,
    r
  }));
}

/* ── Auto Cup Detection ── */
function checkCupMake(positions, disappearFrames, shootingTeam, activeCupIds) {
  if (!cupLayout || !calibration) return null;
  if (positions.length < 2) return null;
  if (disappearFrames < DISAPPEAR_FOR_MAKE) return null;

  const defending = shootingTeam === 'A' ? 'teamB' : 'teamA';
  const defendCups = cupLayout[defending];
  if (!defendCups || !defendCups.length) return null;

  // Prefer the last REAL detection (skip extrapolated occlusion-bridge points)
  // when choosing which cup the ball landed in.
  let last = null;
  for (let i = positions.length - 1; i >= 0; i--) {
    if (!positions[i].predicted) { last = positions[i]; break; }
  }
  if (!last) last = positions[positions.length - 1];

  // Velocity drop: compare last 2 vs earlier 2 frames
  let earlySpeed = 0, lateSpeed = 0;
  if (positions.length >= 4) {
    const n = positions.length;
    const dt1 = (positions[n-2].t - positions[n-3].t) || 16;
    const dt2 = (positions[n-1].t - positions[n-2].t) || 16;
    earlySpeed = Math.hypot(positions[n-2].x-positions[n-3].x, positions[n-2].y-positions[n-3].y)/dt1;
    lateSpeed  = Math.hypot(positions[n-1].x-positions[n-2].x, positions[n-1].y-positions[n-2].y)/dt2;
  }
  const velDrop = earlySpeed > 0.05 && lateSpeed < earlySpeed * 0.45;

  // Find nearest active cup to last ball position
  let bestCup = null, bestDist = Infinity;
  for (const cup of defendCups) {
    if (activeCupIds && !activeCupIds.has(cup.id)) continue;
    const d = Math.hypot(last.x-cup.x, last.y-cup.y);
    if (d < bestDist) { bestDist = d; bestCup = cup; }
  }
  if (!bestCup) return null;

  const inRadius = bestDist <= bestCup.r * 2.0;
  const score = [inRadius, velDrop, disappearFrames >= DISAPPEAR_FOR_MAKE].filter(Boolean).length;

  if (score >= 3) return { cup: bestCup, confidence: 'high', team: defending };
  if (score >= 2 && inRadius) return { cup: bestCup, confidence: 'low', team: defending };
  return null;
}

/* ── Throw Tracking State Machine ── */
function onBallDetected(pos) {
  // Ball reappeared — cancel post-throw monitor (was a bounce)
  if (postThrowBuffer && postThrowBuffer.disappearFrames < DISAPPEAR_FOR_MAKE) {
    postThrowBuffer = null;
  }
  ballDisappearFrames = 0;
  lastBallSeenAt = pos.t;
  lastBallPos = { x: pos.x, y: pos.y };

  // Compute velocity
  let vx=0, vy=0;
  if (ballPositions.length) {
    const prev = ballPositions[ballPositions.length-1];
    const dt = (pos.t - prev.t) || 16;
    vx = (pos.x-prev.x)/dt;
    vy = (pos.y-prev.y)/dt;
  }
  const p = { x:pos.x, y:pos.y, t:pos.t, vx, vy };
  ballPositions.push(p);
  if (ballPositions.length > 30) ballPositions.shift();

  if (!throwActive) {
    // Detect throw start: sustained motion
    const speed = Math.hypot(vx, vy);
    if (speed > 0.25 && ballPositions.length >= THROW_MIN_FRAMES) {
      const recent = ballPositions.slice(-THROW_MIN_FRAMES);
      // Tolerate one dropped/slow frame so a brief detection gap doesn't
      // prevent a real throw from registering.
      const moving = recent.filter(q => Math.hypot(q.vx, q.vy) > 0.08).length;
      if (moving >= THROW_MIN_FRAMES - 1) {
        throwActive = true;
        throwBuffer = recent.map(q => ({...q}));
        if (throwCbs.onThrowStart) throwCbs.onThrowStart();
      }
    }
  } else {
    throwBuffer.push(p);
    // Throw abort: ball reversed sharply
    if (throwBuffer.length > 3) {
      const n = throwBuffer.length;
      const v1x = throwBuffer[n-2].x - throwBuffer[n-3].x;
      const v2x = p.x - throwBuffer[n-2].x;
      if (Math.sign(v1x) !== Math.sign(v2x) && Math.abs(v1x) > 5) {
        endThrow();
      }
    }
  }
}

function onBallMissing(now) {
  ballDisappearFrames++;

  if (throwActive) {
    // Last buffered point — may itself be a bridge-predicted point when an
    // occlusion spans several frames (constant-velocity chaining).
    const lastPt = throwBuffer.length ? throwBuffer[throwBuffer.length-1] : null;
    const lastT = lastPt ? lastPt.t : now;
    if (now - lastT > 1500 || !lastPt) { endThrow(); return; }
    // Bridge a brief occlusion (e.g. the ball passing behind the throwing hand)
    // by extrapolating at the last known velocity, so a fast shot keeps its arc
    // and its make instead of being cut short. Only while it's clearly moving.
    const speed = Math.hypot(lastPt.vx || 0, lastPt.vy || 0);
    if (ballDisappearFrames <= 3 && speed > 0.15) {
      const dt = 16;
      throwBuffer.push({
        x: lastPt.x + lastPt.vx * dt,
        y: lastPt.y + lastPt.vy * dt,
        t: now, vx: lastPt.vx, vy: lastPt.vy, predicted: true
      });
    } else if (ballDisappearFrames >= 6) {
      endThrow();
    }
    return;
  }

  // Post-throw monitoring for cup detection
  if (postThrowBuffer) {
    postThrowBuffer.disappearFrames++;
    if (postThrowBuffer.disappearFrames >= DISAPPEAR_FOR_MAKE) {
      triggerCupCheck();
      postThrowBuffer = null;
    }
  }
}

function endThrow() {
  throwActive = false;
  const buf = throwBuffer.slice();
  throwBuffer = [];

  if (buf.length < THROW_MIN_FRAMES) return;

  // Compute speed
  let maxSpeed = 0;
  for (let i=1; i<buf.length; i++) {
    const dx = buf[i].x-buf[i-1].x, dy = buf[i].y-buf[i-1].y;
    const dt = (buf[i].t-buf[i-1].t)/1000 || 0.016;
    const spd = Math.hypot(dx,dy)/dt;
    if (calibration) {
      const mph = (spd/calibration.pixPerFt)*3600/5280;
      if (mph > maxSpeed) maxSpeed = mph;
    }
  }
  lastSpeed = maxSpeed;
  if (maxSpeed > 0.5 && throwCbs.onSpeed) throwCbs.onSpeed(maxSpeed);

  // Compute arc
  const parab = fitParabola(buf);
  if (parab) {
    lastArcPoints = arcFromParabola(parab, buf);
    arcFade = 1.0;
  }

  // Start post-throw monitoring
  postThrowBuffer = { positions: buf, disappearFrames: ballDisappearFrames };
}

function triggerCupCheck() {
  if (!postThrowBuffer) return;
  const gs = getGameState ? getGameState() : null;
  if (!gs) return;

  const defending = gs.shootingTeam === 'A' ? 'teamB' : 'teamA';
  const activeCupIds = new Set(
    (gs.cups[defending] || []).filter(c => !c.made).map(c => c.id)
  );

  const make = checkCupMake(
    postThrowBuffer.positions,
    postThrowBuffer.disappearFrames,
    gs.shootingTeam,
    activeCupIds
  );

  if (make && throwCbs.onMakeDetected) throwCbs.onMakeDetected(make);
}

/* ── Main Render + CV Loop ── */
async function trackLoop(now) {
  if (!trackingActive) return;
  animId = requestAnimationFrame(trackLoop);

  if (!video || !video.videoWidth) return;

  // Draw video frame to the display canvas (overlays draw on top)
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch(e) { return; }

  // Ball CV runs EVERY frame — the downscaled buffer keeps it cheap so a fast
  // ball is never dropped to "catch up".
  processCV(now);

  // Mask preview (calibration screen)
  if (maskPreviewActive && maskPreviewCanvas && ballHSV) {
    drawMaskPreviewOnCanvas(maskPreviewCanvas);
  }

  // Overlays
  drawOverlays(now);
  frameCount++;
}

function processCV(now) {
  ensureCvCanvas();
  // One downscaled draw of the current frame, shared by ball + pose.
  try { cvCtx.drawImage(video, 0, 0, cvCanvas.width, cvCanvas.height); }
  catch(e) { return; }
  const s = cvScale;

  // Ball tracking — read only the table ROI (plus headroom) from the buffer.
  if (calibration && ballHSV) {
    const { bounds } = calibration;
    const dMinX = bounds.minX, dMaxX = bounds.maxX;
    const dMinY = Math.max(0, bounds.minY - 100), dMaxY = bounds.maxY;
    const rx = Math.max(0, Math.floor(dMinX * s));
    const ry = Math.max(0, Math.floor(dMinY * s));
    const rw = Math.min(cvCanvas.width  - rx, Math.ceil((dMaxX - dMinX) * s) + 1);
    const rh = Math.min(cvCanvas.height - ry, Math.ceil((dMaxY - dMinY) * s) + 1);
    let found = false;
    if (rw > 0 && rh > 0) {
      try {
        const roi = cvCtx.getImageData(rx, ry, rw, rh);
        const blob = findBallInRoi(roi);
        if (blob) {
          // ROI-local cv coords → full cv coords → display coords
          onBallDetected({ x: (rx + blob.x) / s, y: (ry + blob.y) / s, t: now });
          found = true;
        }
      } catch(e) { /* getImageData can throw on a tainted canvas */ }
    }
    if (!found) onBallMissing(now);
  }

  // Pose throttled and never concurrent (foul detection tolerates lower fps).
  if (now - lastPoseTime >= POSE_INTERVAL_MS && !poseInFlight) {
    lastPoseTime = now;
    runPose();
  }
}

function drawOverlays(now) {
  if (!calibration) return;
  const gsDraw = getGameState ? getGameState() : null;
  const fl = (gsDraw && activeFoulLine(gsDraw.shootingTeam)) || calibration.foulLine;

  // Foul line
  ctx.save();
  const isFlashing = now < foulFlashUntil;
  ctx.strokeStyle = isFlashing ? 'rgba(255,220,0,0.95)' : 'rgba(255,60,60,0.65)';
  ctx.lineWidth = isFlashing ? 3 : 2;
  ctx.setLineDash([12,6]);
  ctx.beginPath(); ctx.moveTo(fl.p1.x,fl.p1.y); ctx.lineTo(fl.p2.x,fl.p2.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Arc overlay
  const arcPts = throwActive ? throwBuffer : lastArcPoints;
  if (arcPts && arcPts.length >= 3) {
    const alpha = throwActive ? 0.9 : Math.max(0.25, arcFade);
    const parab = fitParabola(arcPts);
    if (parab) {
      const curve = arcFromParabola(parab, arcPts);
      ctx.save();
      ctx.strokeStyle = `rgba(100,200,255,${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(100,200,255,0.6)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      curve.forEach((p,i) => i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
      ctx.stroke();
      ctx.restore();
    }
    // Raw dots
    ctx.save();
    ctx.fillStyle = `rgba(255,210,50,${alpha})`;
    for (const p of arcPts) {
      ctx.beginPath(); ctx.arc(p.x,p.y,3,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
  if (!throwActive) arcFade = Math.max(0.25, arcFade - 0.004);

  // ── Live ball trail (continuous, independent of throw detection) ──
  if (!throwActive && ballPositions.length >= 2) {
    ctx.save();
    ctx.lineCap = 'round';
    const start = Math.max(1, ballPositions.length - 14);
    for (let i = start; i < ballPositions.length; i++) {
      const a = ballPositions[i-1], b = ballPositions[i];
      if (b.t - a.t > 200) continue;   // skip stale gaps between detections
      if (now - b.t > 700) continue;   // only recent segments
      const recency = 1 - (now - b.t) / 700;
      ctx.strokeStyle = `rgba(120,220,255,${0.15 + 0.45*recency})`;
      ctx.lineWidth = 2 + 3*recency;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  // ── Live ball marker (only while the ball is actively detected) ──
  const ballFresh = lastBallSeenAt > 0 && (now - lastBallSeenAt) < 250;
  if (ballFresh && lastBallPos) {
    ctx.save();
    ctx.shadowColor = 'rgba(120,220,255,0.9)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = 'rgba(120,220,255,0.95)';
    ctx.beginPath(); ctx.arc(lastBallPos.x, lastBallPos.y, 7, 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lastBallPos.x, lastBallPos.y, 11, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  }

  // ── Ball-tracking status badge (top-left) ──
  {
    const tracking = lastBallSeenAt > 0 && (now - lastBallSeenAt) < 500;
    const label = tracking ? '\u25CF Tracking ball' : '\u25CB No ball \u2014 re-sample color';
    ctx.save();
    ctx.font = '600 14px system-ui, -apple-system, sans-serif';
    const padX = 10, bh = 26;
    const bw = ctx.measureText(label).width + padX*2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, bw, bh);
    ctx.fillStyle = tracking ? 'rgba(80,230,120,0.95)' : 'rgba(255,120,120,0.95)';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 10 + padX, 10 + bh/2 + 1);
    ctx.restore();
  }

  // Cup zone indicators
  if (cupLayout) {
    const gs = getGameState ? getGameState() : null;
    for (const side of ['teamA','teamB']) {
      const cups = cupLayout[side] || [];
      for (const cup of cups) {
        const made = gs && gs.cups[side] && gs.cups[side].find(c=>c.id===cup.id)?.made;
        ctx.save();
        ctx.strokeStyle = made ? 'rgba(255,50,50,0.25)' : 'rgba(50,255,100,0.3)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.arc(cup.x,cup.y,cup.r,0,Math.PI*2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  // Pose skeleton
  if (poseLandmarks) drawSkeleton();

  // Cup number label for last detected cup
}

function drawSkeleton() {
  if (!poseLandmarks) return;
  const w = canvas.width, h = canvas.height;
  const CONNS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];
  ctx.save();
  ctx.strokeStyle = 'rgba(0,200,255,0.6)';
  ctx.lineWidth = 2;
  for (const [a,b] of CONNS) {
    const la=poseLandmarks[a], lb=poseLandmarks[b];
    if (!la||!lb||(la.visibility||0)<0.3||(lb.visibility||0)<0.3) continue;
    ctx.beginPath(); ctx.moveTo(la.x*w,la.y*h); ctx.lineTo(lb.x*w,lb.y*h); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,120,120,0.8)';
  for (const lm of poseLandmarks) {
    if ((lm.visibility||0)<0.3) continue;
    ctx.beginPath(); ctx.arc(lm.x*w,lm.y*h,4,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

/* ── MediaPipe Pose ── */
function initPose() {
  if (poseDetector) return;
  if (typeof Pose === 'undefined') {
    console.warn('MediaPipe Pose not loaded — elbow detection disabled');
    return;
  }
  try {
    poseDetector = new Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`
    });
    poseDetector.setOptions({
      modelComplexity: 0,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.4,
      minTrackingConfidence: 0.4
    });
    poseDetector.onResults(results => {
      if (results.poseLandmarks && results.poseLandmarks.length) {
        poseLandmarks = results.poseLandmarks;
        poseConfidence = 0.9;
        checkElbowFoul(poseLandmarks);
      } else {
        poseLandmarks = null;
        poseConfidence = 0;
      }
    });
  } catch(e) {
    console.warn('Pose init error:', e);
    poseDetector = null;
  }
}

async function runPose() {
  if (!poseDetector || poseInFlight) return;
  poseInFlight = true;
  try { await poseDetector.send({ image: cvCanvas || canvas }); }
  catch(e) { /* suppress */ }
  finally { poseInFlight = false; }
}

function checkElbowFoul(landmarks) {
  if (!calibration || !throwActive) return;
  if (performance.now() - lastFoulTime < FOUL_DEBOUNCE_MS) return;
  if (poseConfidence < 0.5) return;
  const gs = getGameState ? getGameState() : null;
  if (!gs) return;

  const w = canvas.width, h = canvas.height;
  const fl = activeFoulLine(gs.shootingTeam);
  if (!fl) return;
  // Check both arms
  for (const [elbIdx, wristIdx] of [[13,15],[14,16]]) {
    const elbow = landmarks[elbIdx], wrist = landmarks[wristIdx];
    if (!elbow||!wrist||(elbow.visibility||0)<0.4||(wrist.visibility||0)<0.4) continue;
    const ex = elbow.x*w, ey = elbow.y*h;
    // Elbow reached over the shooter's end line past the grace margin
    const wvy = (wrist.y - elbow.y)*h;
    if (Math.abs(wvy) > 0.02) {
      const side = foulSideDist(ex, ey, fl);
      if (side > FOUL_GRACE_PX) {
        lastFoulTime = performance.now();
        foulFlashUntil = performance.now() + 3000;
        const shooter = gs.shooterName || 'Player';
        if (throwCbs.onFoulDetected) throwCbs.onFoulDetected({ player: shooter });
        break;
      }
    }
  }
}

/* ── Mask Preview for Ball Calibration ── */
function drawMaskPreviewOnCanvas(targetCanvas) {
  if (!ballHSV || !video.videoWidth) return;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i=0; i<d.length; i+=4) {
      if (matchesBall(d[i],d[i+1],d[i+2])) {
        d[i]=0; d[i+1]=255; d[i+2]=0; d[i+3]=200;
      }
    }
    const tc = targetCanvas;
    tc.width = canvas.width; tc.height = canvas.height;
    tc.getContext('2d').putImageData(imgData, 0, 0);
  } catch(e) { /* cross-origin guard */ }
}

/* ── Public API ── */
window.Vision = {
  init(vid, cvs) {
    video = vid; canvas = cvs; ctx = cvs.getContext('2d');
  },

  async startCamera(facingMode) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width:{ideal:1280}, height:{ideal:720}, facingMode: facingMode||'user' }
      });
      video.srcObject = stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      video.play();
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      return true;
    } catch(e) {
      console.error('Camera error', e); return false;
    }
  },

  stopCamera() {
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(t=>t.stop());
      video.srcObject = null;
    }
  },

  sampleBallColor(x, y) {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const size=13, half=6;
      const sx=Math.max(0,Math.round(x)-half), sy=Math.max(0,Math.round(y)-half);
      const id = ctx.getImageData(sx,sy,size,size);
      const d = id.data;
      const all=[], colored=[];
      for (let i=0;i<d.length;i+=4) {
        const px = rgbToHsv(d[i],d[i+1],d[i+2]);
        all.push(px);
        if (px.s >= 35 && px.v >= 30) colored.push(px);
      }
      if (!all.length) return null;
      // Prefer the saturated pixels (the actual colored ball) when a decent
      // fraction of the patch is colored. This stops a small orange ball on a
      // bright white table from being sampled as the white background, which
      // would drop us into the weak "pale" matcher and match everything.
      const use = (colored.length >= all.length * 0.25) ? colored : all;
      const med = vals => { const s = vals.slice().sort((a,b)=>a-b); return s[(s.length/2)|0]; };
      ballHSV = {
        hue: med(use.map(p=>p.h)),
        sat: med(use.map(p=>p.s)),
        val: med(use.map(p=>p.v))
      };
      return ballHSV;
    } catch(e) { return null; }
  },

  setCalibration(corners, tableFt) {
    // Side-across view: table LENGTH (tableFt) runs along the front/back long edges.
    const frontLen = Math.hypot(corners[1].x-corners[0].x, corners[1].y-corners[0].y);
    const backLen  = Math.hypot(corners[3].x-corners[2].x, corners[3].y-corners[2].y);
    const pixPerFt = ((frontLen+backLen)/2) / Math.max(1, tableFt);
    const roiPoly = [corners[0],corners[1],corners[3],corners[2]];
    const bounds = polyBounds(roiPoly);
    const center = worldToCanvas(0.5, 0.5, corners);
    calibration = {
      corners, tableFt, pixPerFt, center,
      // Foul line = shooter's END of the table (side-across view):
      // Team A on the LEFT end, Team B on the RIGHT end.
      foulLineA: { p1:corners[0], p2:corners[2] },  // left end
      foulLineB: { p1:corners[1], p2:corners[3] },  // right end
      foulLine:  { p1:corners[0], p2:corners[2] },  // default (Team A / left)
      farLine:   { p1:corners[2], p2:corners[3] },
      roiPoly, bounds
    };
    return calibration;
  },

  setCupLayout(count) {
    if (!calibration) return null;
    cupLayout = {
      teamA: computeCupPixelPositions(calibration.corners, count, 'teamA'),
      teamB: computeCupPixelPositions(calibration.corners, count, 'teamB')
    };
    return cupLayout;
  },

  get cupAdjust() { return cupAdjust; },
  setCupAdjust(a) {
    if (!a) return;
    cupAdjust = {
      teamA: { dx: 0, dy: 0, ...(a.teamA || cupAdjust.teamA) },
      teamB: { dx: 0, dy: 0, ...(a.teamB || cupAdjust.teamB) },
      scale: a.scale != null ? a.scale : cupAdjust.scale,
      radiusMul: a.radiusMul != null ? a.radiusMul : cupAdjust.radiusMul
    };
  },
  nudgeCupRack(side, dx, dy) {
    if (side !== 'teamA' && side !== 'teamB') return;
    cupAdjust[side].dx += dx; cupAdjust[side].dy += dy;
  },
  setCupSpread(scale)  { cupAdjust.scale = Math.max(0.7, Math.min(1.4, scale)); },
  setCupRadiusMul(m)   { cupAdjust.radiusMul = Math.max(0.8, Math.min(1.8, m)); },
  resetCupAdjust()     { cupAdjust = { teamA:{dx:0,dy:0}, teamB:{dx:0,dy:0}, scale:1, radiusMul:1 }; },

  startTracking(cbs, gsGetter) {
    throwCbs = cbs || {};
    getGameState = gsGetter || null;
    trackingActive = true;
    // Reset per-game tracking buffers so stale balls/arcs don't carry over.
    ballPositions = []; throwBuffer = []; throwActive = false;
    postThrowBuffer = null; lastArcPoints = [];
    ballDisappearFrames = 0; lastBallSeenAt = 0; lastBallPos = null;
    initPose();
    if (animId) cancelAnimationFrame(animId);
    animId = requestAnimationFrame(trackLoop);
  },

  stopTracking() {
    trackingActive = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
  },

  startMaskPreview(targetCanvas) {
    maskPreviewCanvas = targetCanvas;
    maskPreviewActive = true;
    if (!trackingActive) {
      (function loop() {
        if (!maskPreviewActive) return;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          drawMaskPreviewOnCanvas(targetCanvas);
        } catch(e) {}
        requestAnimationFrame(loop);
      })();
    }
  },

  stopMaskPreview() { maskPreviewActive = false; },

  flashFoulLine(ms) { foulFlashUntil = performance.now() + (ms||3000); },

  get hsvTol() { return hsvTol; },
  setHsvTol(t) { hsvTol = {...hsvTol, ...t}; },
  matchesBall(r, g, b) { return matchesBall(r, g, b); },

  get ballHSV() { return ballHSV; },
  set ballHSV(v) { ballHSV = v; },

  get calibration() { return calibration; },
  get cupLayout() { return cupLayout; },
  get poseConfidence() { return poseConfidence; },
  get lastSpeed() { return lastSpeed; },
  get throwActive() { return throwActive; },

  worldToCanvas(u, v) {
    if (!calibration) return {x:0,y:0};
    return worldToCanvas(u, v, calibration.corners);
  }
};

})();
