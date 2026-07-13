/* app.js — Pong Ref game controller */
(function () {
'use strict';

/* ── Cup rack SVG geometry ── */
const CUP_POSITIONS_10 = [
  {id:1,cx:20,cy:130},{id:2,cx:60,cy:130},{id:3,cx:100,cy:130},{id:4,cx:140,cy:130},
  {id:5,cx:40,cy:96},{id:6,cx:80,cy:96},{id:7,cx:120,cy:96},
  {id:8,cx:60,cy:62},{id:9,cx:100,cy:62},
  {id:10,cx:80,cy:28}
];
const CUP_POSITIONS_6 = [
  {id:1,cx:30,cy:100},{id:2,cx:70,cy:100},{id:3,cx:110,cy:100},
  {id:4,cx:50,cy:66},{id:5,cx:90,cy:66},
  {id:6,cx:70,cy:32}
];
// Chandeliers overtime: 3 bottom + 1 top (id 4 = top, must be made first)
const CUP_POSITIONS_CHANDELIERS = [
  {id:1,cx:20,cy:80},{id:2,cx:60,cy:80},{id:3,cx:100,cy:80},
  {id:4,cx:60,cy:44}
];

/* ── State ── */
let state = null;
let calCorners = [];
let cornerStep = 0;
let calPreviewActive = false;
let ballPreviewActive = false;
let ballSampled = false;
let pendingMask = false;
let cupAdjustMode = false;
let cupDrag = null;
let cupClickMode = false;
let cupClickPlaced = { teamA: [], teamB: [] };
let cupClickTeam = 'teamA';
let cupClickRadius = 25;
let confettiRaf = null;
const SAVE_KEY = 'pongref_v5';
const HISTORY_KEY = 'pongref_history_v1';

function freshState(cfg) {
  const n = cfg.cupCount;
  const makeCups = () => Array.from({length:n}, (_,i) => ({id:i+1, made:false, madeBy:null}));
  return {
    mode: cfg.mode,
    players: {
      A: [cfg.players.A[0]||'Team A', cfg.players.A[1]||'A2'],
      B: [cfg.players.B[0]||'Team B', cfg.players.B[1]||'B2']
    },
    cupCount: n,
    tableFt: cfg.tableFt,
    shootingTeam: 'A',
    shooterIndex: {A:0, B:0},
    cups: {teamA: makeCups(), teamB: makeCups()},
    playerStats: {},
    eventLog: [],
    consecutiveMisses: {A:0, B:0},
    makesThisTurn: 0,
    turnMakesPerPlayer: {},  // {playerName: count} cups made this real turn
    turnFirstCupId: null,    // cup ID made by first 2v2 shooter (same-cup detection)
    fireStreak: {},          // {playerName: consecutive real-turn makes}
    onFire: {A:null, B:null},// per-team: player name currently on fire
    ballsBack: cfg.ballsBack,
    strictFoul: cfg.strictFoul,
    penalties: {A:0, B:0},
    fastest: {A:0, B:0},
    startTime: Date.now(),
    muted: false,
    isRebuttal: false,
    rebuttalTeam: null,
    rebuttalShotsLeft: 0,
    rebuttalMakes: 0,
    isChandeliers: false,
    chandeliersTopMade: {teamA: false, teamB: false},
    islandCallsUsed: {},
    pendingIslandCall: null
  };
}

function ensureStats(name) {
  if (name && !state.playerStats[name]) {
    state.playerStats[name] = {made:0, fastest:0, penalties:0};
  }
}

function shooterName() {
  const t = state.shootingTeam;
  const idx = state.mode === '2v2' ? state.shooterIndex[t] : 0;
  return state.players[t][idx] || `Team ${t}`;
}

function getGameState() {
  return state ? {...state, shooterName: shooterName()} : null;
}

/* ── Screens ── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ─────────────────────────── SETUP SCREEN ─────────────────────────── */
function initSetupScreen() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const is2v2 = btn.dataset.mode === '2v2';
      document.querySelectorAll('.player-name-2v2').forEach(el => {
        el.classList.toggle('hidden', !is2v2);
      });
      // Balls-back only applies in 2v2 (1v1 uses one ball — no balls-back possible)
      const bbLabel = document.getElementById('ballsBack')?.closest('label');
      if (bbLabel) bbLabel.classList.toggle('hidden', !is2v2);
    });
  });

  // Initialize: 1v1 is default, so hide balls-back (2v2-only rule)
  const bbLabel = document.getElementById('ballsBack')?.closest('label');
  if (bbLabel) bbLabel.classList.add('hidden');

  document.querySelectorAll('.cup-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cup-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('btn-start-calibration').addEventListener('click', () => {
    state = null; // starting from setup is always a brand-new game
    const mode = document.querySelector('.mode-btn.active')?.dataset.mode || '1v1';
    const cupCount = parseInt(document.querySelector('.cup-btn.active')?.dataset.cups || '10');
    const tableFt = parseFloat(document.getElementById('table-length').value) || 8;
    window._cfg = {
      mode, cupCount, tableFt, ballsBack: document.getElementById('ballsBack').checked,
      strictFoul: document.getElementById('strictFoul').checked,
      players: {
        A: [document.getElementById('playerA1').value.trim(), document.getElementById('playerA2').value.trim()],
        B: [document.getElementById('playerB1').value.trim(), document.getElementById('playerB2').value.trim()]
      }
    };
    startCalCorners();
  });

  const saved = loadSaved();
  if (saved) {
    document.getElementById('resume-modal').classList.remove('hidden');
    document.getElementById('btn-resume-yes').onclick = () => {
      state = saved.gameState;
      const cv = saved.cvState;
      if (cv) {
        if (cv.calCorners && cv.calCorners.length === 4) calCorners = cv.calCorners;
        if (cv.ballHSV) Vision.ballHSV = cv.ballHSV;
        if (cv.hsvTol) Vision.setHsvTol(cv.hsvTol);
        if (cv.cupAdjust) Vision.setCupAdjust(cv.cupAdjust);
        if (cv.clickedLayout) Vision.setCupLayoutDirect(cv.clickedLayout);
      }
      // Rebuild _cfg from the resumed game even when no CV state was saved,
      // so a later recalibration doesn't crash on a missing config.
      window._cfg = window._cfg || {
        tableFt: state.tableFt, cupCount: state.cupCount,
        mode: state.mode, ballsBack: state.ballsBack, strictFoul: state.strictFoul,
        players: state.players
      };
      document.getElementById('resume-modal').classList.add('hidden');
      startGame();
    };
    document.getElementById('btn-resume-no').onclick = () => {
      clearSaved();
      document.getElementById('resume-modal').classList.add('hidden');
    };
  }
}

/* ─────────────────────────── CORNER CALIBRATION ─────────────────────────── */
const CORNER_INSTR = [
  'Click the <strong>front-left</strong> corner (near long edge, left end — Team A)',
  'Click the <strong>front-right</strong> corner (near long edge, right end — Team B)',
  'Click the <strong>back-left</strong> corner (far long edge, left end)',
  'Click the <strong>back-right</strong> corner (far long edge, right end)',
  'All 4 corners set! Proceeding to ball calibration…'
];

async function startCalCorners() {
  calCorners = []; cornerStep = 0;
  cupAdjustMode = false; cupDrag = null;
  cupClickMode = false; cupClickPlaced = { teamA:[], teamB:[] }; cupClickTeam = 'teamA';
  Vision.resetCupAdjust();
  const adjCtrl = document.getElementById('cup-adjust-controls');
  if (adjCtrl) adjCtrl.classList.add('hidden');
  showScreen('screen-calibrate-corners');
  updateCornerUI();

  const video = document.getElementById('cal-video');
  const canvas = document.getElementById('cal-canvas');
  Vision.init(video, canvas);

  const ok = await Vision.startCamera('environment');
  if (!ok) {
    alert('Camera permission denied. Please allow camera access and reload.');
    showScreen('screen-setup'); return;
  }
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  calPreviewActive = true;
  const ctx = canvas.getContext('2d');
  (function loop() {
    if (!calPreviewActive) return;
    if (video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      drawGridGuide(ctx, canvas);
      drawCornerDots(ctx);
      if (calCorners.length === 4) {
        drawCalOverlay(ctx);
        if (cupClickMode) drawClickOverlay(ctx);
      }
    }
    requestAnimationFrame(loop);
  })();

  canvas.addEventListener('click', onCornerClick);
  document.getElementById('btn-redo-corners').onclick = () => {
    calCorners = []; cornerStep = 0;
    cupClickMode = false; cupClickPlaced = { teamA:[], teamB:[] }; cupClickTeam = 'teamA';
    exitCupAdjust();
    Vision.resetCupAdjust();
    canvas.addEventListener('click', onCornerClick);
    updateCornerUI();
  };
}

function updateCornerUI() {
  document.getElementById('corner-instruction').innerHTML = CORNER_INSTR[cornerStep] || '';
  for (let i=0;i<4;i++) {
    const d = document.getElementById('cdot'+i);
    d.className = 'corner-dot' + (i<cornerStep?' done':i===cornerStep?' active':'');
  }
}

function drawGridGuide(ctx, canvas) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  for (let i=1;i<3;i++) {
    ctx.beginPath(); ctx.moveTo(canvas.width*i/3,0); ctx.lineTo(canvas.width*i/3,canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,canvas.height*i/3); ctx.lineTo(canvas.width,canvas.height*i/3); ctx.stroke();
  }
  ctx.restore();
}

function drawCornerDots(ctx) {
  calCorners.forEach((c,i) => {
    ctx.save();
    ctx.fillStyle = '#3fb950'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x,c.y,10,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(i+1), c.x, c.y+4);
    ctx.restore();
  });
  if (calCorners.length === 4) {
    const [c0,c1,c2,c3] = calCorners;
    ctx.save();
    ctx.strokeStyle = 'rgba(88,166,255,0.7)'; ctx.lineWidth = 2; ctx.setLineDash([8,4]);
    ctx.beginPath(); ctx.moveTo(c0.x,c0.y); ctx.lineTo(c1.x,c1.y);
    ctx.lineTo(c3.x,c3.y); ctx.lineTo(c2.x,c2.y); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,60,60,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([10,5]);
    ctx.beginPath(); ctx.moveTo(c0.x,c0.y); ctx.lineTo(c1.x,c1.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawCalOverlay(ctx) {
  if (!window._cfg) return;
  const cfg = window._cfg;
  const layout = Vision.setCupLayout(cfg.cupCount);
  if (!layout) return;
  for (const [side, clr] of [['teamA','rgba(88,166,255,0.55)'],['teamB','rgba(247,129,102,0.55)']]) {
    for (const cup of (layout[side]||[])) {
      ctx.save();
      ctx.strokeStyle = clr; ctx.lineWidth = 1.5; ctx.setLineDash([3,2]);
      ctx.beginPath(); ctx.arc(cup.x,cup.y,cup.r,0,Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = clr; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(cup.id, cup.x, cup.y+3);
      ctx.restore();
    }
  }
}

function canvasCoords(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX-r.left) * (canvas.width/r.width),
    y: (e.clientY-r.top) * (canvas.height/r.height)
  };
}

function onCornerClick(e) {
  if (cornerStep >= 4) return;
  const canvas = document.getElementById('cal-canvas');
  const {x, y} = canvasCoords(canvas, e);
  calCorners.push({x, y});
  cornerStep++;
  updateCornerUI();
  if (cornerStep === 4) {
    Vision.setCalibration(calCorners, window._cfg.tableFt||8);
    enterCupAdjust();
  }
}

/* After the 4 corners are set, let the user drag each team's cup ring onto the
   real cups and tweak spread/size — the flat projection can't fully model the
   camera's oblique perspective, so a quick manual nudge keeps cups aligned. */
function enterCupAdjust() {
  cupAdjustMode = true; cupDrag = null;
  const canvas = document.getElementById('cal-canvas');
  canvas.removeEventListener('click', onCornerClick);
  const orient = Vision.orientation;
  const orientHint = orient === 'end-on'
    ? ' (end-on view \u2014 cups appear top/bottom)'
    : ' (side-across \u2014 cups appear left/right)';
  document.getElementById('corner-instruction').innerHTML =
    'Drag each team\u2019s ring onto the real cups. Use sliders to fine-tune, then Continue.' + orientHint;
  const controls = document.getElementById('cup-adjust-controls');
  if (controls) controls.classList.remove('hidden');
  const adj = Vision.cupAdjust || {};
  const spread = document.getElementById('cup-spread');
  const radius = document.getElementById('cup-radius');
  if (spread) { spread.value = adj.scale != null ? adj.scale : 1; spread.oninput = () => Vision.setCupSpread(parseFloat(spread.value)); }
  if (radius) { radius.value = adj.radiusMul != null ? adj.radiusMul : 1; radius.oninput = () => Vision.setCupRadiusMul(parseFloat(radius.value)); }
  canvas.addEventListener('pointerdown', onCupPointerDown);
  canvas.addEventListener('pointermove', onCupPointerMove);
  window.addEventListener('pointerup', onCupPointerUp);
  canvas.addEventListener('click', onCupClick);
  document.getElementById('btn-cups-continue').onclick = proceedToBallCal;

  const cfg = window._cfg || {};
  const clickBtn = document.getElementById('btn-cup-click');
  if (clickBtn) clickBtn.onclick = () => {
    if (cupClickMode) {
      cupClickMode = false; cupClickPlaced = { teamA:[], teamB:[] }; cupClickTeam = 'teamA';
      clickBtn.textContent = 'Click Cups';
      updateCupClickHint();
    } else {
      const layout = Vision.setCupLayout(cfg.cupCount) || {};
      cupClickRadius = (layout.teamA && layout.teamA[0] && layout.teamA[0].r) || 25;
      cupClickMode = true;
      cupClickPlaced = { teamA:[], teamB:[] };
      cupClickTeam = 'teamA';
      clickBtn.textContent = 'Cancel Click Mode';
      updateCupClickHint();
    }
  };
  const clearBtn = document.getElementById('btn-cup-click-clear');
  if (clearBtn) clearBtn.onclick = () => {
    if (!cupClickMode) return;
    cupClickPlaced[cupClickTeam] = [];
    updateCupClickHint();
  };

  // Auto-detect red Solo cups on entry; re-run when the user presses Re-scan
  const badge = document.getElementById('cup-detect-badge');
  const runDetect = () => {
    if (badge) { badge.textContent = 'Scanning\u2026'; badge.className = 'cup-detect-badge'; }
    requestAnimationFrame(() => {
      const detected = Vision.detectCups(cfg.cupCount);
      if (detected) {
        Vision.setCupLayoutDirect(detected);
        const placed = detected.teamA.length + detected.teamB.length;
        if (badge) {
          badge.textContent = `\u2713 ${detected.totalFound} cups detected (${placed} placed)`;
          badge.className = 'cup-detect-badge detect-ok';
        }
      } else {
        if (badge) {
          badge.textContent = 'No cups detected \u2014 drag or click to place';
          badge.className = 'cup-detect-badge detect-warn';
        }
      }
    });
  };
  const rescanBtn = document.getElementById('btn-cup-rescan');
  if (rescanBtn) rescanBtn.onclick = runDetect;
  setTimeout(runDetect, 200);
}

function exitCupAdjust() {
  cupAdjustMode = false; cupDrag = null;
  cupClickMode = false; cupClickPlaced = { teamA:[], teamB:[] }; cupClickTeam = 'teamA';
  const canvas = document.getElementById('cal-canvas');
  canvas.removeEventListener('pointerdown', onCupPointerDown);
  canvas.removeEventListener('pointermove', onCupPointerMove);
  window.removeEventListener('pointerup', onCupPointerUp);
  canvas.removeEventListener('click', onCupClick);
  const controls = document.getElementById('cup-adjust-controls');
  if (controls) controls.classList.add('hidden');
  const clickBtn = document.getElementById('btn-cup-click');
  if (clickBtn) clickBtn.textContent = 'Click Cups';
  const hint = document.getElementById('cup-click-hint');
  if (hint) hint.textContent = '';
}

/* Pick the team whose rack centroid is nearest the pointer. */
function nearestRackSide(pt) {
  const cfg = window._cfg || {};
  const layout = Vision.setCupLayout(cfg.cupCount) || {};
  let best = 'teamA', bestD = Infinity;
  for (const side of ['teamA','teamB']) {
    const cups = layout[side] || [];
    if (!cups.length) continue;
    let cx=0, cy=0;
    for (const c of cups) { cx+=c.x; cy+=c.y; }
    cx/=cups.length; cy/=cups.length;
    const d = Math.hypot(pt.x-cx, pt.y-cy);
    if (d < bestD) { bestD = d; best = side; }
  }
  return best;
}

function onCupPointerDown(e) {
  if (!cupAdjustMode || cupClickMode) return;
  const canvas = document.getElementById('cal-canvas');
  const pt = canvasCoords(canvas, e);
  cupDrag = { side: nearestRackSide(pt), x: pt.x, y: pt.y };
}

function onCupPointerMove(e) {
  if (!cupAdjustMode || !cupDrag) return;
  const canvas = document.getElementById('cal-canvas');
  const pt = canvasCoords(canvas, e);
  Vision.nudgeCupRack(cupDrag.side, pt.x - cupDrag.x, pt.y - cupDrag.y);
  cupDrag.x = pt.x; cupDrag.y = pt.y;
}

function onCupPointerUp() { cupDrag = null; }

/* Click-to-place: user taps each cup position directly on the calibration canvas. */
function onCupClick(e) {
  if (!cupClickMode) return;
  const canvas = document.getElementById('cal-canvas');
  const pt = canvasCoords(canvas, e);
  const cfg = window._cfg || {};
  const count = cfg.cupCount || 10;
  if (cupClickTeam === 'teamA' && cupClickPlaced.teamA.length < count) {
    cupClickPlaced.teamA.push({ id: cupClickPlaced.teamA.length + 1, x: pt.x, y: pt.y, r: cupClickRadius });
    if (cupClickPlaced.teamA.length === count) cupClickTeam = 'teamB';
  } else if (cupClickTeam === 'teamB' && cupClickPlaced.teamB.length < count) {
    cupClickPlaced.teamB.push({ id: cupClickPlaced.teamB.length + 1, x: pt.x, y: pt.y, r: cupClickRadius });
  }
  updateCupClickHint();
}

function updateCupClickHint() {
  const hint = document.getElementById('cup-click-hint');
  if (!hint) return;
  const cfg = window._cfg || {};
  const count = cfg.cupCount || 10;
  if (!cupClickMode) { hint.textContent = ''; return; }
  const aCount = cupClickPlaced.teamA.length;
  const bCount = cupClickPlaced.teamB.length;
  if (aCount < count) {
    hint.textContent = `Team A: ${aCount}/${count} \u2014 tap each cup`;
  } else if (bCount < count) {
    hint.textContent = `Team B: ${bCount}/${count} \u2014 tap each cup`;
  } else {
    hint.textContent = `All ${count * 2} cups placed! Press Continue \u2192`;
  }
}

function drawClickOverlay(ctx) {
  const teams = [
    { side: 'teamA', color: 'rgba(88,166,255,0.85)' },
    { side: 'teamB', color: 'rgba(247,129,102,0.85)' }
  ];
  for (const { side, color } of teams) {
    for (const cup of cupClickPlaced[side] || []) {
      const r = cup.r || cupClickRadius;
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cup.x, cup.y, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.font = `bold ${Math.round(r * 0.7)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(cup.id), cup.x, cup.y);
      ctx.restore();
    }
  }
}

function proceedToBallCal() {
  const cfg = window._cfg || {};
  const count = cfg.cupCount || 10;
  if (cupClickMode && cupClickPlaced.teamA.length === count && cupClickPlaced.teamB.length === count) {
    Vision.setCupLayoutDirect({ teamA: cupClickPlaced.teamA, teamB: cupClickPlaced.teamB });
  }
  calPreviewActive = false;
  exitCupAdjust();
  document.getElementById('cal-canvas').removeEventListener('click', onCornerClick);
  Vision.stopCamera();
  startBallCal();
}

/* ─────────────────────────── BALL CALIBRATION ─────────────────────────── */
async function startBallCal() {
  ballSampled = false; pendingMask = false;
  showScreen('screen-calibrate-ball');
  document.getElementById('btn-start-game').disabled = true;
  document.getElementById('btn-start-game').textContent =
    state ? 'Resume Game →' : 'Start Game →';
  const infoEl = document.getElementById('hsv-info');
  infoEl.textContent = ''; infoEl.classList.remove('warn');
  document.getElementById('ball-sample-dot').classList.add('hidden');
  document.getElementById('mask-hint').classList.remove('hidden');
  // Sync the tolerance sliders to the current Vision tolerances (defaults or
  // restored config) so the UI and the matcher never disagree.
  const tol0 = Vision.hsvTol;
  document.getElementById('hue-tol').value = tol0.hue;
  document.getElementById('sat-tol').value = tol0.sat;
  document.getElementById('v-floor').value = tol0.valFloor;
  document.getElementById('hue-val').textContent = tol0.hue;
  document.getElementById('sat-val').textContent = tol0.sat;
  document.getElementById('v-val').textContent = tol0.valFloor;

  const video = document.getElementById('ball-video');
  const canvas = document.getElementById('ball-canvas');
  const maskCanvas = document.getElementById('ball-mask-canvas');
  Vision.init(video, canvas);
  const ok = await Vision.startCamera('environment');
  if (!ok) { alert('Camera error'); return; }
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;

  ballPreviewActive = true;
  const ctx = canvas.getContext('2d');
  const maskCtx = maskCanvas.getContext('2d');

  (function loop() {
    if (!ballPreviewActive) return;
    if (video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);

      if (ballSampled && Vision.ballHSV) {
        maskCanvas.width = canvas.width; maskCanvas.height = canvas.height;
        maskCtx.drawImage(video, 0, 0, maskCanvas.width, maskCanvas.height);
        applyMaskOverlay(maskCtx, maskCanvas);
      }
    }
    requestAnimationFrame(loop);
  })();

  canvas.addEventListener('click', onBallClick);

  document.getElementById('hue-tol').addEventListener('input', onTolChange);
  document.getElementById('sat-tol').addEventListener('input', onTolChange);
  document.getElementById('v-floor').addEventListener('input', onTolChange);

  document.getElementById('btn-resample').onclick = () => {
    ballSampled = false; pendingMask = false;
    Vision.ballHSV = null;
    document.getElementById('ball-sample-dot').classList.add('hidden');
    document.getElementById('hsv-info').textContent = '';
    document.getElementById('mask-hint').classList.remove('hidden');
    document.getElementById('btn-start-game').disabled = true;
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  };

  document.getElementById('btn-start-game').onclick = () => {
    ballPreviewActive = false;
    Vision.stopCamera();
    // Recalibrating mid-game must NOT wipe the score — only build a fresh
    // state when no game is in progress.
    if (!state) state = freshState(window._cfg);
    startGame();
  };
}

function applyMaskOverlay(ctx, canvas) {
  if (!Vision.ballHSV) return;
  try {
    const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    const d = img.data;
    // Use the EXACT matcher the tracker uses, so the green preview shows what
    // the game will actually detect (no drift between preview and tracking).
    for (let i=0;i<d.length;i+=4) {
      if (Vision.matchesBall(d[i], d[i+1], d[i+2])) {
        d[i]=0; d[i+1]=220; d[i+2]=60; d[i+3]=200;
      }
    }
    ctx.putImageData(img,0,0);
  } catch(e) {}
}

function onTolChange() {
  Vision.setHsvTol({
    hue: parseInt(document.getElementById('hue-tol').value),
    sat: parseInt(document.getElementById('sat-tol').value),
    valFloor: parseInt(document.getElementById('v-floor').value)
  });
  document.getElementById('hue-val').textContent = Vision.hsvTol.hue;
  document.getElementById('sat-val').textContent = Vision.hsvTol.sat;
  document.getElementById('v-val').textContent = Vision.hsvTol.valFloor;
  if (ballSampled) pendingMask = true;
}

function onBallClick(e) {
  const canvas = document.getElementById('ball-canvas');
  const {x, y} = canvasCoords(canvas, e);
  const hsv = Vision.sampleBallColor(x, y);
  if (!hsv) return;
  ballSampled = true; pendingMask = true;
  const info = document.getElementById('hsv-info');
  const pale = hsv.sat < 22;
  info.textContent =
    `Sampled: H=${hsv.hue.toFixed(0)}° S=${hsv.sat.toFixed(0)}% V=${hsv.val.toFixed(0)}%` +
    (pale ? ' — ⚠ pale/white ball is hard to isolate; an orange ball tracks far better' : '');
  info.classList.toggle('warn', pale);
  const dot = document.getElementById('ball-sample-dot');
  dot.style.left = e.clientX + 'px';
  dot.style.top = e.clientY + 'px';
  dot.classList.remove('hidden');
  document.getElementById('mask-hint').classList.add('hidden');
  document.getElementById('hsv-details').open = true;
  document.getElementById('btn-start-game').disabled = false;
}

/* ─────────────────────────── GAME ─────────────────────────── */
async function startGame() {
  showScreen('screen-game');

  // Reset fixed overlays that may linger from a previous game
  const chanBanner = document.getElementById('chandeliers-banner');
  if (chanBanner) chanBanner.classList.toggle('hidden', !state.isChandeliers);
  const islandBanner = document.getElementById('island-banner');
  if (islandBanner) islandBanner.classList.add('hidden');
  const btbBtn = document.getElementById('btb-btn');
  if (btbBtn) btbBtn.classList.add('hidden');
  const foulBar = document.getElementById('foul-confirm-bar');
  if (foulBar) foulBar.classList.add('hidden');
  const rebOverlay = document.getElementById('rebuttal-overlay');
  if (rebOverlay) rebOverlay.classList.toggle('hidden', !state.isRebuttal);
  if (state.isRebuttal) updateRebuttalUI();

  updateTeamPanels();
  renderRacks();
  renderEventLog();
  updateTurnIndicator();

  const video = document.getElementById('game-video');
  const canvas = document.getElementById('game-canvas');
  Vision.init(video, canvas);
  const ok = await Vision.startCamera('environment');
  if (ok) {
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    Vision.setCalibration(
      calCorners.length===4 ? calCorners : generateDefaultCorners(canvas),
      state.tableFt || 8
    );
    Vision.setCupLayout(state.cupCount);
    Vision.startTracking({
      onThrowStart, onSpeed, onMakeDetected, onFoulDetected
    }, getGameState);
    HandGesture.start(video); // Island call: 4-finger palm-toward-camera gesture
  }

  wireGameButtons();

  Commentary.fire('game_start', {
    player: shooterName(),
    defending: `Team ${state.shootingTeam==='A'?'B':'A'}`,
    team: `Team ${state.shootingTeam}`
  });

  saveState();
}

function generateDefaultCorners(canvas) {
  const w = canvas.width, h = canvas.height;
  const mg = 0.15;
  return [
    {x: w*mg,     y: h*(1-mg)},
    {x: w*(1-mg), y: h*(1-mg)},
    {x: w*mg,     y: h*mg},
    {x: w*(1-mg), y: h*mg}
  ];
}

function wireGameButtons() {
  document.getElementById('btn-mute').onclick = () => {
    state.muted = !state.muted;
    Commentary.setMuted(state.muted);
    document.getElementById('btn-mute').textContent = state.muted ? '🔇' : '🔊';
  };

  document.getElementById('btn-recalibrate').onclick = () => {
    Vision.stopTracking(); Vision.stopCamera(); HandGesture.stop();
    startCalCorners();
  };

  document.getElementById('btn-confirm-penalty').onclick = confirmPenalty;
  document.getElementById('btn-dismiss-foul').onclick = dismissFoul;
  document.getElementById('btn-toggle-no').onclick = () =>
    document.getElementById('toggle-modal').classList.add('hidden');

  const passBtn = document.getElementById('btn-pass-turn');
  if (passBtn) passBtn.onclick = () => afterShotHappened(false);

  const rebMissBtn = document.getElementById('btn-rebuttal-miss');
  if (rebMissBtn) rebMissBtn.onclick = () => afterShotHappened(false);
  const rebMakeBtn = document.getElementById('btn-rebuttal-make');
  if (rebMakeBtn) rebMakeBtn.onclick = scoreRebuttalMake;

  const dismissIsland = document.getElementById('btn-dismiss-island');
  if (dismissIsland) dismissIsland.onclick = () => {
    const b = document.getElementById('island-banner');
    if (b) b.classList.add('hidden');
  };
}

/* ── Vision Callbacks ── */
function onThrowStart() {
  const overlay = document.getElementById('speed-overlay');
  if (overlay) overlay.style.display = 'none';
}

function onSpeed(mph) {
  const t = state.shootingTeam;
  const shooter = shooterName();
  ensureStats(shooter);
  const isRecord = mph > (state.fastest[t] || 0);
  if (isRecord) {
    state.fastest[t] = mph;
    state.playerStats[shooter].fastest = Math.max(state.playerStats[shooter].fastest, mph);
  }
  // Show speed for EVERY throw, not just new records.
  const overlay = document.getElementById('speed-overlay');
  if (overlay) {
    overlay.innerHTML = `${mph.toFixed(1)} <span class="speed-unit">mph</span>` +
      (isRecord ? ` <span class="speed-pb">PB</span>` : '');
    overlay.classList.toggle('is-record', isRecord);
    overlay.style.display = 'block';
    clearTimeout(overlay._t);
    overlay._t = setTimeout(() => { overlay.style.display='none'; }, 5000);
  }
  updateTeamPanels();
  if (isRecord) {
    Commentary.fire('speed', { player:shooter, speed:mph,
      defending:`Team ${t==='A'?'B':'A'}` });
  }
  saveState();
}

function onMakeDetected(detection) {
  const { cup, confidence, team } = detection;
  const teamKey = team;
  const cupObj = (state.cups[teamKey]||[]).find(c=>c.id===cup.id);

  // Same-cup bonus in 2v2: second shooter sinks the same cup first shooter made
  if (cupObj && cupObj.made && state.mode === '2v2' &&
      state.shooterIndex[state.shootingTeam] === 1 &&
      state.turnFirstCupId === cup.id) {
    triggerSameCupBonus(teamKey);
    return;
  }

  if (!cupObj || cupObj.made) return;

  if (confidence === 'high') {
    autoScoreCup(teamKey, cup.id);
  } else {
    showUncertainPrompt(teamKey, cup.id);
  }
}

function onFoulDetected({ player }) {
  state.pendingFoul = { player };
  showFoulBanner(player);
  Commentary.fire('foul', { player, defending:`Team ${state.shootingTeam}` });
  saveState();
}

/* ─────────────────────────── SCORING ─────────────────────────── */
function autoScoreCup(teamKey, cupId) {
  const cup = (state.cups[teamKey]||[]).find(c=>c.id===cupId);
  if (!cup || cup.made) return;

  // Chandeliers: top cup (id 4, shown as ★) must be made before bottom cups 1–3
  if (state.isChandeliers && cupId !== 4 && !state.chandeliersTopMade[teamKey]) {
    addEvent(`🕯️ Make the top cup (★) first!`, 'warning');
    return;
  }
  if (state.isChandeliers && cupId === 4) state.chandeliersTopMade[teamKey] = true;

  const shooter = shooterName();
  ensureStats(shooter);
  cup.made = true;
  cup.madeBy = shooter;
  state.playerStats[shooter].made++;
  state.makesThisTurn++;
  state.consecutiveMisses[state.shootingTeam] = 0;

  // Track per-player makes for fire-streak calculation at turn boundary
  state.turnMakesPerPlayer = state.turnMakesPerPlayer || {};
  state.turnMakesPerPlayer[shooter] = (state.turnMakesPerPlayer[shooter] || 0) + 1;

  // Remember first cup ID for same-cup detection in 2v2
  if (state.mode === '2v2' && state.shooterIndex[state.shootingTeam] === 0 && !state.turnFirstCupId) {
    state.turnFirstCupId = cupId;
  }

  // Rule: fire resets for the defending team when they are scored on
  const defenderTeamLetter = teamKey === 'teamA' ? 'A' : 'B';
  const defPlayers = state.players[defenderTeamLetter] || [];
  for (const dp of defPlayers) {
    if ((state.fireStreak[dp]||0) > 0) {
      state.fireStreak[dp] = 0;
    }
  }
  if (state.onFire[defenderTeamLetter]) {
    state.onFire[defenderTeamLetter] = null;
  }

  // Island call bonus: if shooter called island on THIS cup, score 1 extra cup
  state.pendingIslandCall = state.pendingIslandCall || null;
  if (state.pendingIslandCall && state.pendingIslandCall.player === shooter) {
    if (cupId === state.pendingIslandCall.cupId) {
      const bonusCup = (state.cups[teamKey]||[]).find(c => !c.made);
      if (bonusCup) {
        bonusCup.made = true; bonusCup.madeBy = shooter;
        if (state.playerStats[shooter]) state.playerStats[shooter].made++;
        addEvent(`🏝 ISLAND! ${shooter} called it — 2 cups!`, 'island');
        Commentary.fire('island', { player: shooter });
      }
    }
    state.pendingIslandCall = null; // Always clear after shooter's cup event
  }

  const teamLetter = defenderTeamLetter;
  const remaining = (state.cups[teamKey]||[]).filter(c=>!c.made).length;

  const undoFn = () => {
    cup.made = false; cup.madeBy = null;
    if (state.playerStats[shooter]) state.playerStats[shooter].made = Math.max(0, state.playerStats[shooter].made-1);
    state.makesThisTurn = Math.max(0, state.makesThisTurn-1);
    state.turnMakesPerPlayer = state.turnMakesPerPlayer || {};
    state.turnMakesPerPlayer[shooter] = Math.max(0, (state.turnMakesPerPlayer[shooter]||1)-1);
    updateCupCount(); renderRacks(); updateTeamPanels(); saveState();
  };

  addEvent(`🏆 ${shooter} → Cup ${cupId} (Team ${teamLetter})`, 'make', undoFn);
  showMakeToast(cupId, undoFn);
  updateCupCount(); renderRacks(); updateTeamPanels();

  Commentary.fire('make', {
    player:shooter, defending:`Team ${teamLetter}`, cupId,
    lastCup: remaining===0, oneCupLeft: remaining===1,
    twoCupsLeft: remaining===2, threeCupsLeft: remaining===3
  });

  saveState();

  // Check win condition (triggers rebuttal if needed); if not game-over, auto-advance shot
  const gameOver = checkWinCondition(teamKey);
  if (!gameOver) afterShotHappened(true);
}

/* ── Same-cup bonus ── */
function triggerSameCupBonus(teamKey) {
  const shooter = shooterName();
  ensureStats(shooter);

  // Remove 2 extra cups from the rack
  const remaining = (state.cups[teamKey]||[]).filter(c=>!c.made);
  const n = Math.min(2, remaining.length);
  for (let i=0; i<n; i++) {
    remaining[i].made = true;
    remaining[i].madeBy = shooter;
    state.playerStats[shooter].made++;
  }
  state.makesThisTurn += n;
  state.turnMakesPerPlayer = state.turnMakesPerPlayer || {};
  state.turnMakesPerPlayer[shooter] = (state.turnMakesPerPlayer[shooter] || 0) + n;

  const teamLetter = teamKey==='teamA'?'A':'B';
  addEvent(`🎯🎯 SAME CUP! ${shooter} sinks partner's cup — 3 total removed from Team ${teamLetter}!`, 'same-cup');
  Commentary.fire('same_cup', { player: shooter, team:`Team ${teamLetter}` });
  updateCupCount(); renderRacks(); updateTeamPanels(); saveState();

  const gameOver = checkWinCondition(teamKey);
  if (!gameOver) afterShotHappened(true);
}

/* ── Win / Rebuttal ── */
function checkWinCondition(teamKey) {
  if (state.isRebuttal) return false; // During rebuttal handled in handleRebuttalShot
  const remaining = (state.cups[teamKey]||[]).filter(c=>!c.made).length;
  if (remaining === 0) {
    const attacker = state.shootingTeam;
    const defender = attacker==='A'?'B':'A';
    if (state.isChandeliers) {
      // In chandeliers, no further rebuttal — direct win
      Vision.stopTracking(); Vision.stopCamera();
      clearSaved();
      setTimeout(() => showWinScreen(attacker, defender), 600);
      return true;
    }
    startRebuttal(attacker, defender, teamKey);
    return true;
  }
  return false;
}

function startRebuttal(attacker, defender, teamKey) {
  state.isRebuttal = true;
  state.rebuttalTeam = defender;
  state.rebuttalShotsLeft = state.mode==='2v2' ? 2 : 1;
  state.rebuttalMakes = 0;

  // Defender now shoots
  state.shootingTeam = defender;
  state.shooterIndex[defender] = 0;

  const shots = state.rebuttalShotsLeft;
  const overlay = document.getElementById('rebuttal-overlay');
  if (overlay) overlay.classList.remove('hidden');
  updateRebuttalUI();

  addEvent(`⚡ REBUTTAL! ${teamDisplayName(defender)} gets ${shots} shot${shots!==1?'s':''}!`, 'rebuttal');
  Commentary.fire('rebuttal', { team: teamDisplayName(defender), player: state.players[defender][0] });
  updateTurnIndicator(); updateTeamPanels(); saveState();
}

function handleRebuttalShot(wasMake) {
  const defender = state.rebuttalTeam;

  if (wasMake) {
    state.rebuttalMakes++;
    // If attacker's rack is now empty too → both at 0 → Chandeliers overtime
    const attacker = defender==='A'?'B':'A';
    const attackerKey = attacker==='A'?'teamA':'teamB';
    if ((state.cups[attackerKey]||[]).filter(c=>!c.made).length === 0) {
      startChandeliers();
      return;
    }
  }
  state.rebuttalShotsLeft--;

  if (state.rebuttalShotsLeft > 0 && state.mode==='2v2') {
    state.shooterIndex[defender] = 1;
    updateRebuttalUI();
    updateTurnIndicator(); saveState();
    return;
  }

  endRebuttal();
}

function updateRebuttalUI() {
  const defender = state.rebuttalTeam;
  if (!defender) return;
  const idx = state.mode==='2v2' ? state.shooterIndex[defender] : 0;
  const shooterEl = document.getElementById('rebuttal-shooter');
  if (shooterEl) shooterEl.textContent = `${state.players[defender][idx]||'P'+(idx+1)} — shoot now!`;
  const shots = state.rebuttalShotsLeft;
  const shotsEl = document.getElementById('rebuttal-shots-left');
  if (shotsEl) shotsEl.textContent = `${shots} shot${shots!==1?'s':''} left`;
}

/* Manual fallback for a rebuttal make when auto-detection misses it: score the
   first open cup on the attacker's rack, which routes through autoScoreCup →
   afterShotHappened → handleRebuttalShot exactly like a vision-detected make. */
function scoreRebuttalMake() {
  if (!state || !state.isRebuttal) return;
  const attacker = state.rebuttalTeam==='A' ? 'B' : 'A';
  const attackerKey = attacker==='A' ? 'teamA' : 'teamB';
  const target = (state.cups[attackerKey]||[]).find(c=>!c.made);
  if (!target) { afterShotHappened(true); return; }
  autoScoreCup(attackerKey, target.id);
}

function endRebuttal() {
  const defender = state.rebuttalTeam;
  const attacker = defender==='A'?'B':'A';
  const made = state.rebuttalMakes;

  state.isRebuttal = false;
  state.rebuttalTeam = null;
  state.rebuttalShotsLeft = 0;
  state.rebuttalMakes = 0;

  const overlay = document.getElementById('rebuttal-overlay');
  if (overlay) overlay.classList.add('hidden');

  if (made > 0) {
    // Restore cups to the defender's rack (1 cup per rebuttal make)
    const defKey = defender==='A'?'teamA':'teamB';
    const defCups = state.cups[defKey]||[];
    let restored = 0;
    for (let i = defCups.length-1; i >= 0 && restored < made; i--) {
      if (defCups[i].made) {
        const maker = defCups[i].madeBy;
        if (maker && state.playerStats[maker]) {
          state.playerStats[maker].made = Math.max(0, state.playerStats[maker].made-1);
        }
        defCups[i].made = false;
        defCups[i].madeBy = null;
        restored++;
      }
    }
    addEvent(`💥 Rebuttal! ${teamDisplayName(defender)} stays alive — ${restored} cup${restored!==1?'s':''} back!`, 'rebuttal');
    Commentary.fire('rebuttal_success', { team: teamDisplayName(defender) });
    state.shootingTeam = attacker;
    state.shooterIndex[attacker] = 0;
    state.makesThisTurn = 0;
    state.turnMakesPerPlayer = {};
    state.turnFirstCupId = null;
    addEvent(`➡️ Turn: Team ${attacker}`, 'turn');
    updateTurnIndicator(); updateTeamPanels(); renderRacks(); saveState();
  } else {
    // Rebuttal failed — attacker wins
    Vision.stopTracking(); Vision.stopCamera();
    clearSaved();
    setTimeout(() => showWinScreen(attacker, defender), 600);
  }
}

/* ── Chandeliers Overtime ── */
function startChandeliers() {
  // Clear rebuttal state
  state.isRebuttal = false;
  state.rebuttalTeam = null;
  state.rebuttalShotsLeft = 0;
  state.rebuttalMakes = 0;
  const overlay = document.getElementById('rebuttal-overlay');
  if (overlay) overlay.classList.add('hidden');

  // Reset both racks to 4-cup chandelier pyramid
  state.isChandeliers = true;
  state.chandeliersTopMade = {teamA: false, teamB: false};
  const makeChanCups = () => [
    {id:1,made:false,madeBy:null},{id:2,made:false,madeBy:null},
    {id:3,made:false,madeBy:null},{id:4,made:false,madeBy:null}
  ];
  state.cups.teamA = makeChanCups();
  state.cups.teamB = makeChanCups();

  // Reset turn/fire/island state — Team A shoots first
  state.shootingTeam = 'A';
  state.shooterIndex = {A:0, B:0};
  state.makesThisTurn = 0;
  state.turnMakesPerPlayer = {};
  state.turnFirstCupId = null;
  state.onFire = {A:null, B:null};
  state.fireStreak = {};
  state.pendingIslandCall = null;

  // Hide island and BTB banners — they don't apply in chandeliers
  const islandBanner = document.getElementById('island-banner');
  if (islandBanner) islandBanner.classList.add('hidden');
  const btbBtn = document.getElementById('btb-btn');
  if (btbBtn) btbBtn.classList.add('hidden');
  const chanBanner = document.getElementById('chandeliers-banner');
  if (chanBanner) chanBanner.classList.remove('hidden');

  addEvent('🕯️ CHANDELIERS! Overtime — top cup (★) first, pull cup, no rebounds!', 'chandeliers');
  Commentary.fire('chandeliers', {});
  updateCupCount(); renderRacks(); updateTeamPanels(); updateTurnIndicator(); saveState();
}

function findLoneCupId(teamKey) {
  const cups = state.cups[teamKey]||[];
  const remaining = cups.filter(c=>!c.made);
  if (remaining.length === 1) return remaining[0].id;
  const positions = cups.length===10 ? CUP_POSITIONS_10 : cups.length===4 ? CUP_POSITIONS_CHANDELIERS : CUP_POSITIONS_6;
  const THRESH = 48;
  for (const cup of remaining) {
    const pos = positions.find(p=>p.id===cup.id);
    if (!pos) continue;
    const hasNeighbor = remaining.some(other => {
      if (other.id===cup.id) return false;
      const oPos = positions.find(p=>p.id===other.id);
      if (!oPos) return false;
      return Math.hypot(pos.cx-oPos.cx, pos.cy-oPos.cy) < THRESH;
    });
    if (!hasNeighbor) return cup.id;
  }
  return null;
}

/* ── Central shot handler ── */
function afterShotHappened(wasMake) {
  if (!state) return;

  // Route rebuttal shots separately
  if (state.isRebuttal) { handleRebuttalShot(wasMake); return; }

  const t = state.shootingTeam;
  const shooter = shooterName();

  if (!wasMake) {
    // Miss: reset fire streak for this player, end fire if active
    state.fireStreak = state.fireStreak || {};
    state.fireStreak[shooter] = 0;
    if (state.onFire[t] === shooter) {
      addEvent(`💨 ${shooter}'s fire is out!`, 'fire-end');
      Commentary.fire('fire_end', { player: shooter });
      state.onFire[t] = null;
    }
    // Clear pending island call on miss (shooter didn't attempt the called cup)
    if (state.pendingIslandCall && state.pendingIslandCall.player === shooter) {
      state.pendingIslandCall = null; renderRacks();
    }
    // Behind-the-back not available in chandeliers (no rebounds rule)
    if (!state.isChandeliers) {
      const defendingKey = t==='A' ? 'teamB' : 'teamA';
      showBehindBackButton(shooter, defendingKey);
    }
  }

  // Fire player keeps shooting on makes
  if (wasMake && state.onFire[t] === shooter) {
    updateTurnIndicator(); updateTeamPanels(); saveState();
    return;
  }

  // 2v2: advance first shooter to second before full turn flip
  if (state.mode==='2v2' && state.shooterIndex[t]===0) {
    state.shooterIndex[t] = 1;
    // Check fire for second shooter at their sub-turn start
    const secondShooter = state.players[t][1];
    if (secondShooter && (state.fireStreak[secondShooter]||0) >= 3 && !state.onFire[t]) {
      state.onFire[t] = secondShooter;
      addEvent(`🔥 ${secondShooter} is ON FIRE! Shoot until you miss!`, 'fire');
      Commentary.fire('fire', { player: secondShooter });
    }
    updateTurnIndicator(); updateTeamPanels(); saveState();
    checkIslandReminder(); // Notify shooter 1 if opponent has lone cup they can call
    return;
  }

  // Full team turn flip
  advanceTurn('auto');
}

/* ── Turn advancement ── */
function advanceTurn(source) {
  const gs = state;
  const outgoingT = gs.shootingTeam;

  // Balls-back check
  if (gs.ballsBack && gs.mode === '2v2' && !gs.isChandeliers && gs.makesThisTurn >= 2 && !gs.isRebuttal) {
    gs.makesThisTurn = 0;
    gs.turnMakesPerPlayer = {};
    gs.turnFirstCupId = null;
    gs.shooterIndex[outgoingT] = 0;
    gs.onFire[outgoingT] = null;
    addEvent(`🔄 Balls back — Team ${outgoingT} shoots again!`, 'balls-back');
    Commentary.fire('balls_back', { team:`Team ${outgoingT}`, player:shooterName() });
    updateTurnIndicator(); updateTeamPanels(); saveState(); return;
  }

  // Miss streak commentary — a turn with any make is not a miss
  if (gs.makesThisTurn > 0) gs.consecutiveMisses[outgoingT] = 0;
  else gs.consecutiveMisses[outgoingT]++;
  if (gs.consecutiveMisses[outgoingT] >= 3) {
    Commentary.fire('miss_streak', { player:shooterName(), defending:`Team ${outgoingT==='A'?'B':'A'}`, missStreak:true });
  }

  // Update fire streaks at real turn boundary (once per real turn per player)
  gs.fireStreak = gs.fireStreak || {};
  const outgoingPlayers = gs.mode==='2v2'
    ? [gs.players[outgoingT][0], gs.players[outgoingT][1]].filter(Boolean)
    : [gs.players[outgoingT][0]].filter(Boolean);
  for (const p of outgoingPlayers) {
    const madeAny = (gs.turnMakesPerPlayer[p]||0) > 0;
    gs.fireStreak[p] = madeAny ? (gs.fireStreak[p]||0)+1 : 0;
  }

  // End fire for outgoing team
  gs.onFire[outgoingT] = null;

  // Flip team
  gs.makesThisTurn = 0;
  gs.turnMakesPerPlayer = {};
  gs.turnFirstCupId = null;
  gs.shooterIndex[outgoingT] = 0;
  gs.shootingTeam = outgoingT==='A'?'B':'A';
  gs.shooterIndex[gs.shootingTeam] = 0;

  // Check fire for incoming first shooter (activates at real turn start)
  const incomingFirst = gs.players[gs.shootingTeam][0];
  if (incomingFirst && (gs.fireStreak[incomingFirst]||0) >= 3) {
    gs.onFire[gs.shootingTeam] = incomingFirst;
    addEvent(`🔥 ${incomingFirst} is ON FIRE! Shoot until you miss!`, 'fire');
    Commentary.fire('fire', { player: incomingFirst });
  }

  // Island reminder
  checkIslandReminder();

  addEvent(`➡️ Turn: Team ${gs.shootingTeam}`, 'turn');
  updateTurnIndicator();
  updateTeamPanels(); saveState();
}

/* ── Behind the Back ── */
function showBehindBackButton(missingPlayer, defendingKey) {
  const btn = document.getElementById('btb-btn');
  if (!btn) return;
  btn.classList.remove('hidden');
  clearTimeout(btn._t);
  btn.onclick = () => {
    btn.classList.add('hidden');
    scoreBehindBack(missingPlayer, defendingKey);
  };
  btn._t = setTimeout(() => btn.classList.add('hidden'), 5000);
}

function scoreBehindBack(player, defendingKey) {
  const allCups = state.cups[defendingKey]||[];
  const remaining = allCups.filter(c=>!c.made);
  if (remaining.length === 0) return;
  // Pick the 2 cups nearest to the centroid of the remaining rack (most accessible)
  const positions = allCups.length===10 ? CUP_POSITIONS_10 : CUP_POSITIONS_6;
  const posMap = Object.fromEntries(positions.map(p=>[p.id, p]));
  const cx = remaining.reduce((s,c)=>(posMap[c.id]?.cx||0)+s,0)/remaining.length;
  const cy = remaining.reduce((s,c)=>(posMap[c.id]?.cy||0)+s,0)/remaining.length;
  const sorted = remaining.slice().sort((a,b)=>{
    const pa = posMap[a.id]||{cx:0,cy:0}, pb = posMap[b.id]||{cx:0,cy:0};
    return Math.hypot(pa.cx-cx,pa.cy-cy) - Math.hypot(pb.cx-cx,pb.cy-cy);
  });
  const picks = sorted.slice(0, Math.min(2, sorted.length));
  const n = picks.length;
  ensureStats(player);
  for (let i=0; i<n; i++) {
    picks[i].made = true;
    picks[i].madeBy = player;
    state.playerStats[player].made++;
  }
  const teamLetter = defendingKey==='teamA'?'A':'B';
  addEvent(`🤙 BEHIND THE BACK! ${player} banks 2 cups from Team ${teamLetter}!`, 'btb');
  Commentary.fire('btb', { player, team:`Team ${teamLetter}` });
  updateCupCount(); renderRacks(); updateTeamPanels(); saveState();
  checkWinCondition(defendingKey);
}

/* ── Island reminder ── */
function hasLoneCup(teamKey) {
  const cups = state.cups[teamKey]||[];
  const remaining = cups.filter(c=>!c.made);
  if (remaining.length === 0) return false;
  if (remaining.length === 1) return true;
  const positions = cups.length===10 ? CUP_POSITIONS_10 : cups.length===4 ? CUP_POSITIONS_CHANDELIERS : CUP_POSITIONS_6;
  const THRESH = 48;
  for (const cup of remaining) {
    const pos = positions.find(p=>p.id===cup.id);
    if (!pos) continue;
    const hasNeighbor = remaining.some(other => {
      if (other.id===cup.id) return false;
      const oPos = positions.find(p=>p.id===other.id);
      if (!oPos) return false;
      return Math.hypot(pos.cx-oPos.cx, pos.cy-oPos.cy) < THRESH;
    });
    if (!hasNeighbor) return true;
  }
  return false;
}

function checkIslandReminder() {
  if (state.isChandeliers) return; // No island rule in chandeliers overtime
  const t = state.shootingTeam;
  const myKey  = t==='A' ? 'teamA' : 'teamB';
  const oppKey = t==='A' ? 'teamB' : 'teamA';
  const myHas  = hasLoneCup(myKey);   // own lone cup → remind to move
  const oppHas = hasLoneCup(oppKey);  // opp lone cup → can call island

  const banner = document.getElementById('island-banner');
  if (!banner) return;
  if (!myHas && !oppHas) { banner.classList.add('hidden'); return; }

  let msg = '';
  if (myHas && oppHas)  msg = '🏝 Lone cups on both sides — move to center!';
  else if (myHas)       msg = `🏝 Your rack has a lone cup — move to center!`;
  else                  msg = '🏝 Opponent has a lone cup!';

  const textEl = banner.querySelector('#island-text');
  if (textEl) textEl.textContent = msg;

  // Show "Call Island" button if opponent's rack has lone cup and shooter hasn't used their call
  const callBtn = document.getElementById('btn-call-island');
  if (callBtn) {
    const shooter = shooterName();
    const islandUsed = (state.islandCallsUsed||{})[shooter];
    const canCall = oppHas && !islandUsed && !state.pendingIslandCall;
    callBtn.classList.toggle('hidden', !canCall);
    if (canCall) {
      const loneCupId = findLoneCupId(oppKey);
      callBtn.onclick = () => {
        state.islandCallsUsed = state.islandCallsUsed || {};
        state.islandCallsUsed[shooter] = true;
        state.pendingIslandCall = { player: shooter, cupId: loneCupId, teamKey: oppKey };
        addEvent(`🏝 ${shooter} calls ISLAND on Cup ${loneCupId}!`, 'island');
        Commentary.fire('island_call', { player: shooter });
        banner.classList.add('hidden');
        renderRacks(); saveState();
      };
    }
  }

  banner.classList.remove('hidden');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => banner.classList.add('hidden'), 10000);
}

/* ── Hand gesture callback: island call ── */
function onIslandGesture() {
  if (!state) return;
  if (state.isChandeliers) return;    // no island in chandeliers overtime
  if (state.isRebuttal)    return;    // no island during rebuttal
  const shooter = shooterName();
  if ((state.islandCallsUsed||{})[shooter]) return; // already used this game
  const t      = state.shootingTeam;
  const oppKey = t === 'A' ? 'teamB' : 'teamA';
  if (!hasLoneCup(oppKey)) return;    // no lone cup to call on
  const loneCupId = findLoneCupId(oppKey);
  if (!loneCupId) return;
  // Register the island call
  state.islandCallsUsed = state.islandCallsUsed || {};
  state.islandCallsUsed[shooter] = true;
  state.pendingIslandCall = { player: shooter, cupId: loneCupId, teamKey: oppKey };
  addEvent(`🏝 ${shooter} calls ISLAND on Cup ${loneCupId}! (gesture)`, 'island');
  Commentary.fire('island_call', { player: shooter });
  const banner = document.getElementById('island-banner');
  if (banner) banner.classList.add('hidden');
  showGestureToast(`🏝 Island! Cup ${loneCupId}`);
  renderRacks(); saveState();
}

// hands.js invokes this via window when the 4-finger island gesture is held
window.onIslandGesture = onIslandGesture;

function showGestureToast(msg) {
  let toast = document.getElementById('gesture-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'gesture-toast';
    toast.className = 'gesture-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
}

/* ── Uncertain prompt ── */
function showUncertainPrompt(teamKey, cupId) {
  const teamLetter = teamKey==='teamA'?'A':'B';
  const toast = document.getElementById('uncertain-toast');
  toast.innerHTML = `❓ Cup ${cupId} (Team ${teamLetter}) — did it go in?
    <button id="unc-yes">Yes ✓</button>
    <button id="unc-no">Miss ✗</button>`;
  toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('hidden'), 15000);
  document.getElementById('unc-yes').onclick = () => {
    autoScoreCup(teamKey, cupId);
    toast.classList.add('hidden');
  };
  document.getElementById('unc-no').onclick = () => {
    toast.classList.add('hidden');
    afterShotHappened(false);
  };
}

function showMakeToast(cupId, undoFn) {
  const toast = document.getElementById('make-toast');
  toast.innerHTML = `✅ CUP ${cupId} — AUTO DETECTED <button class="undo-btn">Undo</button>`;
  toast.classList.remove('hidden');
  toast.querySelector('.undo-btn').onclick = () => {
    undoFn();
    toast.classList.add('hidden');
    renderEventLog();
  };
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('hidden'), 3000);
}

/* ── Foul handling ── */
function showFoulBanner(player) {
  const bar = document.getElementById('foul-confirm-bar');
  document.getElementById('foul-confirm-text').textContent = `⚠️ Elbow foul: ${player}`;
  bar.classList.remove('hidden');
  clearTimeout(bar._t);
  bar._t = setTimeout(dismissFoul, 8000);
  Vision.flashFoulLine(3000);
}

function confirmPenalty() {
  if (!state.pendingFoul) return;
  const t = state.shootingTeam, shooter = state.pendingFoul.player;
  state.penalties[t]++;
  ensureStats(shooter);
  state.playerStats[shooter].penalties++;
  addEvent(`⚠️ Penalty: ${shooter}`, 'foul');
  if (state.strictFoul) addEvent('🚫 Shot nullified (strict foul)', 'foul');
  dismissFoul();
  updateTeamPanels(); saveState();
}

function dismissFoul() {
  state.pendingFoul = null;
  document.getElementById('foul-confirm-bar').classList.add('hidden');
}

/* ── Team panels ── */
function updateTeamPanels() {
  if (!state) return;
  const nameA = teamDisplayName('A');
  const nameB = teamDisplayName('B');
  document.getElementById('team-a-name').textContent = nameA;
  document.getElementById('team-b-name').textContent = nameB;

  const aLeft = (state.cups.teamA||[]).filter(c=>!c.made).length;
  const bLeft = (state.cups.teamB||[]).filter(c=>!c.made).length;
  document.getElementById('cups-a').textContent = aLeft;
  document.getElementById('cups-b').textContent = bLeft;
  document.getElementById('penalties-a').textContent = state.penalties.A||0;
  document.getElementById('penalties-b').textContent = state.penalties.B||0;
  document.getElementById('fastest-a').textContent = state.fastest.A>0 ? state.fastest.A.toFixed(1)+' mph' : '—';
  document.getElementById('fastest-b').textContent = state.fastest.B>0 ? state.fastest.B.toFixed(1)+' mph' : '—';

  renderPlayerRows('A'); renderPlayerRows('B');

  document.getElementById('panel-team-a').style.boxShadow =
    state.shootingTeam==='A' ? 'inset 0 0 0 2px var(--yellow)' : '';
  document.getElementById('panel-team-b').style.boxShadow =
    state.shootingTeam==='B' ? 'inset 0 0 0 2px var(--yellow)' : '';
}

function teamDisplayName(t) {
  if (state.mode==='1v1') return state.players[t][0]||`Team ${t}`;
  return (state.players[t][0]||`${t}1`) + ' & ' + (state.players[t][1]||`${t}2`);
}

function renderPlayerRows(team) {
  const el = document.getElementById('players-'+team.toLowerCase());
  if (!el) return;
  el.innerHTML = '';
  const count = state.mode==='2v2'?2:1;
  for (let i=0;i<count;i++) {
    const name = state.players[team][i]||`P${i+1}`;
    ensureStats(name);
    const s = state.playerStats[name];
    const shooting = state.shootingTeam===team && (state.mode==='1v1'||state.shooterIndex[team]===i);
    const onFire = state.onFire && state.onFire[team]===name;
    const row = document.createElement('div');
    row.className = 'player-row'+(shooting?' shooting':'')+(onFire?' on-fire':'');
    const icon = onFire ? '🔥 ' : (shooting ? '🎯 ' : '');
    row.innerHTML = `<div class="player-row-name">${icon}${name}</div>
      <div class="player-row-stats"><span class="made">${s.made}</span> cups · ${s.fastest>0?s.fastest.toFixed(1)+' mph':'—'}</div>`;
    el.appendChild(row);
  }
}

function updateCupCount() {
  if (!state) return;
  document.getElementById('cups-a').textContent = (state.cups.teamA||[]).filter(c=>!c.made).length;
  document.getElementById('cups-b').textContent = (state.cups.teamB||[]).filter(c=>!c.made).length;
}

function updateTurnIndicator() {
  const el = document.getElementById('turn-indicator');
  if (el && state) {
    const name = shooterName();
    const onFire = state.onFire && state.onFire[state.shootingTeam]===name;
    const icon = onFire ? '🔥' : '🎯';
    el.textContent = `${icon} ${name}'s turn${onFire ? ' — FIRE!' : ''}`;
    el.style.color = state.shootingTeam==='A' ? 'var(--team-a)' : 'var(--team-b)';
    if (onFire) el.style.animation = 'fire-indicator 0.6s ease-in-out infinite alternate';
    else el.style.animation = '';
  }
}

/* ── Cup Racks (SVG) ── */
function renderRacks() {
  if (!state) return;
  ['a','b'].forEach(t => {
    const teamKey = t==='a'?'teamA':'teamB';
    const el = document.getElementById('rack-'+t);
    if (!el) return;
    el.innerHTML = buildRackSVG(teamKey, state.cups[teamKey], t==='a'?'var(--team-a)':'var(--team-b)');
    el.querySelectorAll('[data-cup-id]').forEach(node => {
      node.addEventListener('click', () => {
        const id = parseInt(node.dataset.cupId);
        if (id) openToggleModal(teamKey, id);
      });
    });
  });
}

function buildRackSVG(teamKey, cups, color) {
  const n = cups.length;
  const positions = n===10 ? CUP_POSITIONS_10 : n===4 ? CUP_POSITIONS_CHANDELIERS : CUP_POSITIONS_6;
  const svgW = n===10?165:n===4?120:135, svgH = n===10?150:n===4?100:120, R=16;
  // Chandeliers: top not yet made → lock bottom cups visually
  const topLocked = state && state.isChandeliers && !state.chandeliersTopMade[teamKey];
  // Island call: highlight called cup with golden ring
  const islandCupId = state && state.pendingIslandCall && state.pendingIslandCall.teamKey === teamKey
    ? state.pendingIslandCall.cupId : null;
  let out = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`;
  for (const {id, cx, cy} of positions) {
    const cup = cups.find(c=>c.id===id);
    const made = cup?.made;
    if (made) {
      out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#2d2d2d" stroke="#555" stroke-width="1.5" data-cup-id="${id}" style="cursor:pointer"/>`;
      out += `<line x1="${cx-9}" y1="${cy-9}" x2="${cx+9}" y2="${cy+9}" stroke="#f85149" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`;
      out += `<line x1="${cx+9}" y1="${cy-9}" x2="${cx-9}" y2="${cy+9}" stroke="#f85149" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`;
    } else {
      const isTop = n===4 && id===4;
      const isLocked = topLocked && !isTop;
      const fillOp = isLocked ? '0.35' : '0.85';
      const strokeColor = isTop && topLocked ? '#ffd700' : color;
      const strokeW = isTop && topLocked ? '3' : '1.5';
      const label = isTop && topLocked ? '★' : String(id);
      out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}" fill-opacity="${fillOp}" stroke="${strokeColor}" stroke-width="${strokeW}" data-cup-id="${id}" style="cursor:pointer"/>`;
      out += `<text x="${cx}" y="${cy+5}" text-anchor="middle" font-size="11" font-weight="bold" fill="#000" pointer-events="none">${label}</text>`;
      // Island call indicator: dashed golden ring
      if (id === islandCupId) {
        out += `<circle cx="${cx}" cy="${cy}" r="${R+5}" fill="none" stroke="#ffd700" stroke-width="2.5" stroke-dasharray="5 3" pointer-events="none"/>`;
      }
    }
  }
  out += '</svg>';
  return out;
}

/* ── Toggle modal ── */
function openToggleModal(teamKey, cupId) {
  const cup = (state.cups[teamKey]||[]).find(c=>c.id===cupId);
  if (!cup) return;
  const teamLetter = teamKey==='teamA'?'A':'B';
  const action = cup.made ? 'Restore' : 'Mark as made';
  document.getElementById('toggle-modal-title').textContent = `${action}?`;
  document.getElementById('toggle-modal-msg').textContent =
    `${action} Cup ${cupId} on Team ${teamLetter}?`;
  document.getElementById('toggle-modal').classList.remove('hidden');
  document.getElementById('btn-toggle-yes').onclick = () => {
    document.getElementById('toggle-modal').classList.add('hidden');
    const wasMade = cup.made;
    cup.made = !cup.made;
    const shooter = shooterName();
    if (wasMade) {
      if (cup.madeBy && state.playerStats[cup.madeBy]) state.playerStats[cup.madeBy].made = Math.max(0, state.playerStats[cup.madeBy].made-1);
      cup.madeBy = null;
      addEvent(`↩️ Cup ${cupId} (${teamLetter}) restored manually`, 'undo');
    } else {
      cup.madeBy = shooter; ensureStats(shooter); state.playerStats[shooter].made++;
      addEvent(`✋ Cup ${cupId} (${teamLetter}) manually marked`, 'manual');
    }
    updateCupCount(); renderRacks(); updateTeamPanels(); saveState();
    if (!wasMade) checkWinCondition(teamKey);
  };
}

/* ── Event Log ── */
function addEvent(text, type, undoFn) {
  const t = new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  state.eventLog.unshift({time:t, text, type, undoFn});
  if (state.eventLog.length > 50) state.eventLog.pop();
  renderEventLog();
}

function renderEventLog() {
  const log = document.getElementById('event-log');
  if (!log||!state) return;
  log.innerHTML = '';
  for (const e of state.eventLog.slice(0,20)) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const undoBtn = e.undoFn ? `<button class="log-undo">Undo</button>` : '';
    div.innerHTML = `<span class="log-time">${e.time}</span><span class="log-text">${e.text}</span>${undoBtn}`;
    if (e.undoFn) {
      div.querySelector('.log-undo').onclick = () => {
        e.undoFn(); e.undoFn = null;
        renderEventLog(); renderRacks(); updateTeamPanels();
      };
    }
    log.appendChild(div);
  }
}

/* ── Game History ── */
function saveGameToHistory(winner, loser) {
  const entry = {
    date: Date.now(),
    winner: teamDisplayName(winner),
    loser: teamDisplayName(loser),
    duration: Math.round((Date.now()-state.startTime)/60000),
    cupCount: state.cupCount,
    mode: state.mode,
    playerStats: JSON.parse(JSON.stringify(state.playerStats)),
    penalties: {...state.penalties},
    fastest: {...state.fastest}
  };
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
    history.unshift(entry);
    if (history.length > 10) history.length = 10;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch(e) {}
}

function renderHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');
    const section = document.getElementById('history-section');
    const list = document.getElementById('history-list');
    if (!history.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    list.innerHTML = history.map(g => {
      const d = new Date(g.date);
      const dateStr = d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ', ' +
        d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      const allPlayers = Object.entries(g.playerStats||{});
      const topSpeed = allPlayers.reduce((best,[,s]) => Math.max(best, s.fastest||0), 0);
      const speedStr = topSpeed > 0 ? ` • ${topSpeed.toFixed(1)} mph top speed` : '';
      return `<div class="history-item">
        <div class="history-item-top">
          <span class="history-winner">🏆 ${g.winner}</span>
          <span class="history-date">${dateStr}</span>
        </div>
        <div class="history-meta">vs ${g.loser} • ${g.cupCount} cups • ${g.duration} min${speedStr}</div>
      </div>`;
    }).join('');
  } catch(e) {}
}

/* ── Stat Card Canvas ── */
function buildStatCard(winner, loser) {
  const W = 600, H = 380;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const winColor = winner==='A' ? '#58a6ff' : '#f78166';
  const font = (sz, weight) => `${weight||'normal'} ${sz}px system-ui,-apple-system,sans-serif`;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(1, 1, W-2, H-2, 14); ctx.stroke();

  ctx.fillStyle = '#161b22';
  ctx.beginPath(); ctx.roundRect(1, 1, W-2, 60, [14, 14, 0, 0]); ctx.fill();

  ctx.font = font(20, 'bold'); ctx.fillStyle = '#58a6ff';
  ctx.fillText('🏓 Pong Ref', 22, 38);

  const dateStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  ctx.font = font(13); ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'right'; ctx.fillText(dateStr, W-22, 38); ctx.textAlign = 'left';

  const winnerName = teamDisplayName(winner);
  const loserName  = teamDisplayName(loser);
  ctx.font = font(28, 'bold'); ctx.fillStyle = winColor;
  ctx.fillText('🏆 ' + winnerName + ' wins!', 22, 104);
  ctx.font = font(14); ctx.fillStyle = '#8b949e';
  ctx.fillText('vs ' + loserName, 22, 124);

  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(22, 142); ctx.lineTo(W-22, 142); ctx.stroke();

  const cols = [22, 230, 360, 480];
  ctx.font = font(12, '600'); ctx.fillStyle = '#8b949e';
  ['PLAYER','CUPS','FASTEST','FOULS'].forEach((h,i) => ctx.fillText(h, cols[i], 165));

  const allPlayers = [...(state.players.A||[]), ...(state.players.B||[])].filter(Boolean);
  let y = 192;
  for (const name of allPlayers) {
    const s = state.playerStats[name]||{made:0,fastest:0,penalties:0};
    ctx.font = font(15); ctx.fillStyle = '#e6edf3';
    ctx.fillText(name, cols[0], y);
    ctx.fillText(String(s.made), cols[1], y);
    ctx.fillText(s.fastest>0 ? s.fastest.toFixed(1)+' mph' : '—', cols[2], y);
    ctx.fillText(String(s.penalties), cols[3], y);
    y += 30;
  }

  ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(22, H-46); ctx.lineTo(W-22, H-46); ctx.stroke();

  const dur = Math.round((Date.now()-state.startTime)/60000);
  ctx.font = font(13); ctx.fillStyle = '#8b949e';
  ctx.fillText(`⏱ ${dur} min  •  ${state.cupCount} cups  •  ${state.mode.toUpperCase()}`, 22, H-20);
  ctx.textAlign = 'right'; ctx.fillText('pongref.app', W-22, H-20); ctx.textAlign = 'left';

  return c;
}

async function shareStats(winner, loser) {
  const canvas = buildStatCard(winner, loser);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const file = new File([blob], 'pongref-stats.png', {type:'image/png'});

  if (navigator.share && typeof navigator.canShare === 'function' && navigator.canShare({files:[file]})) {
    try {
      await navigator.share({
        title: teamDisplayName(winner) + ' wins! 🏓',
        text: 'Check out these Pong Ref stats',
        files: [file]
      });
      return;
    } catch(e) {
      if (e.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'pongref-stats.png';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showWinScreen(winner, loser) {
  HandGesture.stop();
  // Hide fixed overlays that would otherwise float above the win screen
  for (const id of ['chandeliers-banner','island-banner','btb-btn','foul-confirm-bar']) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  showScreen('screen-win');
  const winnerName = teamDisplayName(winner);
  document.getElementById('win-title').textContent = winnerName + ' Wins! 🎉';
  document.getElementById('win-title').style.color = winner==='A'?'var(--team-a)':'var(--team-b)';
  const dur = Math.round((Date.now()-state.startTime)/60000);
  document.getElementById('win-subtitle').textContent = `Game over in ${dur} minute${dur!==1?'s':''}`;
  buildWinStats(winner);
  saveGameToHistory(winner, loser);
  renderHistory();
  startConfetti();
  Commentary.fire('win', { team:winnerName,
    losingTeam:teamDisplayName(loser), win:true });

  document.getElementById('btn-share-stats').onclick = () => shareStats(winner, loser);

  document.getElementById('btn-rematch').onclick = () => {
    stopConfetti();
    state = freshState(window._cfg||{mode:'1v1',cupCount:10,tableFt:8,players:{A:['A',''],B:['B','']},ballsBack:false,strictFoul:false});
    startGame();
  };
  document.getElementById('btn-new-game').onclick = () => {
    stopConfetti(); clearSaved(); showScreen('screen-setup');
  };
}

function buildWinStats(winner) {
  const statsDiv = document.getElementById('win-stats');
  const allPlayers = [...(state.players.A||[]), ...(state.players.B||[])].filter(Boolean);
  let html = '<table><thead><tr><th>Player</th><th>Cups</th><th>Fastest</th><th>Fouls</th></tr></thead><tbody>';
  for (const name of allPlayers) {
    const s = state.playerStats[name]||{made:0,fastest:0,penalties:0};
    html += `<tr><td>${name}</td><td>${s.made}</td><td>${s.fastest>0?s.fastest.toFixed(1)+' mph':'—'}</td><td>${s.penalties}</td></tr>`;
  }
  html += '</tbody></table>';
  statsDiv.innerHTML = html;
}

/* ── Confetti ── */
const COLORS = ['#58a6ff','#f78166','#3fb950','#d29922','#bc8cff','#ff6eb4'];
function startConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const particles = Array.from({length:140}, () => ({
    x: Math.random()*canvas.width, y: -Math.random()*canvas.height,
    r: Math.random()*8+3, color: COLORS[(Math.random()*COLORS.length)|0],
    angle: Math.random()*Math.PI*2, vx: (Math.random()-0.5)*2,
    vy: Math.random()*3+1.5, spin: (Math.random()-0.5)*0.2
  }));
  function draw() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (const p of particles) {
      p.x+=p.vx; p.y+=p.vy; p.angle+=p.spin;
      if (p.y>canvas.height+20) { p.y=-10; p.x=Math.random()*canvas.width; }
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.angle);
      ctx.fillStyle=p.color;
      ctx.beginPath(); ctx.ellipse(0,0,p.r,p.r/2,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    confettiRaf = requestAnimationFrame(draw);
  }
  draw();
}
function stopConfetti() { if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf=null; } }

/* ── Persistence ── */
function saveState() {
  try {
    const gameState = {...state, eventLog: state.eventLog.map(e=>({...e, undoFn:null}))};
    const cvState = {
      calCorners: calCorners.length === 4 ? calCorners : null,
      ballHSV: Vision.ballHSV || null,
      hsvTol: {...Vision.hsvTol},
      cupAdjust: Vision.cupAdjust ? JSON.parse(JSON.stringify(Vision.cupAdjust)) : null,
      clickedLayout: Vision.cupLayoutFixed ? JSON.parse(JSON.stringify(Vision.cupLayout)) : null
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify({ gameState, cvState }));
  } catch(e) {}
}
function loadSaved() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    if (!s) return null;
    const p = JSON.parse(s);
    const gameState = p.gameState || p;
    const cvState = p.cvState || null;
    const alive = gameState.cups &&
      (gameState.cups.teamA.some(c=>!c.made) || gameState.cups.teamB.some(c=>!c.made));
    return alive ? { gameState, cvState } : null;
  } catch(e) { return null; }
}
function clearSaved() { localStorage.removeItem(SAVE_KEY); }

/* ── Bootstrap ── */
document.addEventListener('DOMContentLoaded', () => {
  initSetupScreen();
});
})();
