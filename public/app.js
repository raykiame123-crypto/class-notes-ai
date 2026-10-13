// ---------- Storage (lessons live in this browser) ----------
const STORE_KEY = "class-notes-ai:lessons";
const DRAFT_KEY = "class-notes-ai:draft";

function loadLessons() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function saveLessons(lessons) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(lessons)); } catch { /* storage full or blocked */ }
}
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ transcript: $("#transcript").value, subject: $("#subject").value }));
  } catch { /* ignore */ }
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// Escape, then turn **bold** into <strong>.
function rich(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
function colorVars(color) {
  const c = COLORS.includes(color) ? color : "blue";
  return `--c: var(--${c}); --soft: var(--${c}-soft);`;
}

// ---------- Navigation ----------
function show(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  window.scrollTo(0, 0);
  if (view === "home") renderHome();
}
$$("[data-go]").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.go === "home" && listening) stopListening();
  show(b.dataset.go);
}));

// ---------- Home ----------
function renderHome() {
  const lessons = loadLessons();
  const list = $("#lesson-list");
  if (!lessons.length) {
    list.innerHTML = `<p class="empty">No lessons yet. Tap “New lesson” when class starts!</p>`;
    return;
  }
  list.innerHTML = lessons.map((l) => `
    <button class="lesson-card" data-id="${l.id}" style="${colorVars(l.course.pages?.[0]?.color)}">
      <b>${escapeHtml(l.course.title)}</b>
      <small>${escapeHtml(l.course.subject)} · ${new Date(l.createdAt).toLocaleDateString()}</small>
    </button>`).join("");
  $$(".lesson-card").forEach((card) => card.addEventListener("click", () => openLesson(card.dataset.id)));
}

// ---------- Recording (browser speech recognition) ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let startedAt = 0;
let timerId = null;
let wakeLock = null;

if (!SpeechRecognition) {
  $("#no-speech").hidden = false;
  $("#mic").disabled = true;
}

function appendFinal(text) {
  const box = $("#transcript");
  const sep = box.value && !box.value.endsWith(" ") ? " " : "";
  box.value += sep + text.trim();
  box.scrollTop = box.scrollHeight;
  saveDraft();
}

function startListening() {
  recognition = new SpeechRecognition();
  recognition.lang = $("#lang").value;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) appendFinal(r[0].transcript);
      else interim += r[0].transcript;
    }
    $("#interim").textContent = interim;
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopListening();
      $("#mic-status").textContent = "Microphone blocked. Allow microphone access in your browser settings.";
    }
  };
  // Browsers stop listening after a pause or a minute or so; keep going until the student taps stop.
  recognition.onend = () => {
    if (listening) {
      try { recognition.start(); } catch { /* already restarting */ }
    }
  };

  recognition.start();
  listening = true;
  startedAt = Date.now();
  timerId = setInterval(updateTimer, 1000);
  $("#mic").classList.add("on");
  $("#mic").setAttribute("aria-label", "Stop recording");
  $("#mic-status").textContent = "Listening… tap again to stop";
  $("#lang").disabled = true;

  // Keep the screen on during class so the phone doesn't stop listening.
  navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => {});
}

function stopListening() {
  listening = false;
  recognition?.stop();
  clearInterval(timerId);
  $("#mic").classList.remove("on");
  $("#mic").setAttribute("aria-label", "Start recording");
  $("#mic-status").textContent = "Stopped. Tap the microphone to continue, or make your course.";
  $("#interim").textContent = "";
  $("#lang").disabled = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function updateTimer() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $("#timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

$("#mic").addEventListener("click", () => (listening ? stopListening() : startListening()));
$("#transcript").addEventListener("input", saveDraft);
$("#subject").addEventListener("input", saveDraft);

// The wake lock is dropped when the tab is hidden; take it again when the student comes back.
document.addEventListener("visibilitychange", () => {
  if (listening && document.visibilityState === "visible") {
    navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => {});
  }
});

// ---------- Make the course ----------
$("#make").addEventListener("click", async () => {
  if (listening) stopListening();
  const transcript = $("#transcript").value.trim();
  const subject = $("#subject").value.trim();
  $("#make-error").hidden = true;
  if (!transcript) {
    $("#make-error").textContent = "There's nothing yet. Record the teacher or paste the lesson first.";
    $("#make-error").hidden = false;
    return;
  }

  $("#make").disabled = true;
  $("#make-status").hidden = false;
  try {
    const res = await fetch("/api/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, subject }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");

    const lesson = { id: String(Date.now()), createdAt: Date.now(), transcript, course: data.course };
    saveLessons([lesson, ...loadLessons()]);
    clearDraft();
    $("#transcript").value = "";
    $("#subject").value = "";
    $("#timer").textContent = "00:00";
    openLesson(lesson.id);
  } catch (err) {
    $("#make-error").textContent = err.message;
    $("#make-error").hidden = false;
  } finally {
    $("#make").disabled = false;
    $("#make-status").hidden = true;
  }
});

// ---------- Course view ----------
let current = null;
let pageIndex = 0;

function openLesson(id) {
  current = loadLessons().find((l) => l.id === id);
  if (!current) return show("home");
  const c = current.course;
  $("#course-subject").textContent = c.subject;
  $("#course-title").textContent = c.title;
  $("#course-summary").textContent = c.summary;
  pageIndex = 0;
  renderPage();
  $("#all-pages").innerHTML = c.pages.map(pageHtml).join("");
  renderVocab(c);
  renderCards(c);
  renderQuiz(c);
  renderTips(c);
  selectTab("pages");
  show("course");
}

function pageHtml(p) {
  return `
    <article class="page" style="${colorVars(p.color)}">
      <div class="page-top">
        <div class="page-emoji">${escapeHtml(p.emoji)}</div>
        <h2>${escapeHtml(p.heading)}</h2>
      </div>
      <p class="intro">${rich(p.intro)}</p>
      <ul>${p.points.map((pt) => `<li>${rich(pt)}</li>`).join("")}</ul>
      ${p.example ? `<div class="example">💬 <b>Example:</b> ${rich(p.example)}</div>` : ""}
      <div class="key-idea">⭐ Remember: ${rich(p.keyIdea)}</div>
    </article>`;
}

function renderPage() {
  const pages = current.course.pages;
  $("#page").innerHTML = pageHtml(pages[pageIndex]);
  $("#page-num").textContent = `Page ${pageIndex + 1} of ${pages.length}`;
  $("#prev").disabled = pageIndex === 0;
  $("#next").disabled = pageIndex === pages.length - 1;
}
$("#prev").addEventListener("click", () => { if (pageIndex > 0) { pageIndex--; renderPage(); } });
$("#next").addEventListener("click", () => {
  if (pageIndex < current.course.pages.length - 1) { pageIndex++; renderPage(); }
});

function renderVocab(c) {
  $("#tab-vocab").innerHTML = c.vocabulary.length
    ? `<div class="vocab-grid">${c.vocabulary.map((v, i) => `
        <div class="vocab" style="${colorVars(COLORS[i % COLORS.length])}">
          <b>${escapeHtml(v.term)}</b><div>${rich(v.definition)}</div>
        </div>`).join("")}</div>`
    : `<p class="empty">No new words in this lesson.</p>`;
}

function renderCards(c) {
  let i = 0;
  const panel = $("#tab-cards");
  const draw = () => {
    const card = c.flashcards[i];
    panel.innerHTML = `
      <div class="flashcard" id="fc">
        <div class="flashcard-inner">
          <div class="face front">${rich(card.front)}</div>
          <div class="face back">${rich(card.back)}</div>
        </div>
      </div>
      <p class="card-hint">Tap the card to flip it · ${i + 1} / ${c.flashcards.length}</p>
      <div class="pager">
        <button class="btn btn-ghost" id="fc-prev" ${i === 0 ? "disabled" : ""}>◀ Back</button>
        <button class="btn btn-ghost" id="fc-shuffle">🔀 Shuffle</button>
        <button class="btn btn-ghost" id="fc-next" ${i === c.flashcards.length - 1 ? "disabled" : ""}>Next ▶</button>
      </div>`;
    $("#fc").addEventListener("click", () => $("#fc").classList.toggle("flipped"));
    $("#fc-prev").addEventListener("click", () => { i--; draw(); });
    $("#fc-next").addEventListener("click", () => { i++; draw(); });
    $("#fc-shuffle").addEventListener("click", () => {
      c.flashcards.sort(() => Math.random() - 0.5);
      i = 0;
      draw();
    });
  };
  if (c.flashcards.length) draw();
  else panel.innerHTML = `<p class="empty">No flashcards for this lesson.</p>`;
}

function renderQuiz(c) {
  const panel = $("#tab-quiz");
  let answered = 0;
  let correct = 0;
  panel.innerHTML = c.quiz.map((q, qi) => `
    <div class="question" data-q="${qi}">
      <h3>${qi + 1}. ${rich(q.question)}</h3>
      ${q.options.map((o, oi) => `<button class="option" data-o="${oi}">${rich(o)}</button>`).join("")}
      <div class="explain" hidden>${rich(q.explanation)}</div>
    </div>`).join("") + `<p class="score" id="score"></p>`;

  $$("#tab-quiz .question").forEach((box) => {
    const q = c.quiz[Number(box.dataset.q)];
    box.querySelectorAll(".option").forEach((btn) => btn.addEventListener("click", () => {
      if (box.dataset.done) return;
      box.dataset.done = "1";
      const picked = Number(btn.dataset.o);
      box.querySelectorAll(".option")[q.answerIndex]?.classList.add("right");
      if (picked === q.answerIndex) correct++;
      else btn.classList.add("wrong");
      box.querySelector(".explain").hidden = false;
      answered++;
      if (answered === c.quiz.length) {
        const pct = Math.round((correct / c.quiz.length) * 100);
        const msg = pct === 100 ? "🏆 Perfect!" : pct >= 70 ? "🎉 Great job!" : "💪 Keep revising, you've got this!";
        $("#score").textContent = `${correct} / ${c.quiz.length} — ${msg}`;
      }
    }));
  });
}

function renderTips(c) {
  $("#tab-tips").innerHTML = c.tips.map((t) => `<div class="tip">💡 ${rich(t)}</div>`).join("")
    || `<p class="empty">No tips for this lesson.</p>`;
}

function selectTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => selectTab(t.dataset.tab)));

$("#print").addEventListener("click", () => window.print());
$("#delete").addEventListener("click", () => {
  if (!confirm("Delete this lesson?")) return;
  saveLessons(loadLessons().filter((l) => l.id !== current.id));
  show("home");
});

// ---------- Start ----------
const draft = loadDraft();
if (draft.transcript) $("#transcript").value = draft.transcript;
if (draft.subject) $("#subject").value = draft.subject;
show("home");
