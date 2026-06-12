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

/* ── State ── */
let state = null;
let calCorners = [];
let cornerStep = 0;
let calPreviewActive = false;
let ballPreviewActive = false;
let ballSampled = false;
let pendingMask = false;
let confettiRaf = null;
const SAVE_KEY = 'pongref_v3';

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
    ballsBack: cfg.ballsBack,
    strictFoul: cfg.strictFoul,
    penalties: {A:0, B:0},
    fastest: {A:0, B:0},
    startTime: Date.now(),
    muted: false
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
      document.querySelectorAll('.player-name-2v2').forEach(el => {
        el.classList.toggle('hidden', btn.dataset.mode !== '2v2');
      });
    });
  });

  document.querySelectorAll('.cup-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cup-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('btn-start-calibration').addEventListener('click', () => {
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
      // Restore CV calibration so tracking works without re-calibrating
      const cv = saved.cvState;
      if (cv) {
        if (cv.calCorners && cv.calCorners.length === 4) calCorners = cv.calCorners;
        if (cv.ballHSV) Vision.ballHSV = cv.ballHSV;
        if (cv.hsvTol) Vision.setHsvTol(cv.hsvTol);
        // Ensure window._cfg is available for any remaining references
        window._cfg = window._cfg || {
          tableFt: state.tableFt, cupCount: state.cupCount,
          mode: state.mode, ballsBack: state.ballsBack, strictFoul: state.strictFoul,
          players: state.players
        };
      }
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
  'Click the <strong>near-left</strong> corner of the table (your side, left)',
  'Click the <strong>near-right</strong> corner of the table (your side, right)',
  'Click the <strong>far-left</strong> corner (opposite side, left)',
  'Click the <strong>far-right</strong> corner (opposite side, right)',
  'All 4 corners set! Proceeding to ball calibration…'
];

async function startCalCorners() {
  calCorners = []; cornerStep = 0;
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
      if (calCorners.length === 4) drawCalOverlay(ctx);
    }
    requestAnimationFrame(loop);
  })();

  canvas.addEventListener('click', onCornerClick);
  document.getElementById('btn-redo-corners').onclick = () => {
    calCorners = []; cornerStep = 0; updateCornerUI();
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
    // Foul line
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
    setTimeout(proceedToBallCal, 1000);
  }
}

function proceedToBallCal() {
  calPreviewActive = false;
  document.getElementById('cal-canvas').removeEventListener('click', onCornerClick);
  Vision.stopCamera();
  startBallCal();
}

/* ─────────────────────────── BALL CALIBRATION ─────────────────────────── */
async function startBallCal() {
  ballSampled = false; pendingMask = false;
  showScreen('screen-calibrate-ball');
  document.getElementById('btn-start-game').disabled = true;
  document.getElementById('hsv-info').textContent = '';
  document.getElementById('ball-sample-dot').classList.add('hidden');

  const video = document.getElementById('ball-video');
  const canvas = document.getElementById('ball-canvas');
  Vision.init(video, canvas);
  const ok = await Vision.startCamera('environment');
  if (!ok) { alert('Camera error'); return; }
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ballPreviewActive = true;
  const ctx = canvas.getContext('2d');
  (function loop() {
    if (!ballPreviewActive) return;
    if (video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      if (pendingMask && Vision.ballHSV) applyMaskOverlay(ctx, canvas);
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
    document.getElementById('btn-start-game').disabled = true;
  };

  document.getElementById('btn-start-game').onclick = () => {
    ballPreviewActive = false;
    Vision.stopCamera();
    state = freshState(window._cfg);
    startGame();
  };
}

function applyMaskOverlay(ctx, canvas) {
  try {
    const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    const d = img.data, bsv = Vision.ballHSV, tol = Vision.hsvTol;
    for (let i=0;i<d.length;i+=4) {
      const r=d[i],g=d[i+1],b=d[i+2];
      const max=Math.max(r,g,b)/255, min=Math.min(r,g,b)/255, dd=(max-min);
      const v=max*100;
      if (v<tol.valFloor) continue;
      const s=(max>0?dd/max:0)*100;
      let h=0;
      if (dd>0) {
        const r2=r/255,g2=g/255,b2=b/255;
        if (max===r2/255*255/255||max===r/255) h=((g2-b2)/dd+6)%6;
        else if (max===g/255) h=(b2-r2)/dd+2;
        else h=(r2-g2)/dd+4;
        h*=60;
      }
      const dh=Math.min(Math.abs(h-bsv.hue),360-Math.abs(h-bsv.hue));
      if (dh<=tol.hue && Math.abs(s-bsv.sat)<=tol.sat) {
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
  document.getElementById('hsv-info').textContent =
    `Sampled: H=${hsv.hue.toFixed(0)}° S=${hsv.sat.toFixed(0)}% V=${hsv.val.toFixed(0)}%`;
  const dot = document.getElementById('ball-sample-dot');
  dot.style.left = e.clientX + 'px';
  dot.style.top = e.clientY + 'px';
  dot.classList.remove('hidden');
  document.getElementById('btn-start-game').disabled = false;
}

/* ─────────────────────────── GAME ─────────────────────────── */
async function startGame() {
  showScreen('screen-game');

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
    {x: w*mg,     y: h*(1-mg)},  // near-left
    {x: w*(1-mg), y: h*(1-mg)},  // near-right
    {x: w*mg,     y: h*mg},      // far-left
    {x: w*(1-mg), y: h*mg}       // far-right
  ];
}

function wireGameButtons() {
  document.getElementById('btn-mute').onclick = () => {
    state.muted = !state.muted;
    Commentary.setMuted(state.muted);
    document.getElementById('btn-mute').textContent = state.muted ? '🔇' : '🔊';
  };

  document.getElementById('btn-recalibrate').onclick = () => {
    Vision.stopTracking(); Vision.stopCamera();
    startCalCorners();
  };

  document.getElementById('btn-confirm-penalty').onclick = confirmPenalty;
  document.getElementById('btn-dismiss-foul').onclick = dismissFoul;
  document.getElementById('btn-toggle-no').onclick = () =>
    document.getElementById('toggle-modal').classList.add('hidden');

  document.getElementById('btn-pass-turn') && (
    document.getElementById('btn-pass-turn').onclick = () => advanceTurn('manual')
  );
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
  if (mph > (state.fastest[t] || 0)) {
    state.fastest[t] = mph;
    state.playerStats[shooter].fastest = Math.max(state.playerStats[shooter].fastest, mph);
    const overlay = document.getElementById('speed-overlay');
    if (overlay) {
      overlay.textContent = mph.toFixed(1)+' mph';
      overlay.style.display = 'block';
      clearTimeout(overlay._t);
      overlay._t = setTimeout(() => { overlay.style.display='none'; }, 4000);
    }
    updateTeamPanels();
    Commentary.fire('speed', { player:shooter, speed:mph,
      defending:`Team ${t==='A'?'B':'A'}` });
  }
  saveState();
}

function onMakeDetected(detection) {
  const { cup, confidence, team } = detection;
  const teamKey = team; // 'teamA' or 'teamB'
  const cupObj = (state.cups[teamKey]||[]).find(c=>c.id===cup.id);
  if (!cupObj || cupObj.made) return;
  const teamLetter = teamKey === 'teamA' ? 'A' : 'B';

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

/* ── Scoring ── */
function autoScoreCup(teamKey, cupId) {
  const cup = (state.cups[teamKey]||[]).find(c=>c.id===cupId);
  if (!cup || cup.made) return;

  const shooter = shooterName();
  ensureStats(shooter);
  cup.made = true;
  cup.madeBy = shooter;
  state.playerStats[shooter].made++;
  state.makesThisTurn++;
  state.consecutiveMisses[state.shootingTeam] = 0;

  const teamLetter = teamKey === 'teamA' ? 'A' : 'B';
  const remaining = (state.cups[teamKey]||[]).filter(c=>!c.made).length;

  const undoFn = () => {
    cup.made = false; cup.madeBy = null;
    if (state.playerStats[shooter]) state.playerStats[shooter].made = Math.max(0, state.playerStats[shooter].made-1);
    state.makesThisTurn = Math.max(0, state.makesThisTurn-1);
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
  checkWinCondition(teamKey);
}

function checkWinCondition(teamKey) {
  const remaining = (state.cups[teamKey]||[]).filter(c=>!c.made).length;
  if (remaining === 0) {
    const winner = state.shootingTeam;
    const loser = winner==='A'?'B':'A';
    Vision.stopTracking(); Vision.stopCamera();
    clearSaved();
    setTimeout(() => showWinScreen(winner, loser), 600);
  }
}

function advanceTurn(source) {
  const gs = state;
  // Balls back: 2+ makes in one turn
  if (gs.ballsBack && gs.makesThisTurn >= 2) {
    gs.makesThisTurn = 0;
    addEvent(`🔄 Balls back — Team ${gs.shootingTeam} shoots again!`, 'balls-back');
    Commentary.fire('balls_back', { team:`Team ${gs.shootingTeam}`, player:shooterName() });
    updateTurnIndicator(); saveState(); return;
  }

  gs.makesThisTurn = 0;
  gs.consecutiveMisses[gs.shootingTeam]++;

  if (gs.consecutiveMisses[gs.shootingTeam] >= 3) {
    const s = shooterName();
    Commentary.fire('miss_streak', { player:s, defending:`Team ${gs.shootingTeam==='A'?'B':'A'}`, missStreak:true });
  }

  if (gs.mode === '2v2') {
    gs.shooterIndex[gs.shootingTeam] = (gs.shooterIndex[gs.shootingTeam]+1)%2;
  }
  gs.shootingTeam = gs.shootingTeam==='A'?'B':'A';

  addEvent(`➡️ Turn: Team ${gs.shootingTeam}`, 'turn');
  updateTurnIndicator();
  updateTeamPanels(); saveState();
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
    advanceTurn('confirm-miss');
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
    const row = document.createElement('div');
    row.className = 'player-row'+(shooting?' shooting':'');
    row.innerHTML = `<div class="player-row-name">${shooting?'🎯 ':''}${name}</div>
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
    el.textContent = `🎯 ${name}'s turn`;
    el.style.color = state.shootingTeam==='A' ? 'var(--team-a)' : 'var(--team-b)';
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
  const positions = n===10 ? CUP_POSITIONS_10 : CUP_POSITIONS_6;
  const svgW = n===10?165:135, svgH = n===10?150:120, R=16;
  let out = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`;
  for (const {id, cx, cy} of positions) {
    const cup = cups.find(c=>c.id===id);
    const made = cup?.made;
    if (made) {
      out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#2d2d2d" stroke="#555" stroke-width="1.5" data-cup-id="${id}" style="cursor:pointer"/>`;
      out += `<line x1="${cx-9}" y1="${cy-9}" x2="${cx+9}" y2="${cy+9}" stroke="#f85149" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`;
      out += `<line x1="${cx+9}" y1="${cy-9}" x2="${cx-9}" y2="${cy+9}" stroke="#f85149" stroke-width="3" stroke-linecap="round" pointer-events="none"/>`;
    } else {
      out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1.5" data-cup-id="${id}" style="cursor:pointer"/>`;
      out += `<text x="${cx}" y="${cy+5}" text-anchor="middle" font-size="11" font-weight="bold" fill="#000" pointer-events="none">${id}</text>`;
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

/* ── Win Screen ── */
function showWinScreen(winner, loser) {
  showScreen('screen-win');
  const winnerName = teamDisplayName(winner);
  document.getElementById('win-title').textContent = winnerName + ' Wins! 🎉';
  document.getElementById('win-title').style.color = winner==='A'?'var(--team-a)':'var(--team-b)';
  const dur = Math.round((Date.now()-state.startTime)/60000);
  document.getElementById('win-subtitle').textContent = `Game over in ${dur} minute${dur!==1?'s':''}`;
  buildWinStats(winner);
  startConfetti();
  Commentary.fire('win', { team:winnerName,
    losingTeam:teamDisplayName(loser), win:true });

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
    // Persist CV calibration alongside game state so resume works without re-calibrating
    const cvState = {
      calCorners: calCorners.length === 4 ? calCorners : null,
      ballHSV: Vision.ballHSV || null,
      hsvTol: {...Vision.hsvTol}
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify({ gameState, cvState }));
  } catch(e) {}
}
function loadSaved() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    if (!s) return null;
    const p = JSON.parse(s);
    // Support new wrapped format { gameState, cvState } and legacy flat format
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
