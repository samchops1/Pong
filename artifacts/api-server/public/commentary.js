/* commentary.js — Commentary engine for Pong Ref
   Exposes window.Commentary */
(function() {
'use strict';

const CANNED = [
  "{player} with the LASER! Right in the cup!",
  "BOOM! {player} just rearranged {defending}'s rack!",
  "Textbook arc! {player} has been training for THIS moment!",
  "{player} with ice water in those veins — ice cold MAKE!",
  "Oh that TRAJECTORY! {player} is putting on a clinic!",
  "Cup #{cupId} is TOAST thanks to {player}!",
  "{player} drops it in smooth as butter!",
  "The people's champion {player} delivers AGAIN!",
  "That ball had CUP written all over it — {player} knew it!",
  "{player} with the shot heard round the table!",
  // Misses / streaks
  "{player} fires wide — even the ball is embarrassed!",
  "THREE in a row for {player}! Someone get them corrective lenses!",
  "{player}'s aim tonight is sponsored by RNG — pure chaos!",
  "Miss! {player} is playing a different game entirely!",
  "The ball said NO and we respect that — {player} does not.",
  "That shot had the right energy, wrong ZIP CODE — {player}!",
  "{player} with a rim shot! So close, yet so far!",
  "The miss streak continues! {player} has officially lost the plot!",
  // Penalties
  "ELBOW! {player} trying to cheat their way to victory!",
  "Flag on the play! {player}'s elbow crossed the line!",
  "The referee sees ALL — {player} you can't hide that elbow!",
  "PENALTY! {player} playing by different rules tonight!",
  "{player} caught red-elbowed! The shame! THE SHAME!",
  // Speed
  "{player} just shot that at MACH SPEED — someone call NASA!",
  "{player} throws like they have somewhere to be!",
  "That was clocked at {speed} mph — {player} is built different!",
  "VELOCITY! {player} may have just broken the sound barrier!",
  // Last cup / close game
  "LAST CUP! {defending} is playing for their LIVES right now!",
  "ONE CUP LEFT for {defending} — {player} do NOT blow this!",
  "This is the moment! Last cup! The crowd goes absolutely INSANE!",
  "TWO CUPS? {defending} is on life support — {player} finish the job!",
  "Three cups remaining — {defending} is NOT done yet, folks!",
  // Win
  "{team} WINS! Someone call the ambulance for {losing_team}!",
  "{team} is VICTORIOUS! Ring the bells! Sound the horns!",
  "GAME OVER! {team} has absolutely DESTROYED {losing_team} tonight!",
  "THE CHAMPIONSHIP BELONGS TO {team}! Un-REAL performance!",
  "{losing_team} pack it up — {team} just ended your season!",
  "AND THAT'S THE GAME! {team} — legends, champions, icons!",
  // Generic hype
  "I've seen beer pong and I've seen ART — tonight it's both!",
  "The atmosphere is ELECTRIC — or that might just be the fridge humming!",
  "This is what the people came to SEE, ladies and gentlemen!",
  "Someone is getting extremely sweaty right now and I love it!",
  "Absolutely PREMIUM beer pong content being produced here!",
  "I have chills. Actual chills. From beer pong. This is my life."
];

function pick(arr) { return arr[(Math.random()*arr.length)|0]; }

function pickCanned(ctx) {
  const pool = CANNED.filter(l => {
    // Filter lines contextually
    if (l.includes('{cupId}') && !ctx.cupId) return false;
    if (l.includes('{speed}') && !ctx.speed) return false;
    if (l.includes('streak') && !ctx.missStreak) return false;
    if (l.includes('LAST CUP') && !ctx.lastCup) return false;
    if (l.includes('ONE CUP') && !ctx.oneCupLeft) return false;
    if (l.includes('TWO CUPS') && !ctx.twoCupsLeft) return false;
    if (l.includes('Three cups') && !ctx.threeCupsLeft) return false;
    if (l.includes('{team} WIN') || l.includes('CHAMPIONSHIP') || l.includes('GAME OVER') || l.includes('season')) {
      if (!ctx.win) return false;
    }
    if ((l.includes('MACH') || l.includes('NASA') || l.includes('sound barrier')) && !ctx.speed) return false;
    return true;
  });
  const template = pick(pool.length ? pool : CANNED);
  return template
    .replace(/{player}/g, ctx.player || 'Player')
    .replace(/{defending}/g, ctx.defending || 'the other team')
    .replace(/{team}/g, ctx.team || 'the winners')
    .replace(/{losing_team}/g, ctx.losingTeam || 'the losers')
    .replace(/{cupId}/g, ctx.cupId || '?')
    .replace(/{speed}/g, ctx.speed ? ctx.speed.toFixed(1) : '??');
}

/* Queue */
const queue = [];
let speaking = false;
let muted = false;
let bubble = null;
let currentFinish = null; // completes the in-flight utterance (idempotent)

function display(text) {
  if (!bubble) bubble = document.getElementById('commentary-bubble');
  if (!bubble) return;
  bubble.textContent = '🎙️ ' + text;
  bubble.classList.remove('hidden');
  clearTimeout(bubble._hideTimer);
  bubble._hideTimer = setTimeout(() => bubble.classList.add('hidden'), 8000);
}

function speak(text) {
  // Even when muted (or speech is unavailable) the queue must keep draining,
  // otherwise `speaking` stays true forever and the text bubble stops updating.
  if (muted || !text || typeof speechSynthesis === 'undefined') {
    setTimeout(next, 2500);
    return;
  }
  try {
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.1;
    // Try to pick an energetic voice
    const voices = speechSynthesis.getVoices();
    const energetic = voices.find(v => /Google|en-US/i.test(v.name));
    if (energetic) utt.voice = energetic;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      if (currentFinish === finish) currentFinish = null;
      next();
    };
    // Some browsers never fire onend/onerror (e.g. when speech is blocked) —
    // a watchdog keeps the queue alive regardless.
    const watchdog = setTimeout(finish, 8000);
    currentFinish = finish;
    utt.onend = finish;
    utt.onerror = finish;
    speechSynthesis.speak(utt);
  } catch(e) { setTimeout(next, 1000); }
}

function next() {
  speaking = false;
  processQueue();
}

function processQueue() {
  if (speaking || !queue.length) return;
  const item = queue.shift();
  if (Date.now() - item.ts > 10000) { processQueue(); return; } // stale
  speaking = true;
  display(item.text);
  speak(item.text);
}

async function request(event, ctx) {
  let text = null;
  try {
    const res = await fetch('/api/commentary', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ event, context: ctx })
    });
    const data = await res.json();
    text = data.text || null;
  } catch(e) { /* ignore */ }

  if (!text) text = pickCanned(ctx);
  if (text) {
    queue.push({ text, ts: Date.now() });
    processQueue();
  }
}

window.Commentary = {
  fire(event, ctx) {
    request(event, ctx).catch(() => {
      const text = pickCanned(ctx || {});
      queue.push({ text, ts: Date.now() });
      processQueue();
    });
  },
  setMuted(m) {
    muted = m;
    if (m) {
      try { speechSynthesis.cancel(); } catch(e) {}
      // cancel() doesn't reliably fire onend/onerror everywhere — force the
      // in-flight line to complete so the queue keeps draining while muted
      if (currentFinish) currentFinish();
    }
  },
  get muted() { return muted; }
};

// Load voices eagerly
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

})();
