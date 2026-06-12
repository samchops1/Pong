/* vision.js — Computer Vision Engine for Pong Ref
   Exposes window.Vision */
(function () {
'use strict';

/* ── Cup layouts in normalized table coordinates ──
   u=0 left, u=1 right, v=0 near (Team A), v=1 far (Team B) */
const CUP_LAYOUTS = {
  10: {
    teamA: [
      {id:1,u:0.219,v:0.153},{id:2,u:0.406,v:0.153},{id:3,u:0.594,v:0.153},{id:4,u:0.781,v:0.153},
      {id:5,u:0.313,v:0.112},{id:6,u:0.500,v:0.112},{id:7,u:0.688,v:0.112},
      {id:8,u:0.406,v:0.072},{id:9,u:0.594,v:0.072},
      {id:10,u:0.500,v:0.031}
    ],
    teamB: [
      {id:1,u:0.219,v:0.847},{id:2,u:0.406,v:0.847},{id:3,u:0.594,v:0.847},{id:4,u:0.781,v:0.847},
      {id:5,u:0.313,v:0.888},{id:6,u:0.500,v:0.888},{id:7,u:0.688,v:0.888},
      {id:8,u:0.406,v:0.928},{id:9,u:0.594,v:0.928},
      {id:10,u:0.500,v:0.969}
    ]
  },
  6: {
    teamA: [
      {id:1,u:0.313,v:0.112},{id:2,u:0.500,v:0.112},{id:3,u:0.688,v:0.112},
      {id:4,u:0.406,v:0.072},{id:5,u:0.594,v:0.072},
      {id:6,u:0.500,v:0.031}
    ],
    teamB: [
      {id:1,u:0.313,v:0.888},{id:2,u:0.500,v:0.888},{id:3,u:0.688,v:0.888},
      {id:4,u:0.406,v:0.928},{id:5,u:0.594,v:0.928},
      {id:6,u:0.500,v:0.969}
    ]
  }
};

/* State */
let video, canvas, ctx;
let calibration = null;
let ballHSV = null;
let cupLayout = null;
let ballPositions = [];   // rolling 30-frame buffer
let throwBuffer = [];     // positions during active throw
let throwActive = false;
let postThrowBuffer = null;  // {positions, disappearFrames} for cup detection
let ballDisappearFrames = 0;
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
let skipCV = 0;
let maskPreviewActive = false;
let maskPreviewCanvas = null;
let maskPreviewCtx = null;

let hsvTol = { hue: 18, sat: 60, valFloor: 80 };

const BALL_MIN_PX = 4;
const BALL_MAX_PX = 500;
const THROW_MIN_FRAMES = 4;
const POSE_INTERVAL_MS = 67;
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
  const dh = Math.min(Math.abs(h - ballHSV.hue), 360 - Math.abs(h - ballHSV.hue));
  return dh <= hsvTol.hue && Math.abs(s - ballHSV.sat) <= hsvTol.sat;
}

/* Bilinear interpolation: world [u,v] → canvas [x,y] */
function worldToCanvas(u, v, corners) {
  // corners: [near-left, near-right, far-left, far-right]
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
    let head = 0, sx = 0, sy = 0, cnt = 0;
    while (head < queue.length && cnt < BALL_MAX_PX * 2) {
      const idx = queue[head++];
      const bx = idx % w, by = (idx / w) | 0;
      sx += bx; sy += by; cnt++;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = bx+dx, ny = by+dy;
        if (nx<0||ny<0||nx>=w||ny>=h) continue;
        const ni = ny*w+nx;
        if (mask[ni] && !vis[ni]) { vis[ni]=1; queue.push(ni); }
      }
    }
    if (cnt >= BALL_MIN_PX && cnt <= BALL_MAX_PX && (!best || cnt > best.cnt)) {
      best = { cx: sx/cnt, cy: sy/cnt, cnt };
    }
  }
  return best;
}

/* Build HSV mask for tracking region (every 2nd pixel for speed) */
function buildAndFindBall(imageData, bounds) {
  const { data, width } = imageData;
  const STEP = 2;
  const x0 = Math.max(0, Math.floor(bounds.minX));
  const y0 = Math.max(0, Math.floor(bounds.minY));
  const x1 = Math.min(width-1, Math.ceil(bounds.maxX));
  const y1 = Math.min(imageData.height-1, Math.ceil(bounds.maxY));
  const bw = Math.ceil((x1-x0)/STEP)+1;
  const bh = Math.ceil((y1-y0)/STEP)+1;
  const mask = new Uint8Array(bw * bh);
  let mi = 0;
  for (let y=y0; y<=y1; y+=STEP) {
    for (let x=x0; x<=x1; x+=STEP) {
      const pi = (y*width+x)*4;
      mask[mi++] = matchesBall(data[pi], data[pi+1], data[pi+2]) ? 1 : 0;
    }
  }
  const blob = findLargestBlob(mask, bw, bh);
  if (!blob) return null;
  return { x: blob.cx*STEP+x0, y: blob.cy*STEP+y0, cnt: blob.cnt*4 };
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

/* ── Cup Position Computation ── */
function computeCupPixelPositions(corners, count, side) {
  const layout = CUP_LAYOUTS[count];
  if (!layout) return [];
  const worldCups = layout[side];
  // Estimate cup radius from table pixel width
  const nearW = Math.hypot(corners[1].x-corners[0].x, corners[1].y-corners[0].y);
  const farW  = Math.hypot(corners[3].x-corners[2].x, corners[3].y-corners[2].y);
  const avgW  = (nearW+farW)/2;
  const r = Math.max(14, Math.min(35, avgW * 0.045));
  return worldCups.map(cup => {
    const px = worldToCanvas(cup.u, cup.v, corners);
    return { id: cup.id, x: px.x, y: px.y, r };
  });
}

/* ── Auto Cup Detection ── */
function checkCupMake(positions, disappearFrames, shootingTeam, activeCupIds) {
  if (!cupLayout || !calibration) return null;
  if (positions.length < 2) return null;
  if (disappearFrames < DISAPPEAR_FOR_MAKE) return null;

  const defending = shootingTeam === 'A' ? 'teamB' : 'teamA';
  const defendCups = cupLayout[defending];
  if (!defendCups || !defendCups.length) return null;

  const last = positions[positions.length - 1];

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
      const sustained = recent.every(q => Math.hypot(q.vx, q.vy) > 0.08);
      if (sustained) {
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
    // Check 1.5s timeout
    const lastT = throwBuffer.length ? throwBuffer[throwBuffer.length-1].t : now;
    if (now - lastT > 1500 || throwBuffer.length < 1) {
      endThrow();
    } else if (ballDisappearFrames >= 2) {
      // Ball disappeared during throw → end throw immediately
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

  // Draw video frame
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch(e) { return; }

  // CV processing (skip frames if falling behind)
  if (skipCV > 0) { skipCV--; }
  else {
    const t0 = performance.now();
    processCV(now);
    const dt = performance.now()-t0;
    if (dt > 30) skipCV = Math.min(3, Math.floor(dt/30));
  }

  // Mask preview (calibration screen)
  if (maskPreviewActive && maskPreviewCanvas && ballHSV) {
    drawMaskPreviewOnCanvas(maskPreviewCanvas);
  }

  // Overlays
  drawOverlays(now);
  frameCount++;
}

function processCV(now) {
  let imgData;
  try { imgData = ctx.getImageData(0,0,canvas.width,canvas.height); }
  catch(e) { return; }

  // Ball tracking
  if (calibration && ballHSV) {
    const { bounds } = calibration;
    const trackBounds = {
      minX: bounds.minX, maxX: bounds.maxX,
      minY: Math.max(0, bounds.minY - 100),
      maxY: bounds.maxY
    };
    const blob = buildAndFindBall(imgData, trackBounds);
    if (blob) onBallDetected({ x: blob.x, y: blob.y, t: now });
    else onBallMissing(now);
  }

  // Pose at ~15fps
  if (now - lastPoseTime >= POSE_INTERVAL_MS) {
    lastPoseTime = now;
    runPose();
  }
}

function drawOverlays(now) {
  if (!calibration) return;
  const fl = calibration.foulLine;
  const ff = calibration.farLine;

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
  if (!poseDetector) return;
  try { await poseDetector.send({ image: canvas }); }
  catch(e) { /* suppress */ }
}

function checkElbowFoul(landmarks) {
  if (!calibration || !throwActive) return;
  if (performance.now() - lastFoulTime < FOUL_DEBOUNCE_MS) return;
  if (poseConfidence < 0.5) return;
  const gs = getGameState ? getGameState() : null;
  if (!gs) return;

  const w = canvas.width, h = canvas.height;
  // Check both arms
  for (const [elbIdx, wristIdx] of [[13,15],[14,16]]) {
    const elbow = landmarks[elbIdx], wrist = landmarks[wristIdx];
    if (!elbow||!wrist||(elbow.visibility||0)<0.4||(wrist.visibility||0)<0.4) continue;
    const ex = elbow.x*w, ey = elbow.y*h;
    // Wrist moving forward past elbow with velocity
    const wvy = (wrist.y - elbow.y)*h;
    if (Math.abs(wvy) > 0.02) {
      const fl = calibration.foulLine;
      const side = signedLineDist(ex, ey, fl.p1, fl.p2);
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
      const size=15, half=7;
      const sx=Math.max(0,Math.round(x)-half), sy=Math.max(0,Math.round(y)-half);
      const id = ctx.getImageData(sx,sy,size,size);
      const d = id.data;
      const hs=[], ss=[], vs=[];
      for (let i=0;i<d.length;i+=4) {
        const {h,s,v}=rgbToHsv(d[i],d[i+1],d[i+2]);
        hs.push(h); ss.push(s); vs.push(v);
      }
      hs.sort((a,b)=>a-b); ss.sort((a,b)=>a-b); vs.sort((a,b)=>a-b);
      const mid = (hs.length/2)|0;
      ballHSV = { hue: hs[mid], sat: ss[mid], val: vs[mid] };
      return ballHSV;
    } catch(e) { return null; }
  },

  setCalibration(corners, tableFt) {
    const leftLen  = Math.hypot(corners[2].x-corners[0].x, corners[2].y-corners[0].y);
    const rightLen = Math.hypot(corners[3].x-corners[1].x, corners[3].y-corners[1].y);
    const pixPerFt = ((leftLen+rightLen)/2) / Math.max(1, tableFt);
    const roiPoly = [corners[0],corners[1],corners[3],corners[2]];
    const bounds = polyBounds(roiPoly);
    calibration = {
      corners, tableFt, pixPerFt,
      foulLine: { p1:corners[0], p2:corners[1] },
      farLine:  { p1:corners[2], p2:corners[3] },
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

  startTracking(cbs, gsGetter) {
    throwCbs = cbs || {};
    getGameState = gsGetter || null;
    trackingActive = true;
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
