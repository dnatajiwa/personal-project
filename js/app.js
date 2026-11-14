/* Personal Growth Hub — vanilla JS single-page app. Data lives in localStorage. */
(function () {
  "use strict";

  const STORE_KEY = "pdev.v1";
  const SRS_INTERVALS = [0, 1, 3, 7, 14, 30, 60]; // days per Leitner box
  const NEW_CARDS_PER_DAY = 10;

  // ---------- Utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => dateKey();
  const addDays = (key, n) => {
    const [y, m, d] = key.split("-").map(Number);
    return dateKey(new Date(y, m - 1, d + n));
  };
  const daysBetween = (a, b) => {
    const [y1, m1, d1] = a.split("-").map(Number);
    const [y2, m2, d2] = b.split("-").map(Number);
    return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d = 1) => (n == null || isNaN(n) ? "–" : Number(n).toFixed(d));
  const shortDate = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  // ---------- State ----------
  const defaultState = () => ({
    profile: { name: "", heightCm: "", startKg: "", goalKg: "", targetDate: "" },
    goals: { mandarinMinutes: 15, aiMinutes: 30, newCards: NEW_CARDS_PER_DAY },
    weights: [], // {date, kg}
    habits: {}, // date -> {habitId: true}
    cards: {}, // hanzi -> {box, due}
    mandarinLog: {}, // date -> {reviews, minutes, newCards}
    aiProgress: {}, // moduleId -> {done, notes}
    aiLog: {}, // date -> minutes
    quizBest: 0,
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return { ...base, ...parsed, profile: { ...base.profile, ...parsed.profile }, goals: { ...base.goals, ...parsed.goals } };
    } catch (e) {
      return defaultState();
    }
  }
  let state = load();

  // Optional cloud sync: when hosted as a claude.ai artifact, the state is also
  // stored in the signed-in person's private db document so it follows them
  // across devices. Elsewhere (file://, GitHub Pages) it stays in localStorage.
  const sync = { ref: null, status: "local", timer: null, writing: false, pending: false };
  function saveLocal() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function save() {
    state.updatedAt = Date.now();
    saveLocal();
    if (sync.ref) {
      clearTimeout(sync.timer);
      sync.timer = setTimeout(pushRemote, 800);
    }
  }
  async function pushRemote() {
    if (!sync.ref) return;
    if (sync.writing) { sync.pending = true; return; }
    sync.writing = true;
    setSyncStatus("saving");
    try {
      await sync.ref.set(JSON.parse(JSON.stringify(state)));
      setSyncStatus("synced");
    } catch (e) {
      setSyncStatus("error");
    } finally {
      sync.writing = false;
      if (sync.pending) { sync.pending = false; pushRemote(); }
    }
  }
  function setSyncStatus(s) {
    sync.status = s;
    const el = document.getElementById("sync");
    if (!el) return;
    const label = { local: "Saved on this device", saving: "Syncing…", synced: "Synced to your account", error: "Sync failed — saved on this device" }[s];
    el.textContent = label;
    el.dataset.state = s;
  }
  function adoptRemote(data) {
    const base = defaultState();
    state = { ...base, ...data, profile: { ...base.profile, ...data.profile }, goals: { ...base.goals, ...data.goals } };
    saveLocal();
    session.queue = null;
    // Don't yank the page out from under someone typing notes
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA/.test(a.tagName)) return;
    render();
  }
  async function initSync() {
    if (!window.claude || typeof window.claude.use !== "function") return;
    try {
      const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
      const uid = db && user ? await user.id() : null;
      if (!uid) return;
      const ref = db.collection("data/users/" + uid).doc("state");
      const snap = await ref.get();
      sync.ref = ref;
      const remote = snap.exists ? snap.data() : null;
      if (remote && (remote.updatedAt || 0) >= (state.updatedAt || 0)) {
        adoptRemote(remote);
        setSyncStatus("synced");
      } else {
        await pushRemote(); // first device, or this device has newer data
      }
      ref.onSnapshot((s) => {
        if (!s.exists || s.metadata.hasPendingWrites) return;
        const d = s.data();
        if ((d.updatedAt || 0) > (state.updatedAt || 0)) { adoptRemote(d); setSyncStatus("synced"); }
      }, () => setSyncStatus("error"));
    } catch (e) {
      setSyncStatus("error");
    }
  }

  const HABITS = [
    ["workout", "30+ min exercise"],
    ["steps", "8,000+ steps"],
    ["water", "2 L water"],
    ["noSugar", "No sugary drinks / snacks"],
    ["sleep", "7+ hours sleep"],
  ];

  // ---------- Activity & streaks ----------
  const mandarinActive = (d) => {
    const l = state.mandarinLog[d];
    return !!l && ((l.reviews || 0) > 0 || (l.minutes || 0) > 0);
  };
  const weightActive = (d) => state.weights.some((w) => w.date === d) || Object.values(state.habits[d] || {}).some(Boolean);
  const aiActive = (d) => (state.aiLog[d] || 0) > 0;

  function streak(activeFn) {
    let d = today();
    if (!activeFn(d)) d = addDays(d, -1); // today not done yet doesn't break the streak
    let n = 0;
    while (activeFn(d)) { n++; d = addDays(d, -1); }
    return n;
  }

  // ---------- Mandarin SRS ----------
  function dueCards() {
    const t = today();
    return HSK1.filter(([h]) => state.cards[h] && state.cards[h].due <= t);
  }
  function newCardsAvailable() {
    const used = (state.mandarinLog[today()] || {}).newCards || 0;
    const left = Math.max(0, (state.goals.newCards ?? NEW_CARDS_PER_DAY) - used);
    return HSK1.filter(([h]) => !state.cards[h]).slice(0, left);
  }
  function buildQueue() {
    return [...dueCards(), ...newCardsAvailable()].map((c) => c[0]);
  }
  function logMandarin(field, n) {
    const t = today();
    state.mandarinLog[t] = state.mandarinLog[t] || { reviews: 0, minutes: 0, newCards: 0 };
    state.mandarinLog[t][field] = (state.mandarinLog[t][field] || 0) + n;
  }
  function gradeCard(hanzi, grade) {
    const existing = state.cards[hanzi];
    if (!existing) logMandarin("newCards", 1);
    let box = existing ? existing.box : 0;
    if (grade === "again") box = 1;
    else if (grade === "good") box = Math.min(box + 1, SRS_INTERVALS.length - 1);
    else if (grade === "easy") box = Math.min(box + 2, SRS_INTERVALS.length - 1);
    const interval = grade === "again" ? 0 : SRS_INTERVALS[box];
    state.cards[hanzi] = { box, due: addDays(today(), interval) };
    logMandarin("reviews", 1);
    save();
  }

  let zhVoice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const voices = speechSynthesis.getVoices();
    zhVoice = voices.find((v) => /zh[-_]CN/i.test(v.lang)) || voices.find((v) => /^zh/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) return toast("Speech is not supported in this browser");
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 0.8;
    if (zhVoice) u.voice = zhVoice;
    speechSynthesis.speak(u);
  }

  // Session state for the flashcard UI (not persisted)
  const session = { queue: null, revealed: false, reverse: false, done: 0, vocabFilter: "" };

  // ---------- Weight helpers ----------
  const sortedWeights = () => [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  function weightStats() {
    const ws = sortedWeights();
    const p = state.profile;
    const latest = ws.length ? ws[ws.length - 1].kg : null;
    const start = p.startKg ? Number(p.startKg) : ws.length ? ws[0].kg : null;
    const goal = p.goalKg ? Number(p.goalKg) : null;
    const h = p.heightCm ? Number(p.heightCm) / 100 : null;
    const bmi = latest && h ? latest / (h * h) : null;
    const last7 = ws.filter((w) => daysBetween(w.date, today()) < 7);
    const avg7 = last7.length ? last7.reduce((s, w) => s + w.kg, 0) / last7.length : null;
    let weeklyRate = null;
    const recent = ws.filter((w) => daysBetween(w.date, today()) <= 28);
    if (recent.length >= 2) {
      const span = daysBetween(recent[0].date, recent[recent.length - 1].date);
      if (span > 0) weeklyRate = ((recent[recent.length - 1].kg - recent[0].kg) / span) * 7;
    }
    let progress = null;
    if (start != null && goal != null && latest != null && start !== goal) {
      progress = Math.max(0, Math.min(1, (start - latest) / (start - goal)));
    }
    return { ws, latest, start, goal, bmi, avg7, weeklyRate, progress };
  }
  const bmiLabel = (b) => (b == null ? "" : b < 18.5 ? "Underweight" : b < 25 ? "Healthy" : b < 30 ? "Overweight" : "Obese");

  function weightChart(ws, goal) {
    if (ws.length < 2) return `<p class="muted">Log at least two weigh-ins to see your trend chart.</p>`;
    const W = 640, H = 240, P = { l: 44, r: 16, t: 16, b: 28 };
    const pts = ws.slice(-60);
    const vals = pts.map((w) => w.kg).concat(goal != null ? [goal] : []);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 2) { min -= 1; max += 1; }
    const first = pts[0].date, span = Math.max(1, daysBetween(first, pts[pts.length - 1].date));
    const x = (d) => P.l + (daysBetween(first, d) / span) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    const line = pts.map((w, i) => `${i ? "L" : "M"}${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join(" ");
    // 7-point moving average
    const ma = pts.map((w, i) => {
      const win = pts.slice(Math.max(0, i - 6), i + 1);
      return [w.date, win.reduce((s, v) => s + v.kg, 0) / win.length];
    });
    const maLine = ma.map(([d, v], i) => `${i ? "L" : "M"}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const ticks = [min, (min + max) / 2, max];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend chart">
      ${ticks.map((t) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${P.l - 6}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join("")}
      ${goal != null ? `<line class="goal" x1="${P.l}" x2="${W - P.r}" y1="${y(goal)}" y2="${y(goal)}"/><text class="axis goal-label" x="${W - P.r}" y="${y(goal) - 5}" text-anchor="end">Goal ${goal}</text>` : ""}
      <path class="series" d="${line}"/>
      <path class="trend" d="${maLine}"/>
      ${pts.map((w) => `<circle class="dot" cx="${x(w.date)}" cy="${y(w.kg)}" r="3"><title>${shortDate(w.date)}: ${w.kg} kg</title></circle>`).join("")}
      <text class="axis" x="${P.l}" y="${H - 8}">${shortDate(first)}</text>
      <text class="axis" x="${W - P.r}" y="${H - 8}" text-anchor="end">${shortDate(pts[pts.length - 1].date)}</text>
    </svg>
    <div class="legend"><span><i class="sw sw-series"></i>Daily weight</span><span><i class="sw sw-trend"></i>7-entry average</span>${goal != null ? `<span><i class="sw sw-goal"></i>Goal</span>` : ""}</div>`;
  }

  // ---------- AI helpers ----------
  const allModules = () => AI_TRACKS.flatMap((t) => t.modules.map((m) => ({ ...m, track: t })));
  const moduleDone = (id) => !!(state.aiProgress[id] && state.aiProgress[id].done);
  function nextModule() {
    return allModules().find((m) => !moduleDone(m.id)) || null;
  }
  const quiz = { idx: 0, score: 0, answered: null, order: null, finished: false };
  function resetQuiz() {
    quiz.idx = 0; quiz.score = 0; quiz.answered = null; quiz.finished = false;
    quiz.order = AI_QUIZ.map((_, i) => i).sort(() => Math.random() - 0.5);
  }

  // ---------- Views ----------
  const views = {};

  views.dashboard = () => {
    const t = today();
    const ml = state.mandarinLog[t] || {};
    const due = dueCards().length + newCardsAvailable().length;
    const ws = weightStats();
    const loggedWeight = state.weights.some((w) => w.date === t);
    const aiMin = state.aiLog[t] || 0;
    const next = nextModule();
    const habitsDone = HABITS.filter(([id]) => (state.habits[t] || {})[id]).length;
    const name = state.profile.name ? `, ${esc(state.profile.name)}` : "";
    const hour = new Date().getHours();
    const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

    const plan = [
      [mandarinActive(t) && due === 0, `Mandarin: review ${due ? `${due} card${due === 1 ? "" : "s"}` : "— all caught up"}`, "mandarin"],
      [(ml.minutes || 0) >= state.goals.mandarinMinutes, `Mandarin: ${ml.minutes || 0} / ${state.goals.mandarinMinutes} min practice`, "mandarin"],
      [loggedWeight, "Weight: log today's weigh-in", "weight"],
      [habitsDone >= 4, `Healthy habits: ${habitsDone} / ${HABITS.length} done`, "weight"],
      [aiMin >= state.goals.aiMinutes, `AI: ${aiMin} / ${state.goals.aiMinutes} min study${next ? ` — ${esc(next.title)}` : ""}`, "ai"],
    ];

    return `
      <header class="page-head"><h1>${greet}${name}</h1><p class="muted">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p></header>
      <section class="grid3">
        ${areaCard("mandarin", "学", "Mandarin", streak(mandarinActive), `${Object.keys(state.cards).length} / ${HSK1.length} HSK 1 words started`)}
        ${areaCard("weight", "⚖", "Weight", streak(weightActive), ws.latest != null ? `${fmt(ws.latest)} kg${ws.goal != null ? ` · ${fmt(Math.max(0, ws.latest - ws.goal))} kg to goal` : ""}` : "No weigh-ins yet")}
        ${areaCard("ai", "AI", "AI Learning", streak(aiActive), `${allModules().filter((m) => moduleDone(m.id)).length} / ${allModules().length} modules complete`)}
      </section>
      <section class="card">
        <h2>Today's plan</h2>
        <ul class="plan">${plan.map(([done, text, view]) => `<li class="${done ? "done" : ""}"><span class="check">${done ? "✓" : ""}</span><a href="#${view}">${text}</a></li>`).join("")}</ul>
      </section>
      <section class="card">
        <h2>Last 12 weeks</h2>
        ${heatmap()}
      </section>`;
  };

  function areaCard(view, icon, title, s, sub) {
    return `<a class="card area area-${view}" href="#${view}">
      <div class="area-top"><span class="area-icon">${icon}</span><span class="streak" title="Current streak">🔥 ${s} day${s === 1 ? "" : "s"}</span></div>
      <h3>${title}</h3><p class="muted">${sub}</p></a>`;
  }

  function heatmap() {
    const t = today();
    // Align so the last column ends on today
    const cells = [];
    for (let i = 83; i >= 0; i--) {
      const d = addDays(t, -i);
      const n = [mandarinActive(d), weightActive(d), aiActive(d)].filter(Boolean).length;
      cells.push(`<span class="hm l${n}" title="${shortDate(d)}: ${n}/3 goals active"></span>`);
    }
    return `<div class="heatmap">${cells.join("")}</div>
      <div class="legend"><span>Less</span><i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><span>More (all 3 goals)</span></div>`;
  }

  views.mandarin = () => {
    if (!session.queue) session.queue = buildQueue();
    const t = today();
    const ml = state.mandarinLog[t] || {};
    const started = Object.keys(state.cards).length;
    const mastered = Object.values(state.cards).filter((c) => c.box >= 4).length;
    const phrase = PHRASES[daysBetween("2024-01-01", t) % PHRASES.length];
    const filter = session.vocabFilter.toLowerCase();
    const vocab = HSK1.filter((v) => !filter || v.join(" ").toLowerCase().includes(filter));

    return `
      <header class="page-head"><h1>Mandarin 中文</h1><p class="muted">HSK 1 vocabulary with spaced repetition. Tap 🔊 to hear pronunciation.</p></header>
      <section class="stats">
        ${stat("Due now", session.queue.length)}
        ${stat("Reviewed today", ml.reviews || 0)}
        ${stat("Words started", `${started}/${HSK1.length}`)}
        ${stat("Mastered", mastered)}
        ${stat("Streak", `${streak(mandarinActive)} d`)}
      </section>
      <section class="card">
        <div class="row between"><h2>Flashcards</h2>
          <label class="toggle"><input type="checkbox" data-action="reverse" ${session.reverse ? "checked" : ""}> English → 汉字</label></div>
        ${flashcard()}
      </section>
      <section class="grid2">
        <div class="card">
          <h2>Phrase of the day</h2>
          <p class="phrase zh">${phrase[0]} <button class="icon-btn" data-action="speak" data-text="${esc(phrase[0])}" aria-label="Play">🔊</button></p>
          <p class="pinyin">${phrase[1]}</p><p class="muted">${phrase[2]}</p>
          <p class="hint">Shadow it: listen, pause, repeat aloud 5 times.</p>
        </div>
        <div class="card">
          <h2>Log practice time</h2>
          <p class="muted">Today: <strong>${ml.minutes || 0}</strong> / ${state.goals.mandarinMinutes} min</p>
          ${progressBar((ml.minutes || 0) / state.goals.mandarinMinutes)}
          <form class="row" data-form="mandarin-min"><input type="number" name="min" min="1" max="600" placeholder="Minutes" required><button class="btn">Add</button></form>
          <p class="hint">Count apps, podcasts, tutoring, shows — any focused Mandarin practice.</p>
        </div>
      </section>
      <section class="card">
        <div class="row between"><h2>Vocabulary</h2><input class="search" type="search" placeholder="Filter…" data-action="vocab-filter" value="${esc(session.vocabFilter)}"></div>
        <div class="table-wrap"><table class="vocab"><thead><tr><th>汉字</th><th>Pinyin</th><th>Meaning</th><th>Level</th><th></th></tr></thead><tbody>
        ${vocab.map(([h, p, m]) => {
          const c = state.cards[h];
          const lvl = c ? `<span class="pill b${c.box}">Box ${c.box}</span>` : `<span class="pill">New</span>`;
          return `<tr><td class="zh">${h}</td><td>${p}</td><td>${esc(m)}</td><td>${lvl}</td><td><button class="icon-btn" data-action="speak" data-text="${h}" aria-label="Play">🔊</button></td></tr>`;
        }).join("")}
        </tbody></table></div>
      </section>`;
  };

  function flashcard() {
    if (!session.queue.length) {
      return `<div class="flash empty"><p class="big">🎉</p><p>All caught up${session.done ? ` — ${session.done} card${session.done === 1 ? "" : "s"} reviewed this session` : ""}.</p>
        <p class="muted">New cards unlock tomorrow. Try the phrase of the day or log some listening practice.</p></div>`;
    }
    const h = session.queue[0];
    const [hz, py, mean, cat] = HSK1.find((v) => v[0] === h);
    const isNew = !state.cards[h];
    const front = session.reverse ? `<p class="meaning-front">${esc(mean)}</p>` : `<p class="zh huge">${hz}</p>`;
    const back = `<div class="back">${session.reverse ? `<p class="zh huge">${hz}</p>` : ""}<p class="pinyin">${py}</p>${session.reverse ? "" : `<p>${esc(mean)}</p>`}<p class="muted small">${cat}</p></div>`;
    return `<div class="flash">
      <div class="flash-meta"><span class="pill">${isNew ? "New" : `Box ${state.cards[h].box}`}</span><span class="muted">${session.queue.length} left</span></div>
      ${front}
      ${session.revealed ? back : ""}
      <div class="flash-actions">
        <button class="icon-btn" data-action="speak" data-text="${hz}" aria-label="Play">🔊</button>
        ${session.revealed
          ? `<button class="btn again" data-action="grade" data-grade="again">Again <kbd>1</kbd></button>
             <button class="btn good" data-action="grade" data-grade="good">Good <kbd>2</kbd></button>
             <button class="btn easy" data-action="grade" data-grade="easy">Easy <kbd>3</kbd></button>`
          : `<button class="btn primary" data-action="reveal">Show answer <kbd>Space</kbd></button>`}
      </div></div>`;
  }

  views.weight = () => {
    const s = weightStats();
    const p = state.profile;
    const t = today();
    const todays = state.habits[t] || {};
    return `
      <header class="page-head"><h1>Weight & Health</h1><p class="muted">Aim for a steady 0.25–1 kg per week. Weigh in at the same time each morning.</p></header>
      <section class="stats">
        ${stat("Current", s.latest != null ? `${fmt(s.latest)} kg` : "–")}
        ${stat("7-day avg", s.avg7 != null ? `${fmt(s.avg7)} kg` : "–")}
        ${stat("Lost so far", s.start != null && s.latest != null ? `${fmt(s.start - s.latest)} kg` : "–")}
        ${stat("Weekly rate", s.weeklyRate != null ? `${s.weeklyRate > 0 ? "+" : ""}${fmt(s.weeklyRate, 2)} kg` : "–")}
        ${stat("BMI", s.bmi != null ? `${fmt(s.bmi)} <small>${bmiLabel(s.bmi)}</small>` : "–")}
      </section>
      ${s.progress != null ? `<section class="card"><div class="row between"><h2>Progress to goal</h2><strong>${Math.round(s.progress * 100)}%</strong></div>${progressBar(s.progress)}
        <p class="muted">${fmt(s.start)} kg → ${fmt(s.goal)} kg${p.targetDate ? ` by ${shortDate(p.targetDate)} (${Math.max(0, daysBetween(t, p.targetDate))} days left)` : ""}</p></section>` : ""}
      <section class="grid2">
        <div class="card">
          <h2>Log weigh-in</h2>
          <form class="stack" data-form="weight">
            <label>Date <input type="date" name="date" value="${t}" max="${t}" required></label>
            <label>Weight (kg) <input type="number" name="kg" step="0.1" min="20" max="400" required></label>
            <button class="btn primary">Save</button>
          </form>
        </div>
        <div class="card">
          <h2>Today's habits</h2>
          <ul class="habits">${HABITS.map(([id, label]) => `<li><label><input type="checkbox" data-action="habit" data-habit="${id}" ${todays[id] ? "checked" : ""}> ${label}</label></li>`).join("")}</ul>
          <p class="hint">Weight loss is mostly a calorie deficit; these habits make it sustainable.</p>
        </div>
      </section>
      <section class="card"><h2>Trend</h2>${weightChart(s.ws, s.goal)}</section>
      <section class="grid2">
        <div class="card">
          <h2>Profile & goal</h2>
          <form class="stack" data-form="profile">
            <label>Height (cm) <input type="number" name="heightCm" min="100" max="250" value="${esc(p.heightCm)}"></label>
            <label>Starting weight (kg) <input type="number" name="startKg" step="0.1" value="${esc(p.startKg)}"></label>
            <label>Goal weight (kg) <input type="number" name="goalKg" step="0.1" value="${esc(p.goalKg)}"></label>
            <label>Target date <input type="date" name="targetDate" value="${esc(p.targetDate)}"></label>
            <button class="btn">Save goal</button>
          </form>
        </div>
        <div class="card">
          <h2>History</h2>
          ${s.ws.length ? `<div class="table-wrap short"><table><thead><tr><th>Date</th><th>kg</th><th>Δ</th><th></th></tr></thead><tbody>
          ${[...s.ws].reverse().map((w, i, arr) => {
            const prev = arr[i + 1];
            const delta = prev ? w.kg - prev.kg : null;
            return `<tr><td>${shortDate(w.date)}</td><td>${fmt(w.kg)}</td><td class="${delta > 0 ? "up" : delta < 0 ? "down" : ""}">${delta == null ? "" : (delta > 0 ? "+" : "") + fmt(delta)}</td><td><button class="icon-btn" data-action="del-weight" data-date="${w.date}" aria-label="Delete">✕</button></td></tr>`;
          }).join("")}</tbody></table></div>` : `<p class="muted">No entries yet.</p>`}
        </div>
      </section>`;
  };

  views.ai = () => {
    const t = today();
    const aiMin = state.aiLog[t] || 0;
    const weekMin = Array.from({ length: 7 }, (_, i) => state.aiLog[addDays(t, -i)] || 0).reduce((a, b) => a + b, 0);
    const next = nextModule();
    return `
      <header class="page-head"><h1>AI Governance & Architecture</h1><p class="muted">A structured path through governance frameworks and system design. Mark modules done and keep notes as you go.</p></header>
      <section class="stats">
        ${stat("Today", `${aiMin} min`)}
        ${stat("This week", `${weekMin} min`)}
        ${stat("Modules done", `${allModules().filter((m) => moduleDone(m.id)).length}/${allModules().length}`)}
        ${stat("Quiz best", `${state.quizBest}/${AI_QUIZ.length}`)}
        ${stat("Streak", `${streak(aiActive)} d`)}
      </section>
      <section class="grid2">
        <div class="card">
          <h2>Log study time</h2>
          ${progressBar(aiMin / state.goals.aiMinutes)}
          <p class="muted">${aiMin} / ${state.goals.aiMinutes} min today</p>
          <form class="row" data-form="ai-min"><input type="number" name="min" min="1" max="600" placeholder="Minutes" required><button class="btn">Add</button></form>
        </div>
        <div class="card">
          <h2>Up next</h2>
          ${next ? `<p><span class="pill">${next.track.name}</span></p><p><strong>${esc(next.title)}</strong></p><p class="muted">~${next.hours} h · ${next.topics.length} topics</p>` : `<p>🎓 You've completed every module. Revisit your notes and take the quiz again!</p>`}
        </div>
      </section>
      ${AI_TRACKS.map((track) => {
        const done = track.modules.filter((m) => moduleDone(m.id)).length;
        return `<section class="card">
          <div class="row between"><h2>${track.name}</h2><span class="muted">${done}/${track.modules.length}</span></div>
          ${progressBar(done / track.modules.length)}
          <div class="modules">${track.modules.map((m) => moduleCard(m)).join("")}</div>
        </section>`;
      }).join("")}
      <section class="card"><h2>Self-check quiz</h2>${quizView()}</section>`;
  };

  function moduleCard(m) {
    const prog = state.aiProgress[m.id] || {};
    return `<details class="module ${prog.done ? "done" : ""}">
      <summary><span class="check">${prog.done ? "✓" : ""}</span><span class="m-title">${esc(m.title)}</span><span class="muted small">~${m.hours} h</span></summary>
      <div class="module-body">
        <h4>Topics</h4><ul>${m.topics.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <h4>Resources</h4><ul>${m.resources.map(([n, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(n)} ↗</a></li>`).join("")}</ul>
        <h4>My notes</h4>
        <textarea data-action="ai-notes" data-module="${m.id}" rows="4" placeholder="Key takeaways, questions, how this applies to my work…">${esc(prog.notes || "")}</textarea>
        <label class="toggle"><input type="checkbox" data-action="ai-done" data-module="${m.id}" ${prog.done ? "checked" : ""}> Mark module complete</label>
      </div></details>`;
  }

  function quizView() {
    if (!quiz.order) resetQuiz();
    if (quiz.finished) {
      return `<p class="big">${quiz.score} / ${AI_QUIZ.length}</p><p class="muted">Best: ${state.quizBest} / ${AI_QUIZ.length}</p><button class="btn primary" data-action="quiz-restart">Try again</button>`;
    }
    const [q, opts, correct, why] = AI_QUIZ[quiz.order[quiz.idx]];
    return `<p class="muted small">Question ${quiz.idx + 1} of ${AI_QUIZ.length} · Score ${quiz.score}</p>
      <p class="q">${esc(q)}</p>
      <div class="options">${opts.map((o, i) => {
        let cls = "";
        if (quiz.answered != null) cls = i === correct ? "correct" : i === quiz.answered ? "wrong" : "";
        return `<button class="opt ${cls}" data-action="quiz-answer" data-i="${i}" ${quiz.answered != null ? "disabled" : ""}>${esc(o)}</button>`;
      }).join("")}</div>
      ${quiz.answered != null ? `<p class="explain">${quiz.answered === correct ? "✅ Correct. " : "❌ Not quite. "}${esc(why)}</p><button class="btn primary" data-action="quiz-next">${quiz.idx + 1 < AI_QUIZ.length ? "Next" : "See result"}</button>` : ""}`;
  }

  views.prefs = () => `
    <header class="page-head"><h1>Settings</h1></header>
    <section class="card">
      <h2>Profile & daily targets</h2>
      <form class="stack" data-form="settings">
        <label>Your name <input name="name" value="${esc(state.profile.name)}" placeholder="Optional"></label>
        <label>Mandarin practice (min/day) <input type="number" name="mandarinMinutes" min="1" value="${state.goals.mandarinMinutes}"></label>
        <label>New Mandarin cards per day <input type="number" name="newCards" min="0" max="50" value="${state.goals.newCards}"></label>
        <label>AI study (min/day) <input type="number" name="aiMinutes" min="1" value="${state.goals.aiMinutes}"></label>
        <button class="btn primary">Save</button>
      </form>
    </section>
    <section class="card">
      <h2>Your data</h2>
      <p class="muted">${sync.ref ? "Your data syncs to your claude.ai account, so it's the same on every device you sign in from." : "Your data is stored in this browser only. Export a backup regularly, or to move to another device."}</p>
      <div class="row wrap">
        <button class="btn" data-action="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept="application/json" data-action="import" hidden></label>
        <button class="btn danger" data-action="reset">Reset all data</button>
      </div>
    </section>`;

  const stat = (label, value) => `<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div></div>`;
  const progressBar = (f) => `<div class="bar"><span style="width:${Math.round(Math.max(0, Math.min(1, f || 0)) * 100)}%"></span></div>`;

  // ---------- Rendering & routing ----------
  const main = $("#main");
  function currentView() {
    const v = location.hash.replace("#", "");
    return views[v] ? v : "dashboard";
  }
  function render() {
    const v = currentView();
    // Preserve open <details> state across re-renders
    const open = [...main.querySelectorAll("details[open] textarea[data-module]")].map((t) => t.dataset.module);
    main.innerHTML = views[v]();
    open.forEach((id) => { const ta = main.querySelector(`textarea[data-module="${id}"]`); if (ta) ta.closest("details").open = true; });
    document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${v}`));
  }
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- Events ----------
  function doGrade(grade) {
    const h = session.queue.shift();
    gradeCard(h, grade);
    if (grade === "again") session.queue.push(h); // see it again this session
    session.revealed = false;
    session.done++;
    render();
  }

  // Two-tap confirmation (browser confirm() dialogs are blocked in some hosts)
  function confirmTap(el, label) {
    if (el.dataset.armed) return true;
    el.dataset.armed = "1";
    const old = el.innerHTML;
    el.innerHTML = label;
    el.classList.add("armed");
    setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.innerHTML = old; el.classList.remove("armed"); } }, 3000);
    return false;
  }

  async function exportBackup() {
    const json = JSON.stringify(state, null, 2);
    const filename = `growth-hub-backup-${today()}.json`;
    const dl = window.claude && typeof window.claude.use === "function" ? await window.claude.use("downloads") : null;
    if (dl) {
      try { await dl.save({ filename, data: json }); toast("Backup saved"); } catch (e) { toast("Backup not saved"); }
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  main.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const a = el.dataset.action;
    if (a === "speak") speak(el.dataset.text);
    else if (a === "reveal") { session.revealed = true; render(); }
    else if (a === "grade") doGrade(el.dataset.grade);
    else if (a === "del-weight") {
      if (confirmTap(el, "Delete?")) { state.weights = state.weights.filter((w) => w.date !== el.dataset.date); save(); render(); }
    } else if (a === "quiz-answer") {
      quiz.answered = Number(el.dataset.i);
      if (quiz.answered === AI_QUIZ[quiz.order[quiz.idx]][2]) quiz.score++;
      render();
    } else if (a === "quiz-next") {
      quiz.answered = null;
      if (quiz.idx + 1 < AI_QUIZ.length) quiz.idx++;
      else {
        quiz.finished = true;
        if (quiz.score > state.quizBest) { state.quizBest = quiz.score; save(); }
      }
      render();
    } else if (a === "quiz-restart") { resetQuiz(); render(); }
    else if (a === "export") exportBackup();
    else if (a === "reset") {
      if (confirmTap(el, "Tap again to delete everything")) { state = defaultState(); save(); session.queue = null; render(); toast("Data reset"); }
    }
  });

  main.addEventListener("change", (e) => {
    const el = e.target;
    const a = el.dataset.action;
    if (a === "reverse") { session.reverse = el.checked; session.revealed = false; render(); }
    else if (a === "habit") {
      const t = today();
      state.habits[t] = state.habits[t] || {};
      state.habits[t][el.dataset.habit] = el.checked;
      save();
    } else if (a === "ai-done") {
      const id = el.dataset.module;
      state.aiProgress[id] = { ...(state.aiProgress[id] || {}), done: el.checked };
      save(); render();
      if (el.checked) toast("Module complete — nice work!");
    } else if (a === "ai-notes") {
      const id = el.dataset.module;
      state.aiProgress[id] = { ...(state.aiProgress[id] || {}), notes: el.value };
      save(); toast("Notes saved");
    } else if (a === "import") {
      const file = el.files[0];
      if (!file) return;
      file.text().then((txt) => {
        const data = JSON.parse(txt);
        if (typeof data !== "object" || !Array.isArray(data.weights)) throw new Error("bad");
        const base = defaultState();
        state = { ...base, ...data, profile: { ...base.profile, ...data.profile }, goals: { ...base.goals, ...data.goals } };
        save(); session.queue = null; render(); toast("Backup imported");
      }).catch(() => toast("That file isn't a valid backup"));
    }
  });

  main.addEventListener("input", (e) => {
    if (e.target.dataset.action === "vocab-filter") {
      session.vocabFilter = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = main.querySelector('[data-action="vocab-filter"]');
      inp.focus(); inp.setSelectionRange(pos, pos);
    }
  });

  main.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    const data = Object.fromEntries(new FormData(f));
    const kind = f.dataset.form;
    if (kind === "weight") {
      const kg = Math.round(Number(data.kg) * 10) / 10;
      state.weights = state.weights.filter((w) => w.date !== data.date).concat({ date: data.date, kg });
      if (!state.profile.startKg && state.weights.length === 1) state.profile.startKg = kg;
      save(); render(); toast("Weigh-in saved");
    } else if (kind === "profile") {
      Object.assign(state.profile, data);
      save(); render(); toast("Goal saved");
    } else if (kind === "mandarin-min") {
      logMandarin("minutes", Number(data.min));
      save(); render(); toast(`+${data.min} min Mandarin`);
    } else if (kind === "ai-min") {
      const t = today();
      state.aiLog[t] = (state.aiLog[t] || 0) + Number(data.min);
      save(); render(); toast(`+${data.min} min AI study`);
    } else if (kind === "settings") {
      state.profile.name = data.name.trim();
      state.goals.mandarinMinutes = Math.max(1, Number(data.mandarinMinutes) || 15);
      state.goals.aiMinutes = Math.max(1, Number(data.aiMinutes) || 30);
      state.goals.newCards = Math.max(0, Number(data.newCards) || 0);
      session.queue = null;
      save(); render(); toast("Settings saved");
    }
  });

  // Keyboard shortcuts for flashcards
  document.addEventListener("keydown", (e) => {
    if (currentView() !== "mandarin" || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !session.queue || !session.queue.length) return;
    if (e.code === "Space" && !session.revealed) { e.preventDefault(); session.revealed = true; render(); }
    else if (session.revealed && ["1", "2", "3"].includes(e.key)) doGrade(["again", "good", "easy"][Number(e.key) - 1]);
  });

  render();
  setSyncStatus("local");
  initSync();
})();
