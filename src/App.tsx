import { useEffect, useRef, useState, useCallback, useMemo } from "react";

// ── types ──────────────────────────────────────────────────────────────────
type Speed = "fast" | "ok" | "slow" | "skip";
type Ans = "A" | "B" | "C" | "D" | null;
type SessionType = "practice" | "mock";

interface Question {
  num: number;
  answer: Ans;
  speed: Speed;
  timeSec: number;
  isGuess?: boolean;
}

interface SessionStats {
  mean: number;
  median: number;
  variance: number;
  stdDev: number;
  diffDist: Record<string, number>;
}

interface Session {
  id: number;
  date: string;
  startTimestamp?: number;
  sessionType: SessionType;
  subject: string;
  chapter: string;
  source: string;
  totalQ: number | null;
  totalTimeSec: number;
  questions: Question[];
  answerKey: Record<number, string>;
  stats?: SessionStats;
}

// ── constants ──────────────────────────────────────────────────────────────
const FAST_MAX = 30;
const OK_MAX = 60;

function speedOf(sec: number): Speed {
  if (sec <= FAST_MAX) return "fast";
  if (sec <= OK_MAX) return "ok";
  return "slow";
}

// ── Design tokens ──────────────────────────────────────────────────────────
const C = {
  bg: "#0b0b0b",
  surface: "#111111",
  surface2: "#181818",
  surface3: "#1f1f1f",
  border: "#222222",
  border2: "#2e2e2e",
  text: "#e8e8e8",
  dim: "#444",
  dim2: "#666",
  dim3: "#888",
  accent: "#e8ff47",
  neonGreen: "#39ff14",
  neonOrange: "#ff6b00",
  neonRed: "#ff2d55",
  neonBlue: "#00d4ff",
  neonPurple: "#bf5fff",
} as const;

const SPEED_COLORS: Record<string, string> = {
  fast: C.neonGreen, ok: C.neonOrange, slow: C.neonRed, skip: C.dim,
};
const ANS_COLORS: Record<string, string> = {
  A: C.accent, B: C.neonBlue, C: C.neonGreen, D: C.neonOrange,
};
const CHART_COLORS = {
  acc: C.accent, daily: C.neonOrange, time: C.neonBlue,
  fast: C.neonGreen, ok: C.neonOrange, slow: C.neonRed,
  subj: C.neonGreen, cum: C.neonPurple,
};


// ── storage ────────────────────────────────────────────────────────────────
function getHistory(): Session[] {
  try { return JSON.parse(localStorage.getItem("kcet_h") || "[]"); } catch { return []; }
}
function saveHistory(h: Session[]) { localStorage.setItem("kcet_h", JSON.stringify(h)); }

const DRAFTS_KEY = "kcet_drafts";
interface Draft {
  draftId: string;          // unique id for this draft
  sessionType: SessionType;
  subject: string; chapter: string; source: string; totalQInput: string;
  questions: Question[]; totalLoggedSec: number; savedAt: string;
  startTimestamp: number;
}
function getDrafts(): Draft[] {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "[]"); } catch { return []; }
}
function saveDraftToList(d: Draft) {
  const all = getDrafts();
  const idx = all.findIndex((x) => x.draftId === d.draftId);
  if (idx >= 0) all[idx] = d; else all.unshift(d);
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}
function removeDraft(draftId: string) {
  const all = getDrafts().filter((x) => x.draftId !== draftId);
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}
// Legacy single-draft migration: on first load, absorb old single draft if present
function migrateLegacyDraft() {
  const raw = localStorage.getItem("kcet_draft");
  if (!raw) return;
  try {
    const old = JSON.parse(raw) as Draft;
    if (!old.draftId) { old.draftId = String(old.startTimestamp || Date.now()); saveDraftToList(old); }
  } catch { /* ignore */ }
  localStorage.removeItem("kcet_draft");
}

// ── stats helpers ──────────────────────────────────────────────────────────
function calcStats(questions: Question[]): SessionStats {
  const times = questions.map(q => q.timeSec);
  const n = times.length;
  const mean = n ? Math.round(times.reduce((a, b) => a + b, 0) / n) : 0;
  const sorted = [...times].sort((a, b) => a - b);
  const median = n ? (n % 2 === 0 ? Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2) : sorted[Math.floor(n / 2)]) : 0;
  const variance = n ? Math.round(times.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const stdDev = Math.round(Math.sqrt(variance));
  const diffDist: Record<string, number> = { fast: 0, ok: 0, slow: 0 };
  questions.forEach(q => { if (q.speed !== "skip") diffDist[q.speed] = (diffDist[q.speed] || 0) + 1; });
  return { mean, median, variance, stdDev, diffDist };
}

// ── SCORE system ───────────────────────────────────────────────────────────
// KCET standard: 60s per question (180Q / 180min).
// Speed score: efficiency vs KCET pace.
//   solved in 30s → 2× KCET speed → 100 pts
//   solved in 60s → 1× KCET speed → 50 pts  (baseline)
//   solved in 120s→ 0.5× speed   → 25 pts
// After answer key: finalScore = speedScore×0.4 + accuracy%×0.6
function calcScore(questions: Question[], answerKey?: Record<number, string>): number {
  const qs = questions.filter(q => q.speed !== "skip" && q.timeSec > 0);
  if (!qs.length) return 0;
  const KCET_SEC = 60; // KCET baseline
  const speedScore = qs.reduce((sum, q) => {
    const efficiency = Math.min(KCET_SEC / q.timeSec, 2.0); // cap at 2× (30s or faster)
    return sum + efficiency * 50;
  }, 0) / qs.length;
  if (answerKey && Object.keys(answerKey).length > 0) {
    let cor = 0, tot = 0;
    questions.forEach(q => { if (answerKey[q.num]) { tot++; if (q.answer === answerKey[q.num]) cor++; } });
    const accuracy = tot > 0 ? (cor / tot) * 100 : null;
    if (accuracy !== null) return Math.round(speedScore * 0.4 + accuracy * 0.6);
  }
  return Math.round(speedScore);
}
function scoreCol(s: number): string {
  return s >= 80 ? C.neonGreen : s >= 50 ? C.neonOrange : C.neonRed;
}


// ── format helpers ─────────────────────────────────────────────────────────
function fmt2(sec: number) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function fmtHMS(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}
function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// ── shared button styles ───────────────────────────────────────────────────
const BTN_BASE: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600,
  letterSpacing: ".08em", textTransform: "uppercase", padding: "6px 14px",
  borderRadius: 2, cursor: "pointer", transition: "all .12s", whiteSpace: "nowrap",
};
const btnPrimary = (flash?: boolean): React.CSSProperties => ({ ...BTN_BASE, background: flash ? C.neonGreen : C.accent, color: "#000", border: `1px solid ${flash ? C.neonGreen : C.accent}` });
const btnOutline = (): React.CSSProperties => ({ ...BTN_BASE, background: "transparent", color: C.dim3, border: `1px solid ${C.border2}` });
const btnDanger = (): React.CSSProperties => ({ ...BTN_BASE, background: "transparent", color: C.neonRed, border: `1px solid ${C.neonRed}` });

// ── card / surface ─────────────────────────────────────────────────────────
const card = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 3, ...extra,
});

// ══════════════════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════════════════
export function App() {
  const [tab, setTab] = useState<"session" | "check" | "history" | "graphs">("session");
  const [checkSessId, setCheckSessId] = useState<number | null>(null);
  const [checkKey, setCheckKey] = useState<Record<number, string>>({});
  const [historyVersion, setHistoryVersion] = useState(0);

  function refreshHistory() { setHistoryVersion((v) => v + 1); }

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, minHeight: "100vh" }}>
      <GlobalStyles />
      <nav style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 24px", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, background: C.bg, zIndex: 300 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: C.accent, letterSpacing: ".18em" }}>KCET·TRACKER</div>
        <div style={{ display: "flex", gap: 2 }}>
          {(["session", "check", "history", "graphs"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={tab === t ? "nav-tab-active" : "nav-tab"} style={{
              background: tab === t ? "rgba(232,255,71,.07)" : "none",
              border: `1px solid ${tab === t ? C.accent : "transparent"}`,
              color: tab === t ? C.accent : C.dim,
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 10,
              padding: "5px 16px", cursor: "pointer", borderRadius: 2,
              letterSpacing: ".08em", textTransform: "uppercase", transition: "all .12s",
            }}>
              {t === "session" ? "Session" : t === "check" ? "Check" : t === "history" ? "History" : "Graphs"}
            </button>
          ))}
        </div>
      </nav>

      {tab === "session" && (
        <SessionPage onSave={(id) => { setCheckSessId(id); setCheckKey({}); setTab("check"); refreshHistory(); }} />
      )}
      {tab === "check" && (
        <CheckPage initSessId={checkSessId} initKey={checkKey}
          onSessChange={(id, key) => { setCheckSessId(id); setCheckKey(key); }}
          onKeySaved={refreshHistory} />
      )}
      {tab === "history" && (
        <HistoryPage version={historyVersion}
          onGoCheck={(id) => { setCheckSessId(id); setCheckKey({}); setTab("check"); }}
          onDelete={refreshHistory} />
      )}
      {tab === "graphs" && <GraphsPage version={historyVersion} />}
    </div>
  );
}

// ── global styles ──────────────────────────────────────────────────────────
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@300;400;500&display=swap');
      *{box-sizing:border-box;margin:0;padding:0;}
      body{background:#0b0b0b;}
      ::-webkit-scrollbar{width:5px;height:5px;}
      ::-webkit-scrollbar-track{background:#111;}
      ::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:3px;}
      ::-webkit-scrollbar-thumb:hover{background:#3a3a3a;}
      input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}
      input,textarea,select{transition:border-color .15s,box-shadow .15s;}
      input:focus,textarea:focus{outline:none;border-color:#e8ff47!important;box-shadow:0 0 0 2px rgba(232,255,71,.08)!important;}
      .nav-tab:hover{color:#aaa!important;border-color:#2e2e2e!important;}
      .nav-tab-active:hover{color:#e8ff47!important;}
      .btn-outline-h:hover{border-color:#888!important;color:#e8e8e8!important;}
      .btn-danger-h:hover{background:#ff2d55!important;color:#fff!important;}
      .btn-primary-h:hover{opacity:.85;}
      .btn-accent-sm-h:hover{background:rgba(232,255,71,.12)!important;}
      .ans-a:hover{border-color:#e8ff47!important;color:#e8ff47!important;background:rgba(232,255,71,.07)!important;}
      .ans-b:hover{border-color:#00d4ff!important;color:#00d4ff!important;background:rgba(0,212,255,.07)!important;}
      .ans-c:hover{border-color:#39ff14!important;color:#39ff14!important;background:rgba(57,255,20,.07)!important;}
      .ans-d:hover{border-color:#ff6b00!important;color:#ff6b00!important;background:rgba(255,107,0,.07)!important;}
      .preset-h:hover{border-color:#e8ff47!important;color:#e8ff47!important;}
      .hist-row:hover{background:#161616!important;}
      .corr-h:hover{border-color:#e8e8e8!important;color:#e8e8e8!important;}
      .type-card-h:hover{border-color:#e8ff47!important;background:#141414!important;}
      .q-log-row:hover{background:#161616!important;}
      .edit-field:focus{outline:none;border-color:#e8ff47!important;box-shadow:0 0 0 2px rgba(232,255,71,.08)!important;}
      .grp-btn:hover{border-color:#e8ff47!important;color:#e8ff47!important;}
      .sess-check-h:hover{background:#1a1a1a!important;}
      .suggestion-item:hover{background:#1e1e1e!important;color:#e8e8e8!important;}
      .filter-tag:hover{border-color:#e8ff47!important;color:#e8ff47!important;}
      .hist-group-hd:hover{background:#161616!important;}
      .undo-btn:hover{background:rgba(232,255,71,.12)!important;}
    `}</style>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SESSION PAGE
// ══════════════════════════════════════════════════════════════════════════
type Phase = "type-select" | "setup" | "active" | "result";

function SessionPage({ onSave }: { onSave: (id: number) => void }) {
  const [phase, setPhase] = useState<Phase>("type-select");
  const [sessionType, setSessionType] = useState<SessionType>("practice");
  const [subject, setSubject] = useState("");
  const [chapter, setChapter] = useState("");
  const [source, setSource] = useState("");
  const [totalQInput, setTotalQInput] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [totalLoggedSec, setTotalLoggedSec] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [sessDisplay, setSessDisplay] = useState("00:00:00");
  const [qDisplay, setQDisplay] = useState("00:00");
  const [qIsBreak, setQIsBreak] = useState(false);
  const [speedPct, setSpeedPct] = useState(0);
  const [speedCol, setSpeedCol] = useState<string>(C.neonGreen);
  const [flashAns, setFlashAns] = useState<Ans>(null);
  const [undoStack, setUndoStack] = useState<{ questions: Question[]; totalLoggedSec: number } | null>(null);

  useEffect(() => {
    migrateLegacyDraft();
    const all = getDrafts().filter((d) => d.questions.length > 0);
    setDrafts(all);
  }, []);

  const sessionOriginRef = useRef(0);
  const qOriginRef = useRef(0);
  const isPausedRef = useRef(false);
  const pauseStartRef = useRef(0);
  const totalLoggedRef = useRef(0);
  const questionsRef = useRef<Question[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const totalQRef = useRef<number | null>(null);
  const subjectRef = useRef("");
  const chapterRef = useRef("");
  const sourceRef = useRef("");
  const currentDraftIdRef = useRef<string | null>(null);
  const totalQInputRef = useRef("");
  const sessionTypeRef = useRef<SessionType>("practice");
  const startTimestampRef = useRef(0);

  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  useEffect(() => { totalLoggedRef.current = totalLoggedSec; }, [totalLoggedSec]);
  useEffect(() => { questionsRef.current = questions; }, [questions]);
  useEffect(() => { totalQRef.current = parseInt(totalQInput) || null; }, [totalQInput]);
  useEffect(() => { subjectRef.current = subject; }, [subject]);
  useEffect(() => { chapterRef.current = chapter; }, [chapter]);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => { totalQInputRef.current = totalQInput; }, [totalQInput]);
  useEffect(() => { sessionTypeRef.current = sessionType; }, [sessionType]);

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      if (isPausedRef.current) return;
      const now = Date.now();
      const rawQSec = Math.floor((now - qOriginRef.current) / 1000);
      if (rawQSec < 0) {
        setQDisplay("00:00");
        setQIsBreak(true);
        setSessDisplay(fmtHMS(totalLoggedRef.current));
        setSpeedPct(0); setSpeedCol(C.neonGreen);
        return;
      }
      setQIsBreak(false);
      const sessSec = totalLoggedRef.current + rawQSec;
      setSessDisplay(fmtHMS(sessSec));
      setQDisplay(fmt2(rawQSec));
      let pct: number, col: string;
      if (rawQSec <= FAST_MAX) { pct = (rawQSec / FAST_MAX) * 50; col = C.neonGreen; }
      else if (rawQSec <= OK_MAX) { pct = 50 + ((rawQSec - FAST_MAX) / (OK_MAX - FAST_MAX)) * 50; col = C.neonOrange; }
      else { pct = 100; col = C.neonRed; }
      setSpeedPct(pct); setSpeedCol(col);
    }, 500);
  }, [stopTick]);

  useEffect(() => () => stopTick(), [stopTick]);

  function doStartSession() {
    const subOk = subject.trim();
    const chapOk = chapter.trim();
    if (!subOk) { alert("Subject is required."); return; }
    if (sessionType === "practice" && !chapOk) { alert("Chapter is required."); return; }
    const now = Date.now();
    const newDraftId = String(now);
    currentDraftIdRef.current = newDraftId;
    startTimestampRef.current = now;
    sessionOriginRef.current = now; qOriginRef.current = now;
    totalLoggedRef.current = 0; questionsRef.current = [];
    setQuestions([]); setTotalLoggedSec(0);
    setIsPaused(false); isPausedRef.current = false;
    setSessDisplay("00:00:00"); setQDisplay("00:00");
    setSpeedPct(0); setSpeedCol(C.neonGreen);
    setUndoStack(null);
    setPhase("active"); startTick();
  }

  const doTogglePause = useCallback(() => {
    if (!isPausedRef.current) {
      isPausedRef.current = true; pauseStartRef.current = Date.now(); setIsPaused(true);
    } else {
      const d = Date.now() - pauseStartRef.current;
      sessionOriginRef.current += d; qOriginRef.current += d;
      isPausedRef.current = false; setIsPaused(false);
    }
  }, []);

  const doIncreaseTotalQ = useCallback(() => {
    const cur = parseInt(totalQInputRef.current) || 0;
    const next = cur + 1;
    totalQRef.current = next;
    totalQInputRef.current = String(next);
    setTotalQInput(String(next));
  }, []);

  const doDecreaseTotalQ = useCallback(() => {
    const cur = parseInt(totalQInputRef.current) || 0;
    const next = Math.max(questionsRef.current.length, cur - 1);
    if (next === 0) return;
    totalQRef.current = next;
    totalQInputRef.current = String(next);
    setTotalQInput(String(next));
  }, []);

  const removeQuestion = useCallback((num: number) => {
    const prev = questionsRef.current;
    const prevLogged = totalLoggedRef.current;
    setUndoStack({ questions: prev, totalLoggedSec: prevLogged });

    const qToRemove = prev.find(q => q.num === num);
    const timeToRemove = qToRemove ? qToRemove.timeSec : 0;
    const filtered = prev.filter(q => q.num !== num).map((q, i) => ({ ...q, num: i + 1 }));
    const newLogged = Math.max(0, prevLogged - timeToRemove);

    questionsRef.current = filtered;
    totalLoggedRef.current = newLogged;
    setQuestions(filtered);
    setTotalLoggedSec(newLogged);
    if (currentDraftIdRef.current) saveDraftToList({ draftId: currentDraftIdRef.current, sessionType: sessionTypeRef.current, subject: subjectRef.current, chapter: chapterRef.current, source: sourceRef.current, totalQInput: totalQInputRef.current, questions: filtered, totalLoggedSec: newLogged, savedAt: new Date().toISOString(), startTimestamp: startTimestampRef.current });
  }, []);

  const doUndo = useCallback(() => {
    setUndoStack(prev => {
      if (!prev) return null;
      questionsRef.current = prev.questions;
      totalLoggedRef.current = prev.totalLoggedSec;
      setQuestions(prev.questions);
      setTotalLoggedSec(prev.totalLoggedSec);
      if (currentDraftIdRef.current) saveDraftToList({ draftId: currentDraftIdRef.current, sessionType: sessionTypeRef.current, subject: subjectRef.current, chapter: chapterRef.current, source: sourceRef.current, totalQInput: totalQInputRef.current, questions: prev.questions, totalLoggedSec: prev.totalLoggedSec, savedAt: new Date().toISOString(), startTimestamp: startTimestampRef.current });
      return null;
    });
  }, []);

  const editQuestionAnswer = useCallback((num: number, newAns: Ans) => {
    const updated = questionsRef.current.map((q) => q.num === num ? { ...q, answer: newAns } : q);
    questionsRef.current = updated; setQuestions(updated);
    qOriginRef.current = Date.now() + 3000; // 3-sec grace before timer starts
    setSpeedPct(0); setSpeedCol(C.neonGreen);
    if (currentDraftIdRef.current) saveDraftToList({ draftId: currentDraftIdRef.current, sessionType: sessionTypeRef.current, subject: subjectRef.current, chapter: chapterRef.current, source: sourceRef.current, totalQInput: totalQInputRef.current, questions: updated, totalLoggedSec: totalLoggedRef.current, savedAt: new Date().toISOString(), startTimestamp: startTimestampRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleQuestionGuess = useCallback((num: number) => {
    const updated = questionsRef.current.map((q) => q.num === num ? { ...q, isGuess: !q.isGuess } : q);
    questionsRef.current = updated; setQuestions(updated);
    qOriginRef.current = Date.now() + 3000; // 3-sec grace before timer starts
    setSpeedPct(0); setSpeedCol(C.neonGreen);
    if (currentDraftIdRef.current) saveDraftToList({ draftId: currentDraftIdRef.current, sessionType: sessionTypeRef.current, subject: subjectRef.current, chapter: chapterRef.current, source: sourceRef.current, totalQInput: totalQInputRef.current, questions: updated, totalLoggedSec: totalLoggedRef.current, savedAt: new Date().toISOString(), startTimestamp: startTimestampRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doStop = useCallback(() => {
    if (questionsRef.current.length === 0) { alert("Log at least one question before stopping."); return; }
    stopTick(); setPhase("result");
  }, [stopTick]);

  // Back from result to active session
  const doBackToActive = useCallback(() => {
    const now = Date.now();
    sessionOriginRef.current = now; qOriginRef.current = now;
    setPhase("active"); startTick();
  }, [startTick]);

  const doSelectAnswer = useCallback((ans: Ans, isGuess = false) => {
    if (isPausedRef.current || ans === null) return;
    const tq = totalQRef.current;
    if (tq !== null && questionsRef.current.length >= tq) return;
    const timeSec = Math.max(0, Math.floor((Date.now() - qOriginRef.current) / 1000));
    const speed = speedOf(timeSec);
    totalLoggedRef.current += timeSec;
    setTotalLoggedSec(totalLoggedRef.current);
    const newQ: Question = { num: questionsRef.current.length + 1, answer: ans, speed, timeSec, isGuess };
    const updated = [...questionsRef.current, newQ];
    questionsRef.current = updated; setQuestions(updated);
    setUndoStack(null);
    if (currentDraftIdRef.current) saveDraftToList({ draftId: currentDraftIdRef.current, sessionType: sessionTypeRef.current, subject: subjectRef.current, chapter: chapterRef.current, source: sourceRef.current, totalQInput: totalQInputRef.current, questions: updated, totalLoggedSec: totalLoggedRef.current, savedAt: new Date().toISOString(), startTimestamp: startTimestampRef.current });
    setFlashAns(ans); setTimeout(() => setFlashAns(null), 180);
    setSpeedPct(0); setSpeedCol(C.neonGreen);
    qOriginRef.current = Date.now();
    if (tq !== null && updated.length >= tq) setTimeout(() => doStop(), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function doSave() {
    const h = getHistory();
    const id = Date.now();
    const qs = questionsRef.current;
    const startTs = startTimestampRef.current || id;
    const startIso = new Date(startTs).toISOString();
    const stats = calcStats(qs);
    h.unshift({
      id, date: startIso, startTimestamp: startTs,
      sessionType, subject: subject.trim(), chapter: chapter.trim(), source: source.trim(),
      totalQ: parseInt(totalQInput) || qs.length, totalTimeSec: totalLoggedRef.current,
      questions: qs.map((q) => ({ num: q.num, answer: q.answer, speed: q.speed, timeSec: q.timeSec, isGuess: q.isGuess ?? false })),
      answerKey: {}, stats,
    });
    saveHistory(h);
    if (currentDraftIdRef.current) removeDraft(currentDraftIdRef.current);
    onSave(id); doReset();
  }

  function doReset() {
    stopTick(); setSubject(""); setChapter(""); setSource(""); setTotalQInput("");
    setQuestions([]); setTotalLoggedSec(0); setIsPaused(false);
    questionsRef.current = []; totalLoggedRef.current = 0; isPausedRef.current = false;
    currentDraftIdRef.current = null;
    setDrafts(getDrafts().filter((d) => d.questions.length > 0));
    setUndoStack(null); setPhase("type-select");
  }

  function restoreDraft(d: Draft) {
    currentDraftIdRef.current = d.draftId;
    setSessionType(d.sessionType); setSubject(d.subject); setChapter(d.chapter);
    setSource(d.source); setTotalQInput(d.totalQInput);
    questionsRef.current = d.questions; setQuestions(d.questions);
    totalLoggedRef.current = d.totalLoggedSec; setTotalLoggedSec(d.totalLoggedSec);
    startTimestampRef.current = d.startTimestamp || Date.now();
    setIsPaused(false); isPausedRef.current = false;
    const now = Date.now(); sessionOriginRef.current = now; qOriginRef.current = now;
    setPhase("active"); startTick();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phase !== "active") return;
      const tag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const guess = e.shiftKey;
      switch (e.key.toLowerCase()) {
        case "a": case "1": doSelectAnswer("A", guess); break;
        case "b": case "2": doSelectAnswer("B", guess); break;
        case "c": case "3": doSelectAnswer("C", guess); break;
        case "d": case "4": doSelectAnswer("D", guess); break;
        // Shift+1/2/3/4 produce !/@ /#/$ — explicit guess shortcuts
        case "!": doSelectAnswer("A", true); break;
        case "@": doSelectAnswer("B", true); break;
        case "#": doSelectAnswer("C", true); break;
        case "$": doSelectAnswer("D", true); break;
        case " ": e.preventDefault(); doTogglePause(); break;
        case "+": case "=": doIncreaseTotalQ(); break;
        case "-": doDecreaseTotalQ(); break;
        case "z": if (e.ctrlKey || e.metaKey) { e.preventDefault(); doUndo(); } break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, doSelectAnswer, doTogglePause, doIncreaseTotalQ, doDecreaseTotalQ, doUndo]);

  const n = questions.length;
  const fast = questions.filter((q) => q.speed === "fast").length;
  const ok = questions.filter((q) => q.speed === "ok").length;
  const slow = questions.filter((q) => q.speed === "slow").length;

  // ── TYPE SELECT ──────────────────────────────────────────────────────────
  if (phase === "type-select") {
    return (
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh" }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 24, fontWeight: 600, color: C.accent, textAlign: "center", marginBottom: 6, letterSpacing: "-.01em" }}>KCET Tracker</div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textAlign: "center", letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 36 }}>What are you doing today?</div>

          {drafts.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.accent, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 8 }}>⚡ Unsaved Drafts</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {drafts.map((d) => (
                  <div key={d.draftId} style={{ ...card(), padding: "12px 14px", borderColor: C.accent + "55", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {d.subject}{d.chapter ? " — " + d.chapter : ""}
                        {d.sessionType === "mock" && <span style={{ marginLeft: 6, fontSize: 8, color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 2, padding: "1px 5px" }}>MOCK</span>}
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim3, marginTop: 2 }}>
                        {d.questions.length}Q · {fmtDate(d.savedAt)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => restoreDraft(d)} className="btn-primary-h" style={{ ...btnPrimary(), fontSize: 9, padding: "5px 12px" }}>Resume →</button>
                      <button onClick={() => { removeDraft(d.draftId); setDrafts((prev) => prev.filter((x) => x.draftId !== d.draftId)); }} className="btn-outline-h btn-danger-h" style={{ ...btnOutline(), fontSize: 9, padding: "5px 10px" }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 32 }}>
            <div className="type-card-h" onClick={() => { setSessionType("practice"); setPhase("setup"); }} style={{ ...card(), padding: "32px 20px", cursor: "pointer", transition: "all .15s", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 36 }}>📖</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: C.text }}>Practice</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textAlign: "center", lineHeight: 1.8, letterSpacing: ".04em" }}>Chapter-wise drill.<br />Track speed per question.</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, justifyContent: "center" }}>
                {["Physics", "Chem", "Maths", "Bio"].map((s) => (
                  <span key={s} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, padding: "2px 6px", border: `1px solid ${C.border2}`, borderRadius: 2, color: C.dim }}>{s}</span>
                ))}
              </div>
            </div>
            <div className="type-card-h" onClick={() => { setSessionType("mock"); setPhase("setup"); }} style={{ ...card(), padding: "32px 20px", cursor: "pointer", transition: "all .15s", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 36 }}>🎯</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: C.accent }}>Full Mock</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textAlign: "center", lineHeight: 1.8, letterSpacing: ".04em" }}>Full-length exam sim.<br />180Q across all subjects.</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, justifyContent: "center" }}>
                {["PYQ", "Grand Test", "Series"].map((s) => (
                  <span key={s} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, padding: "2px 6px", border: `1px solid ${C.border2}`, borderRadius: 2, color: C.dim }}>{s}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── SETUP ────────────────────────────────────────────────────────────────
  if (phase === "setup") {
    const isMock = sessionType === "mock";
    return (
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "80vh" }}>
        <div style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={() => setPhase("type-select")} style={{ alignSelf: "flex-start", background: "none", border: "none", color: C.dim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, cursor: "pointer", letterSpacing: ".06em", marginBottom: 4, padding: 0 }}>← back</button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 20, fontWeight: 600, color: isMock ? C.accent : C.text }}>{isMock ? "🎯 Full Mock" : "📖 Practice"}</div>
            <Tag color={isMock ? C.accent : C.dim3}>{isMock ? "MOCK" : "PRACTICE"}</Tag>
          </div>

          {isMock ? (
            <>
              <input style={inputSt} type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Mock Name  (e.g. Allen GT-4)" autoComplete="off"
                onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("mock-src")?.focus(); }} />
              <input id="mock-src" style={inputSt} type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source  (e.g. Allen / PYQ 2023)" autoComplete="off"
                onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("mock-totalq")?.focus(); }} />
              <div style={{ display: "flex", gap: 8 }}>
                {[60, 120, 180].map((nv) => (
                  <button key={nv} className="preset-h" onClick={() => setTotalQInput(String(nv))} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "6px 14px", borderRadius: 2, cursor: "pointer", border: `1px solid ${totalQInput === String(nv) ? C.accent : C.border2}`, background: totalQInput === String(nv) ? C.accent : "none", color: totalQInput === String(nv) ? "#000" : C.dim, letterSpacing: ".06em", transition: "all .12s" }}>{nv}Q</button>
                ))}
                <input id="mock-totalq" style={{ ...inputSt, flex: 1, fontSize: 13, padding: "7px 12px" }} type="number" value={totalQInput} onChange={(e) => setTotalQInput(e.target.value)} placeholder="Custom" min="1"
                  onKeyDown={(e) => { if (e.key === "Enter") doStartSession(); }} />
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["Physics", "Chemistry", "Mathematics", "Biology"].map((s) => (
                  <button key={s} className="preset-h" onClick={() => setSubject(s)} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 2, cursor: "pointer", border: `1px solid ${subject === s ? C.accent : C.border2}`, background: subject === s ? C.accent : "none", color: subject === s ? "#000" : C.dim, letterSpacing: ".06em", transition: "all .12s" }}>
                    {s === "Mathematics" ? "Maths" : s}
                  </button>
                ))}
              </div>
              <input style={inputSt} type="text" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("p-chap")?.focus(); }} />
              <input id="p-chap" style={inputSt} type="text" value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="Chapter / Topic" autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("p-src")?.focus(); }} />
              <input id="p-src" style={inputSt} type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source  (e.g. PYQ 2023)" autoComplete="off" onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("p-totalq")?.focus(); }} />
              <input id="p-totalq" style={inputSt} type="number" value={totalQInput} onChange={(e) => setTotalQInput(e.target.value)} placeholder="Total Questions (optional)" min="1" onKeyDown={(e) => { if (e.key === "Enter") doStartSession(); }} />
            </>
          )}

          <button onClick={doStartSession} className="btn-primary-h" style={{ ...btnPrimary(), width: "100%", padding: "13px", fontSize: 11, marginTop: 4 }}>Start Session →</button>
        </div>
      </div>
    );
  }

  // ── ACTIVE ───────────────────────────────────────────────────────────────
  if (phase === "active") {
    const isMock = sessionType === "mock";
    const tq = parseInt(totalQInput) || null;
    const pct = tq ? Math.min(100, (n / tq) * 100) : 0;
    const isLimitReached = tq !== null && n >= tq;

    return (
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              {isMock ? <>{subject || "Full Mock"} <Tag color={C.accent}>MOCK</Tag></> : <>{subject} — {chapter}</>}
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, marginTop: 4 }}>{source || "No source"}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {undoStack && (
              <button onClick={doUndo} className="undo-btn" title="Undo last removal (Ctrl+Z)" style={{ ...btnOutline(), color: C.accent, borderColor: C.accent }}>↩ Undo</button>
            )}
            <button onClick={doTogglePause} className="btn-outline-h" style={btnOutline()}>{isPaused ? "Resume" : "Pause"}</button>
            <button onClick={doStop} className="btn-danger-h" style={btnDanger()}>Stop</button>
          </div>
        </div>

        {/* timer strip */}
        <div style={{ ...card(), padding: "16px 20px", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-end" }}>
          <div>
            <div style={lblSt}>Session</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 34, fontWeight: 600, color: isPaused ? C.dim3 : C.accent, letterSpacing: "-.03em", lineHeight: 1 }}>{sessDisplay}</div>
          </div>
          <div>
            <div style={lblSt}>This Question</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: qIsBreak ? C.accent : C.dim3, lineHeight: 1 }}>{qDisplay}</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ ...lblSt, textAlign: "right" }}>Question</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10 }}>
              {tq !== null && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <button onClick={doIncreaseTotalQ} title="Increase total (+)" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 2, cursor: "pointer", border: `1px solid ${C.accent}`, background: `${C.accent}18`, color: C.accent, transition: "all .12s", lineHeight: 1 }}>+</button>
                  <button onClick={doDecreaseTotalQ} title="Decrease total (-)" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 2, cursor: "pointer", border: `1px solid ${C.accent}`, background: `${C.accent}18`, color: C.accent, transition: "all .12s", lineHeight: 1 }}>−</button>
                </div>
              )}
              <div style={{ textAlign: "right" }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, fontWeight: 600, color: C.text }}>{tq ? Math.min(n + 1, tq) : n + 1}</span>
                {tq && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: C.dim }}>/ {tq}</span>}
                {tq !== null && (
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, marginTop: 2 }}>
                    <Kbd>+</Kbd><Kbd>−</Kbd> adjust
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* progress bar */}
        {tq && (
          <div style={{ height: 3, background: C.border, borderRadius: 2, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: C.accent, borderRadius: 2, transition: "width .3s ease" }} />
          </div>
        )}

        {/* answer panel */}
        <div style={{ ...card(), padding: 20, marginBottom: 12 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 14 }}>
            Select Answer &nbsp;<Kbd>A</Kbd><Kbd>B</Kbd><Kbd>C</Kbd><Kbd>D</Kbd>&nbsp;or&nbsp;<Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd><Kbd>4</Kbd>
            &nbsp;&nbsp;<Kbd>Space</Kbd>&nbsp;pause&nbsp;&nbsp;<span style={{ color: C.neonPurple }}>Shift+key = guess 🤔</span>
          </div>

          {isLimitReached && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, color: C.accent, background: "rgba(232,255,71,.06)", border: `1px solid rgba(232,255,71,.2)`, borderRadius: 3, padding: "10px 14px", marginBottom: 14, textAlign: "center", letterSpacing: ".06em" }}>
              ✓ All {tq} questions answered — stopping…
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
            {(["A", "B", "C", "D"] as const).map((a) => {
              const col = ANS_COLORS[a];
              const isFlash = flashAns === a;
              return (
                <button key={a} onClick={() => doSelectAnswer(a)} disabled={isLimitReached}
                  className={isLimitReached ? undefined : `ans-${a.toLowerCase()}`}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, fontWeight: 600,
                    padding: "20px 8px 16px", borderRadius: 3, cursor: isLimitReached ? "not-allowed" : "pointer",
                    border: `2px solid ${isLimitReached ? C.border : isFlash ? col : C.border2}`,
                    background: isLimitReached ? C.surface : isFlash ? `${col}14` : "transparent",
                    color: isLimitReached ? C.border2 : isFlash ? col : C.dim2,
                    transition: "all .08s", opacity: isLimitReached ? 0.3 : 1,
                  }}
                >{a}</button>
              );
            })}
          </div>

          {/* speed bar */}
          <div style={{ height: 3, borderRadius: 2, background: C.border, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${speedPct}%`, background: speedCol, borderRadius: 2, transition: "width .5s linear, background .5s", boxShadow: `0 0 8px ${speedCol}` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.neonGreen }}>≤30s fast</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.neonOrange }}>30–60s ok</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.neonRed }}>60s+ slow</span>
          </div>
        </div>

        {/* live bar */}
        <LiveBar questions={questions} totalLoggedSec={totalLoggedSec} />

        {/* question log */}
        {questions.length > 0 && <QuestionLog questions={questions} onEdit={editQuestionAnswer} onRemove={removeQuestion} onToggleGuess={toggleQuestionGuess} />}
      </div>
    );
  }

  // ── RESULT ───────────────────────────────────────────────────────────────
  if (phase === "result") {
    const n2 = questions.length;
    const avgSec = n2 ? Math.round(totalLoggedSec / n2) : 0;
    return (
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <SectionLabel>Session Complete</SectionLabel>
          <button onClick={doBackToActive} className="btn-outline-h" style={{ ...btnOutline(), marginBottom: 20 }}>← Back to Session</button>
        </div>
        {/* score hero */}
        {(() => {
          const sc = calcScore(questions); const col = scoreCol(sc); return (
            <div style={{ ...card({ borderColor: col + "55" }), padding: "18px 22px", marginBottom: 12, display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".14em", marginBottom: 4 }}>Session Score</div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 52, fontWeight: 600, color: col, lineHeight: 1, letterSpacing: "-.02em" }}>{sc}</div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, marginTop: 4 }}>60s/Q = KCET baseline (50pts) · 30s = 100pts · add key for accuracy bonus</div>
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em" }}>Score Breakdown</div>
                {(() => {
                  const qs2 = questions.filter(q => q.speed !== "skip" && q.timeSec > 0);
                  const effPct = qs2.length ? Math.round((qs2.reduce((s, q) => s + Math.min(60 / q.timeSec, 2.0), 0) / qs2.length) * 50) : 0;
                  return (
                    <div style={{ width: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim }}>Speed vs KCET pace (60s = 50pts baseline, 30s = 100pts)</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.neonBlue, fontWeight: 600 }}>{effPct}%</span>
                      </div>
                      <div style={{ height: 4, background: C.border2, borderRadius: 2 }}><div style={{ height: "100%", width: `${effPct}%`, background: C.neonBlue, borderRadius: 2, transition: "width .4s" }} /></div>
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })()}
        {(() => {
          const guesses = questions.filter(q => q.isGuess).length; return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 12 }}>
              <KpiCard val={fmtHMS(totalLoggedSec)} lbl="Total Time" />
              <KpiCard val={n2} lbl="Questions" />
              <KpiCard val={n2 ? fmt2(avgSec) : "—"} lbl="Avg / Q" />
              <KpiCard val={guesses || "—"} lbl="Guesses 🤔" col={guesses > 0 ? C.neonPurple : C.dim3} />
            </div>
          );
        })()}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 24 }}>
          <KpiCard val={fast} lbl="Fast ≤30s" col={C.neonGreen} />
          <KpiCard val={ok} lbl="OK 30–60s" col={C.neonOrange} />
          <KpiCard val={slow} lbl="Slow 60s+" col={C.neonRed} />
          <div style={{ ...card(), padding: "14px 12px" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>Answer Dist</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["A", "B", "C", "D"] as const).map((a) => {
                const c = questions.filter((q) => q.answer === a).length;
                return c > 0 ? <span key={a} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 2, border: `1px solid ${ANS_COLORS[a]}`, color: ANS_COLORS[a] }}>{a}:{c}</span> : null;
              })}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={doSave} className="btn-primary-h" style={btnPrimary()}>Save & Check Answers →</button>
          <button onClick={doReset} className="btn-outline-h" style={btnOutline()}>Discard</button>
        </div>
      </div>
    );
  }

  return null;
}

// ── LiveBar ────────────────────────────────────────────────────────────────
function LiveBar({ questions, totalLoggedSec }: { questions: Question[]; totalLoggedSec: number }) {
  const n = questions.length;
  return (
    <div style={{ ...card(), display: "flex", gap: 20, padding: "13px 18px", flexWrap: "wrap", marginBottom: 2 }}>
      <LbItem val={n} lbl="Done" />
      <LbItem val={n ? fmt2(Math.round(totalLoggedSec / n)) : "—"} lbl="Avg/Q" />
      <Div />
      {(["A", "B", "C", "D"] as const).map((a) => <LbItem key={a} val={questions.filter((q) => q.answer === a).length} lbl={a} col={ANS_COLORS[a]} />)}
      <Div />
      <LbItem val={questions.filter((q) => q.speed === "fast").length} lbl="Fast" col={C.neonGreen} />
      <LbItem val={questions.filter((q) => q.speed === "ok").length} lbl="OK" col={C.neonOrange} />
      <LbItem val={questions.filter((q) => q.speed === "slow").length} lbl="Slow" col={C.neonRed} />
    </div>
  );
}
function LbItem({ val, lbl, col }: { val: string | number; lbl: string; col?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, fontWeight: 600, color: col || C.text }}>{val}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: col || C.dim, textTransform: "uppercase", letterSpacing: ".08em", marginTop: 1 }}>{lbl}</div>
    </div>
  );
}
function Div() { return <div style={{ width: 1, background: C.border, margin: "0 2px", alignSelf: "stretch" }} />; }

// ── QuestionLog ────────────────────────────────────────────────────────────
function QuestionLog({ questions, onEdit, onRemove, onToggleGuess }: { questions: Question[]; onEdit: (num: number, ans: Ans) => void; onRemove: (num: number) => void; onToggleGuess?: (num: number) => void }) {
  const [editingNum, setEditingNum] = useState<number | null>(null);
  const reversed = [...questions].reverse();
  return (
    <div style={{ marginTop: 12, ...card(), overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".12em" }}>Question Log — {questions.length} logged</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.border2, letterSpacing: ".06em" }}>tap to edit · ✕ to remove · 🤔 = guess</div>
      </div>
      <div style={{ maxHeight: 220, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {reversed.map((q) => {
              const isEditing = editingNum === q.num;
              const ac = ANS_COLORS[q.answer || ""] || C.dim;
              const sc = SPEED_COLORS[q.speed] || C.dim;
              const spLabel = q.speed === "fast" ? "≤30s" : q.speed === "ok" ? "30–60s" : q.speed === "slow" ? "60s+" : "—";
              return (
                <tr key={q.num} className="q-log-row" onClick={() => setEditingNum(isEditing ? null : q.num)}
                  style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: isEditing ? C.surface2 : q.isGuess ? "rgba(191,95,255,.04)" : "transparent", transition: "background .1s" }}>
                  <td style={{ padding: "7px 14px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim, width: 46 }}>#{q.num}</td>
                  <td style={{ padding: "7px 8px" }}>
                    {isEditing ? (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                        {(["A", "B", "C", "D"] as const).map((a) => (
                          <button key={a} onClick={() => { onEdit(q.num, a); setEditingNum(null); }} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600, padding: "4px 9px", borderRadius: 2, cursor: "pointer", border: `1px solid ${q.answer === a ? ANS_COLORS[a] : C.border2}`, background: q.answer === a ? `${ANS_COLORS[a]}14` : "transparent", color: q.answer === a ? ANS_COLORS[a] : C.dim, transition: "all .1s" }}>{a}</button>
                        ))}
                        {onToggleGuess && (
                          <button onClick={(e) => { e.stopPropagation(); onToggleGuess(q.num); }}
                            title="Mark as guess (won't affect score)"
                            style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "4px 9px", borderRadius: 2, cursor: "pointer", border: `1px solid ${q.isGuess ? C.neonPurple : C.border2}`, background: q.isGuess ? `${C.neonPurple}22` : "transparent", color: q.isGuess ? C.neonPurple : C.dim, transition: "all .12s" }}>
                            🤔 {q.isGuess ? "Guess ✓" : "Guess"}
                          </button>
                        )}
                        <button onClick={(e) => { e.stopPropagation(); setEditingNum(null); }} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "4px 7px", borderRadius: 2, cursor: "pointer", border: `1px solid ${C.border2}`, background: "transparent", color: C.dim }}>✕</button>
                        <button onClick={(e) => { e.stopPropagation(); onRemove(q.num); setEditingNum(null); }} title="Remove this question" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "4px 7px", borderRadius: 2, cursor: "pointer", border: `1px solid ${C.neonRed}`, background: "transparent", color: C.neonRed }}>del</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: ac }}>{q.answer || "—"}</span>
                        {q.isGuess && <span title="Marked as guess" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "1px 5px", borderRadius: 2, border: `1px solid ${C.neonPurple}`, color: C.neonPurple, lineHeight: 1.4 }}>?</span>}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: sc }}>{spLabel}</td>
                  <td style={{ padding: "7px 14px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim2, textAlign: "right" }}>{fmt2(q.timeSec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── small shared components ────────────────────────────────────────────────
function KpiCard({ val, lbl, col }: { val: string | number; lbl: string; col?: string }) {
  return (
    <div style={{ ...card(), padding: "15px 14px" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 20, fontWeight: 600, color: col || C.accent, marginBottom: 4 }}>{val}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em" }}>{lbl}</div>
    </div>
  );
}
function Kbd({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "inline-block", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 2, padding: "1px 5px", fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: C.dim3, verticalAlign: "middle" }}>{children}</span>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: C.dim, marginBottom: 20 }}>{children}</div>;
}
function Tag({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "2px 7px", border: `1px solid ${color}`, borderRadius: 2, color, letterSpacing: ".06em" }}>{children}</span>;
}

// ── style constants ────────────────────────────────────────────────────────
const inputSt: React.CSSProperties = {
  width: "100%", background: C.surface, border: `1px solid ${C.border}`, color: C.text,
  fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15, padding: "13px 16px", borderRadius: 3, outline: "none",
};
const lblSt: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 4 };

// ══════════════════════════════════════════════════════════════════════════
// CHECK PAGE  — with smart search
// ══════════════════════════════════════════════════════════════════════════
function CheckPage({ initSessId, initKey, onSessChange, onKeySaved }: {
  initSessId: number | null;
  initKey: Record<number, string>;
  onSessChange: (id: number | null, key: Record<number, string>) => void;
  onKeySaved: () => void;
}) {
  const [sessId, setSessId] = useState<number | null>(initSessId);
  const [key, setKey] = useState<Record<number, string>>(initKey);
  const [bulkVal, setBulkVal] = useState("");
  const [saveFlash, setSaveFlash] = useState(false);
  const [searchVal, setSearchVal] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const history = getHistory();
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessId(initSessId); setKey(initKey);
    if (initSessId) {
      const s = history.find((h) => h.id === initSessId);
      if (s) { const ak = s.answerKey || {}; setBulkVal(s.questions.map((q) => ak[q.num] || "").join("").trimEnd()); setKey({ ...ak }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSessId]);

  // close suggestions on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowSuggestions(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const session = sessId ? history.find((s) => s.id === sessId) : null;

  // smart search suggestions
  const suggestions = useMemo(() => {
    if (!searchVal.trim()) return history.slice(0, 8);
    const q = searchVal.toLowerCase();
    return history.filter(s =>
      s.subject.toLowerCase().includes(q) ||
      s.chapter.toLowerCase().includes(q) ||
      s.source.toLowerCase().includes(q) ||
      fmtDate(s.date).toLowerCase().includes(q)
    ).slice(0, 10);
  }, [searchVal, history.length]);

  function pickSession(s: Session) {
    setSessId(s.id); setSearchVal(`${s.subject}${s.chapter ? " — " + s.chapter : ""} (${fmtDate(s.date)})`);
    const ak = s.answerKey || {}; const nk = { ...ak }; setKey(nk);
    setBulkVal(s.questions.map((q) => ak[q.num] || "").join("").trimEnd());
    onSessChange(s.id, nk); setShowSuggestions(false);
  }


  function applyBulk(raw: string) {
    if (!session) return;
    const upper = raw.toUpperCase().replace(/\s/g, "");
    const numMap: Record<string, string> = { "1": "A", "2": "B", "3": "C", "4": "D" };
    const nk: Record<number, string> = {}; let qi = 0;
    for (const ch of upper) {
      if (qi >= session.questions.length) break;
      const q = session.questions[qi++];
      if ("ABCD".includes(ch)) nk[q.num] = ch; else if (numMap[ch]) nk[q.num] = numMap[ch];
    }
    setKey(nk);
  }

  function toggleCorrect(qNum: number, ans: string) {
    if (!session) return;
    const nk = { ...key }; nk[qNum] === ans ? delete nk[qNum] : (nk[qNum] = ans); setKey(nk);
    setBulkVal(session.questions.map((q) => nk[q.num] || "").join("").trimEnd());
  }

  function doSaveKey() {
    if (!sessId || !session) return;
    const h = getHistory(); const idx = h.findIndex((s) => s.id === sessId); if (idx === -1) return;
    h[idx].answerKey = { ...key }; saveHistory(h); onKeySaved();
    setSaveFlash(true); setTimeout(() => setSaveFlash(false), 1600);
  }

  let correct = 0, wrong = 0;
  if (session) session.questions.forEach((q) => {
    const ca = key[q.num];
    if (!ca || !q.answer) return;
    q.answer === ca ? correct++ : wrong++;
  });
  const checked = correct + wrong;
  const pct = checked > 0 ? Math.round((correct / checked) * 100) : 0;
  const accCol = pct >= 75 ? C.neonGreen : pct >= 50 ? C.neonOrange : pct > 0 ? C.neonRed : C.dim;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
      <SectionLabel>Check Answers</SectionLabel>

      {/* Smart search box + action buttons */}
      <div ref={searchRef} style={{ position: "relative", marginBottom: 22 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <input
              type="text"
              value={searchVal}
              onChange={(e) => { setSearchVal(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="🔍  Search by subject, chapter, source, or date…"
              style={{ ...inputSt, fontSize: 13, padding: "11px 14px" }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 3, maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,.6)" }}>
                {suggestions.map((s) => {
                  const hasKey = s.answerKey && Object.keys(s.answerKey).length > 0;
                  const isSelected = s.id === sessId;
                  return (
                    <div key={s.id} className="suggestion-item" onClick={() => pickSession(s)}
                      style={{ padding: "10px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, background: isSelected ? "rgba(232,255,71,.06)" : "transparent", transition: "background .1s" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600, color: isSelected ? C.accent : C.text }}>
                          {s.subject}{s.chapter ? " — " + s.chapter : ""}
                        </div>
                        {hasKey && <Tag color={C.neonGreen}>KEY ✓</Tag>}
                        {s.sessionType === "mock" && <Tag color={C.accent}>MOCK</Tag>}
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, marginTop: 3 }}>
                        {fmtDate(s.date)} · {s.source || "no source"} · {s.questions.length}Q
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button onClick={doSaveKey} className="btn-primary-h" style={btnPrimary(saveFlash)}>{saveFlash ? "Saved ✓" : "Save Key"}</button>
          <button onClick={() => { setKey({}); setBulkVal(""); setSearchVal(""); setSessId(null); onSessChange(null, {}); }} className="btn-outline-h" style={btnOutline()}>Clear</button>
        </div>
      </div>

      {!session && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.dim, padding: "40px 0" }}>Search or select a session above to enter the answer key and check your score.</div>}

      {session && (
        <>
          {/* score strip */}
          {(() => {
            const sc = calcScore(session.questions, key); const col = scoreCol(sc); return (
              <div style={{ ...card({ borderColor: col + "44" }), padding: "14px 18px", marginBottom: 14, display: "flex", alignItems: "center", gap: 20 }}>
                <div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 2 }}>Score</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 42, fontWeight: 600, color: col, lineHeight: 1 }}>{sc}</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, marginTop: 3 }}>60s/Q = baseline 50 · speed 40% + accuracy 60%</div>
                </div>
                <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                  <ScCard val={correct} lbl="Correct" col={C.neonGreen} />
                  <ScCard val={wrong} lbl="Wrong" col={C.neonRed} />
                  <ScCard val={checked > 0 ? pct + "%" : "—"} lbl="Accuracy" col={accCol} />
                  <ScCard val={`${correct}/${session.questions.length}`} lbl="KCET Marks" col={C.accent} />
                </div>
              </div>
            );
          })()}

          {/* bulk entry */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 6 }}>Paste / Type Answer Key</div>
            <textarea value={bulkVal} onChange={(e) => { setBulkVal(e.target.value); applyBulk(e.target.value); }} rows={2} placeholder="ABCDABCDABCD…"
              style={{ width: "100%", background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, padding: "10px 12px", borderRadius: 2, outline: "none", letterSpacing: ".12em", resize: "none" }} />
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, marginTop: 5, lineHeight: 1.7 }}>
              Type correct answers in order (ABCDBACDB…). Use <strong>-</strong> or <strong>.</strong> for unknown. Or click buttons below.
            </div>
          </div>

          {/* table */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["#", "Your Ans", "Correct Ans", "Result", "Speed", "Time", "Guess"].map((h, i) => (
                  <th key={h} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", padding: "0 8px 10px", textAlign: i === 5 ? "right" : "left", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {session.questions.map((q) => {
                  const ca = key[q.num];
                  const ma = q.answer;
                  const sc = SPEED_COLORS[q.speed] || C.dim;
                  const mac = ma ? ANS_COLORS[ma] : C.dim;
                  const spLabel = q.speed === "fast" ? "≤30s" : q.speed === "ok" ? "30–60s" : q.speed === "slow" ? "60s+" : "—";
                  const rowBl = ca && ma ? (ma === ca ? C.neonGreen : C.neonRed) : C.border2;
                  const statusEl = !ca ? <span style={{ color: C.dim }}>—</span>
                    : !ma ? <span style={{ color: C.dim, fontStyle: "italic" }}>—</span>
                      : ma === ca ? <span style={{ color: C.neonGreen, fontWeight: 600 }}>✓</span>
                        : <span style={{ color: C.neonRed, fontWeight: 600 }}>✗</span>;
                  return (
                    <tr key={q.num} style={{ borderBottom: `1px solid ${C.border}`, borderLeft: `2px solid ${rowBl}` }}>
                      <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.dim }}>#{q.num}</td>
                      <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: mac }}>{ma || "—"}</td>
                      <td style={{ padding: "7px 8px" }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {(["A", "B", "C", "D"] as const).map((a) => (
                            <button key={a} className="corr-h" onClick={() => toggleCorrect(q.num, a)}
                              style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 2, cursor: "pointer", border: `1px solid ${ca === a ? C.neonGreen : C.border2}`, background: ca === a ? "rgba(57,255,20,.1)" : "none", color: ca === a ? C.neonGreen : C.dim, transition: "all .1s" }}
                            >{a}</button>
                          ))}
                        </div>
                      </td>
                      <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{statusEl}</td>
                      <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: sc }}>{spLabel}</td>
                      <td style={{ padding: "7px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim2, textAlign: "right" }}>{fmt2(q.timeSec)}</td>
                      <td style={{ padding: "7px 8px", textAlign: "center" }}>
                        {q.isGuess && <span title="Marked as guess" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "1px 5px", borderRadius: 2, border: `1px solid ${C.neonPurple}`, color: C.neonPurple }}>?</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ScCard({ val, lbl, col }: { val: string | number; lbl: string; col: string }) {
  return (
    <div style={{ ...card(), padding: "13px 12px" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 20, fontWeight: 600, color: col, marginBottom: 4 }}>{val}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".08em" }}>{lbl}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// HISTORY PAGE  — hierarchical, filters, search
// ══════════════════════════════════════════════════════════════════════════
type HistGroupMode = "flat" | "subject-chapter" | "chapter" | "date";

function HistoryPage({ onGoCheck, onDelete }: { version?: number; onGoCheck: (id: number) => void; onDelete: () => void }) {
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editFields, setEditFields] = useState({ subject: "", chapter: "", source: "" });
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [histVer, setHistVer] = useState(0);
  const [groupMode, setGroupMode] = useState<HistGroupMode>("flat");
  const [search, setSearch] = useState("");
  const [filterSubject, setFilterSubject] = useState("all");
  const [filterChapter, setFilterChapter] = useState("all");
  const [filterSource, setFilterSource] = useState("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function toggle(id: number) { setOpenIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleGroup(k: string) { setOpenGroups((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; }); }

  function doDelete(id: number) {
    if (!confirm("Delete this session permanently?")) return;
    saveHistory(getHistory().filter((s) => s.id !== id)); onDelete(); setHistVer((v) => v + 1);
  }

  function startEdit(s: Session) {
    setEditFields({ subject: s.subject, chapter: s.chapter, source: s.source });
    setEditingId(s.id);
  }

  function saveEdit(id: number) {
    const h = getHistory();
    const idx = h.findIndex((s) => s.id === id); if (idx === -1) return;
    h[idx].subject = editFields.subject.trim() || h[idx].subject;
    h[idx].chapter = editFields.chapter.trim();
    h[idx].source = editFields.source.trim();
    saveHistory(h); setEditingId(null); onDelete(); setHistVer((v) => v + 1);
  }

  function doExport() {
    const h = getHistory(); if (!h.length) { alert("No sessions to export."); return; }
    const blob = new Blob([JSON.stringify(h, null, 2)], { type: "application/json" });
    Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "kcet_sessions.json" }).click();
  }

  function showToast(msg: string, ok: boolean) { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return; e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        const incoming: Session[] = Array.isArray(raw) ? raw : [raw];
        const valid = incoming.filter((s) => s && typeof s.id === "number" && typeof s.date === "string" && Array.isArray(s.questions));
        if (!valid.length) { showToast("No valid sessions found in file.", false); return; }
        const existing = getHistory(); const existingIds = new Set(existing.map((s) => s.id));
        const normalised: Session[] = valid.map((s) => ({
          id: s.id, date: s.date, startTimestamp: s.startTimestamp,
          sessionType: s.sessionType || "practice",
          subject: s.subject || "Unknown", chapter: s.chapter || "", source: s.source || "",
          totalQ: s.totalQ ?? null, totalTimeSec: s.totalTimeSec ?? 0,
          questions: (s.questions || []).map((q: Question & { num?: number }, i: number) => ({ num: q.num ?? i + 1, answer: q.answer ?? null, speed: q.speed ?? "ok", timeSec: q.timeSec ?? 0, isGuess: q.isGuess ?? false })),
          answerKey: s.answerKey || {},
          stats: s.stats,
        }));
        const newS = normalised.filter((s) => !existingIds.has(s.id));
        const dupes = normalised.length - newS.length;
        if (!newS.length) { showToast(`All ${dupes} session${dupes !== 1 ? "s" : ""} already exist — nothing imported.`, false); return; }
        const merged = [...existing, ...newS].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        saveHistory(merged); onDelete(); setHistVer((v) => v + 1);
        showToast(`✓ Imported ${newS.length} session${newS.length !== 1 ? "s" : ""}${dupes > 0 ? `, ${dupes} duplicate${dupes !== 1 ? "s" : ""} skipped` : ""}.`, true);
      } catch { showToast("Failed to parse JSON — make sure it's a valid export file.", false); }
    };
    reader.readAsText(file);
  }

  const allHistory = getHistory();
  const subjects = useMemo(() => ["all", ...new Set(allHistory.map(s => s.subject))].sort(), [allHistory.length]);
  const chapters = useMemo(() => ["all", ...new Set(allHistory.filter(s => filterSubject === "all" || s.subject === filterSubject).map(s => s.chapter).filter(Boolean))].sort(), [allHistory.length, filterSubject]);
  const sources = useMemo(() => ["all", ...new Set(allHistory.map(s => s.source).filter(Boolean))].sort(), [allHistory.length]);

  // apply filters + search
  const displayHistory = useMemo(() => {
    let h = allHistory;
    if (search.trim()) {
      const q = search.toLowerCase();
      h = h.filter(s => s.subject.toLowerCase().includes(q) || s.chapter.toLowerCase().includes(q) || s.source.toLowerCase().includes(q));
    }
    if (filterSubject !== "all") h = h.filter(s => s.subject === filterSubject);
    if (filterChapter !== "all") h = h.filter(s => s.chapter === filterChapter);
    if (filterSource !== "all") h = h.filter(s => s.source === filterSource);
    if (filterDateFrom) h = h.filter(s => s.date >= filterDateFrom);
    if (filterDateTo) h = h.filter(s => s.date <= filterDateTo + "T23:59:59");
    return h;
  }, [allHistory.length, histVer, search, filterSubject, filterChapter, filterSource, filterDateFrom, filterDateTo]);

  // group the displayed sessions
  type Leaf = { key: string; sessions: Session[] };
  type Branch = { key: string; children: Leaf[] };
  const grouped = useMemo(() => {
    if (groupMode === "flat") return { mode: "flat" as const, items: displayHistory };
    if (groupMode === "date") {
      const map = new Map<string, Session[]>();
      displayHistory.forEach(s => {
        const day = fmtDate(s.date);
        if (!map.has(day)) map.set(day, []);
        map.get(day)!.push(s);
      });
      return { mode: "groups" as const, groups: Array.from(map.entries()).map(([k, v]) => ({ key: k, sessions: v })) };
    }
    if (groupMode === "chapter") {
      const map = new Map<string, Session[]>();
      displayHistory.forEach(s => {
        const k = s.chapter || "No Chapter";
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(s);
      });
      return { mode: "groups" as const, groups: Array.from(map.entries()).map(([k, v]) => ({ key: k, sessions: v })).sort((a, b) => a.key.localeCompare(b.key)) };
    }
    // subject-chapter: two-level
    const subMap = new Map<string, Map<string, Session[]>>();
    displayHistory.forEach(s => {
      const subj = s.subject || "Unknown";
      const chap = s.chapter || "No Chapter";
      if (!subMap.has(subj)) subMap.set(subj, new Map());
      const chapMap = subMap.get(subj)!;
      if (!chapMap.has(chap)) chapMap.set(chap, []);
      chapMap.get(chap)!.push(s);
    });
    const branches: Branch[] = Array.from(subMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([subj, chapMap]) => ({
      key: subj,
      children: Array.from(chapMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([chap, sessions]) => ({ key: chap, sessions })),
    }));
    return { mode: "tree" as const, branches };
  }, [displayHistory, groupMode]);

  const monoSm: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 2, cursor: "pointer", letterSpacing: ".06em", transition: "all .12s" };
  const selBtn = (active: boolean): React.CSSProperties => ({ ...monoSm, border: `1px solid ${active ? C.accent : C.border2}`, background: active ? C.accent : "none", color: active ? "#000" : C.dim });

  function renderSession(s: Session) {
    const qs = s.questions || [];
    const n = qs.length;
    const fast = qs.filter((q) => q.speed === "fast").length;
    const slow = qs.filter((q) => q.speed === "slow").length;
    const ak = s.answerKey || {};
    const hasKey = Object.keys(ak).length > 0;
    let cor = 0, tot = 0;
    if (hasKey) qs.forEach((q) => { if (ak[q.num]) { tot++; if (q.answer === ak[q.num]) cor++; } });
    const pct = tot ? Math.round((cor / tot) * 100) : 0;
    const accCol = pct >= 75 ? C.neonGreen : pct >= 50 ? C.neonOrange : C.neonRed;
    const isOpen = openIds.has(s.id);
    const isMock = s.sessionType === "mock";
    const isEditing = editingId === s.id;

    return (
      <div key={s.id} style={{ ...card(), marginBottom: 8, overflow: "hidden" }}>
        {/* header row */}
        <div className="hist-row" onClick={() => { if (!isEditing) toggle(s.id); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, padding: "14px 16px", cursor: isEditing ? "default" : "pointer", borderBottom: isOpen ? `1px solid ${C.border}` : "1px solid transparent", transition: "background .1s" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isEditing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                <input className="edit-field" value={editFields.subject} onChange={(e) => setEditFields((p) => ({ ...p, subject: e.target.value }))}
                  style={{ background: C.surface2, border: `1px solid ${C.border2}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "5px 8px", borderRadius: 2, outline: "none", width: "100%" }} placeholder="Subject" />
                <input className="edit-field" value={editFields.chapter} onChange={(e) => setEditFields((p) => ({ ...p, chapter: e.target.value }))}
                  style={{ background: C.surface2, border: `1px solid ${C.border2}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "5px 8px", borderRadius: 2, outline: "none", width: "100%" }} placeholder="Chapter / Topic" />
                <input className="edit-field" value={editFields.source} onChange={(e) => setEditFields((p) => ({ ...p, source: e.target.value }))}
                  style={{ background: C.surface2, border: `1px solid ${C.border2}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "5px 8px", borderRadius: 2, outline: "none", width: "100%" }} placeholder="Source" />
                <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                  <button onClick={() => saveEdit(s.id)} className="btn-primary-h" style={{ ...btnPrimary(), fontSize: 9, padding: "5px 10px" }}>Save</button>
                  <button onClick={() => setEditingId(null)} className="btn-outline-h" style={{ ...btnOutline(), fontSize: 9, padding: "5px 10px" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {isMock && <span>🎯</span>}
                  {s.subject}{s.chapter ? " — " + s.chapter : ""}
                  {hasKey && <Tag color={C.neonGreen}>KEY SET</Tag>}
                  {isMock && <Tag color={C.accent}>MOCK</Tag>}
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim, marginTop: 3 }}>{fmtDate(s.date)} · {s.source || "No source"} · {fmtHMS(s.totalTimeSec)}</div>
              </>
            )}
          </div>
          {!isEditing && (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
              {(() => {
                const sc = calcScore(qs, ak); const col = scoreCol(sc); return (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", borderRight: `1px solid ${C.border2}`, paddingRight: 18 }}>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600, color: col, lineHeight: 1 }}>{sc}</div>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", marginTop: 2 }}>Score</div>
                  </div>
                );
              })()}
              <HsStat val={n} lbl="Q" />
              <HsStat val={fast} lbl="Fast" col={C.neonGreen} />
              <HsStat val={slow} lbl="Slow" col={C.neonRed} />
              {qs.filter(q => q.isGuess).length > 0 && <HsStat val={qs.filter(q => q.isGuess).length} lbl="Guess 🤔" col={C.neonPurple} />}
              {hasKey && <>
                <HsStat val={`${cor}/${tot}`} lbl="Correct" col={accCol} />
                <HsStat val={`${pct}%`} lbl="Accuracy" col={accCol} />
              </>}
            </div>
          )}
        </div>

        {/* expanded body */}
        {isOpen && !isEditing && (
          <div style={{ padding: "14px 16px" }}>
            {/* stats row */}
            {s.stats && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, padding: "10px 14px", background: C.surface2, borderRadius: 3, border: `1px solid ${C.border}` }}>
                <StatItem lbl="Mean" val={fmt2(s.stats.mean)} />
                <StatItem lbl="Median" val={fmt2(s.stats.median)} />
                <StatItem lbl="Std Dev" val={`${s.stats.stdDev}s`} />
                <StatItem lbl="Variance" val={`${s.stats.variance}`} />
              </div>
            )}
            {/* dist pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {(["A", "B", "C", "D"] as const).map((a) => {
                const c = qs.filter((q) => q.answer === a).length;
                return c > 0 ? <span key={a} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 2, border: `1px solid ${ANS_COLORS[a]}`, color: ANS_COLORS[a] }}>{a}: {c}</span> : null;
              })}
            </div>

            {/* Q table */}
            <div style={{ maxHeight: 260, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 2 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>{["#", "Ans", "Result", "Speed", "Time", "Guess"].map((h, i) => (
                    <th key={h} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", padding: "6px 8px", textAlign: i === 4 ? "right" : "left", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {[...qs].reverse().slice(0, 60).map((q) => {
                    const ac = ANS_COLORS[q.answer || ""] || C.dim;
                    const sc = SPEED_COLORS[q.speed] || C.dim;
                    const spLabel = q.speed === "fast" ? "≤30s" : q.speed === "ok" ? "30–60s" : q.speed === "slow" ? "60s+" : "—";
                    const ca = ak[q.num];
                    return (
                      <tr key={q.num} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.dim, padding: "6px 8px" }}>#{q.num}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: ac, padding: "6px 8px" }}>{q.answer || "—"}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "6px 8px" }}>
                          {ca && q.answer ? (q.answer === ca ? <span style={{ color: C.neonGreen }}>✓</span> : <span style={{ color: C.neonRed }}>✗ {ca}</span>) : null}
                        </td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: sc, padding: "6px 8px" }}>{spLabel}</td>
                        <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim2, textAlign: "right", padding: "6px 8px" }}>{fmt2(q.timeSec)}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center" }}>
                          {q.isGuess && <span title="Marked as guess" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, padding: "1px 5px", borderRadius: 2, border: `1px solid ${C.neonPurple}`, color: C.neonPurple }}>?</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={() => onGoCheck(s.id)} className="btn-outline-h" style={btnOutline()}>Check Answers →</button>
              <button onClick={(e) => { e.stopPropagation(); startEdit(s); toggle(s.id); }} className="btn-outline-h" style={btnOutline()}>Edit Details</button>
              <button onClick={() => doDelete(s.id)} className="btn-danger-h" style={btnDanger()}>Delete</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderGroup(key: string, sessions: Session[]) {
    const isOpen = openGroups.has(key);
    const totalQ = sessions.reduce((a, s) => a + s.questions.length, 0);
    const fast = sessions.reduce((a, s) => a + s.questions.filter(q => q.speed === "fast").length, 0);
    const slow = sessions.reduce((a, s) => a + s.questions.filter(q => q.speed === "slow").length, 0);
    let cor = 0, tot = 0;
    sessions.forEach(s => { const ak = s.answerKey || {}; s.questions.forEach(q => { if (ak[q.num]) { tot++; if (q.answer === ak[q.num]) cor++; } }); });
    const pct = tot ? Math.round(cor / tot * 100) : null;
    const col = pct === null ? C.dim : pct >= 75 ? C.neonGreen : pct >= 50 ? C.neonOrange : C.neonRed;
    const avgSc = sessions.length ? Math.round(sessions.reduce((a, s) => a + calcScore(s.questions, s.answerKey || {}), 0) / sessions.length) : 0;
    return (
      <div key={key} style={{ marginBottom: 10 }}>
        <div className="hist-group-hd" onClick={() => toggleGroup(key)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 3, cursor: "pointer", transition: "background .1s", marginBottom: isOpen ? 6 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim }}>{isOpen ? "▼" : "▶"}</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600, color: C.accent }}>{key}</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim }}>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", borderRight: `1px solid ${C.border2}`, paddingRight: 14 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 15, fontWeight: 600, color: scoreCol(avgSc), lineHeight: 1 }}>{avgSc}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 8, color: C.dim, textTransform: "uppercase", marginTop: 1 }}>Avg Score</div>
            </div>
            <HsStat val={totalQ} lbl="Q" />
            <HsStat val={fast} lbl="Fast" col={C.neonGreen} />
            <HsStat val={slow} lbl="Slow" col={C.neonRed} />
            {pct !== null && <>
              <HsStat val={`${cor}/${tot}`} lbl="Correct" col={col} />
              <HsStat val={`${pct}%`} lbl="Accuracy" col={col} />
            </>}
          </div>
        </div>
        {isOpen && <div style={{ paddingLeft: 14 }}>{sessions.map(s => renderSession(s))}</div>}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
      <SectionLabel>History</SectionLabel>

      {toast && (
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, padding: "10px 14px", borderRadius: 3, marginBottom: 16, background: toast.ok ? "rgba(57,255,20,.08)" : "rgba(255,45,85,.08)", border: `1px solid ${toast.ok ? C.neonGreen : C.neonRed}`, color: toast.ok ? C.neonGreen : C.neonRed }}>
          {toast.msg}
        </div>
      )}

      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={onFileChange} />

      {/* toolbar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <button onClick={doExport} className="btn-outline-h" style={btnOutline()}>Export JSON</button>
        <button onClick={() => fileRef.current?.click()} className="btn-outline-h" style={btnOutline()}>Import JSON</button>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim }}>{displayHistory.length}/{allHistory.length} sessions</span>
      </div>

      {/* search */}
      <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍  Search subject, chapter, source…"
        style={{ ...inputSt, fontSize: 13, padding: "10px 14px", marginBottom: 12 }} />

      {/* filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
        <FilterSelect label="Subject" value={filterSubject} options={subjects} onChange={v => { setFilterSubject(v); setFilterChapter("all"); }} />
        <FilterSelect label="Chapter" value={filterChapter} options={chapters} onChange={setFilterChapter} />
        <FilterSelect label="Source" value={filterSource} options={sources} onChange={setFilterSource} />
        <div>
          <div style={lblSt}>From</div>
          <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, padding: "7px 10px", borderRadius: 2, outline: "none" }} />
        </div>
        <div>
          <div style={lblSt}>To</div>
          <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, padding: "7px 10px", borderRadius: 2, outline: "none" }} />
        </div>
        {(filterSubject !== "all" || filterChapter !== "all" || filterSource !== "all" || filterDateFrom || filterDateTo || search) && (
          <button onClick={() => { setFilterSubject("all"); setFilterChapter("all"); setFilterSource("all"); setFilterDateFrom(""); setFilterDateTo(""); setSearch(""); }} className="btn-outline-h" style={{ ...btnOutline(), alignSelf: "flex-end" }}>Clear Filters</button>
        )}
      </div>

      {/* group-by bar */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20, alignItems: "center" }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginRight: 4 }}>View:</span>
        {([["flat", "All Sessions"], ["subject-chapter", "Subject → Chapter"], ["chapter", "By Chapter"], ["date", "By Date"]] as [HistGroupMode, string][]).map(([g, label]) => (
          <button key={g} className="grp-btn" onClick={() => setGroupMode(g)}
            style={selBtn(groupMode === g)}>
            {label}
          </button>
        ))}
      </div>

      {!displayHistory.length && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.dim, padding: "40px 0" }}>{allHistory.length ? "No sessions match current filters." : "No sessions saved yet."}</div>}

      {/* render grouped */}
      {grouped.mode === "flat" && grouped.items.map(s => renderSession(s))}

      {grouped.mode === "groups" && grouped.groups.map(grp => renderGroup(grp.key, grp.sessions))}

      {grouped.mode === "tree" && grouped.branches.map(branch => {
        const isOpen = openGroups.has(branch.key);
        const totalQ = branch.children.reduce((a, c) => a + c.sessions.reduce((b, s) => b + s.questions.length, 0), 0);
        return (
          <div key={branch.key} style={{ marginBottom: 12 }}>
            <div className="hist-group-hd" onClick={() => toggleGroup(branch.key)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 3, cursor: "pointer", transition: "background .1s", marginBottom: isOpen ? 8 : 0 }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim }}>{isOpen ? "▼" : "▶"}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: C.accent }}>{branch.key}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.dim }}>{branch.children.length} topic{branch.children.length !== 1 ? "s" : ""} · {totalQ}Q</span>
            </div>
            {isOpen && (
              <div style={{ paddingLeft: 18 }}>
                {branch.children.map(child => renderGroup(`${branch.key}::${child.key}`, child.sessions))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={lblSt}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, padding: "7px 10px", borderRadius: 2, outline: "none", cursor: "pointer" }}>
        {options.map(o => <option key={o} value={o} style={{ background: C.surface2 }}>{o === "all" ? `All ${label}s` : o}</option>)}
      </select>
    </div>
  );
}

function StatItem({ lbl, val }: { lbl: string; val: string }) {
  return (
    <div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".08em" }}>{lbl}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: C.neonBlue }}>{val}</div>
    </div>
  );
}

function HsStat({ val, lbl, col }: { val: string | number; lbl: string; col?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: col || C.accent }}>{val}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase" }}>{lbl}</div>
    </div>
  );
}

function AdvSummaryItem({ label, val, col }: { label: string; val: string; col: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, fontWeight: 600, color: col, lineHeight: 1 }}>{val}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".08em", marginTop: 3 }}>{label}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// GRAPHS PAGE
// ══════════════════════════════════════════════════════════════════════════
declare global { interface Window { Chart: any; } }



function GraphsPage({ version }: { version: number }) {
  const [subjFilter, setSubjFilter] = useState<string>("all");

  // ── Advanced Analytics filter state ────────────────────────────────────
  const [aSubject, setASubject] = useState("all");
  const [aChapter, setAChapter] = useState("all");
  const [aSource, setASource] = useState("all");
  const [aDatePreset, setADatePreset] = useState<"all" | "7d" | "30d" | "90d" | "custom">("all");
  const [aDateFrom, setADateFrom] = useState("");
  const [aDateTo, setADateTo] = useState("");

  // Custom builder state
  const [cbDateFrom, setCbDateFrom] = useState("");
  const [cbDateTo, setCbDateTo] = useState("");
  const [cbSubject, setCbSubject] = useState("all");
  const [cbChapter, setCbChapter] = useState("all");
  const [cbSource, setCbSource] = useState("all");
  const [cbMetric, setCbMetric] = useState<"accuracy" | "avgTime" | "questions" | "variance" | "struggleRate">("accuracy");
  const [cbChartType, setCbChartType] = useState<"line" | "bar" | "stackedBar">("line");

  const chartsRef = useRef<Record<string, any>>({});
  const overviewChartsRef = useRef<Record<string, any>>({});
  const advChartsRef = useRef<Record<string, any>>({});
  const builderCanvasRef = useRef<HTMLCanvasElement>(null);

  const history = getHistory();
  const subjects = [...new Set(history.map((s) => s.subject))].sort();
  const allChapters = [...new Set(history.map(s => s.chapter).filter(Boolean))].sort();
  const allSources = [...new Set(history.map(s => s.source).filter(Boolean))].sort();

  const baseFiltered = subjFilter === "all" ? history : history.filter((s) => s.subject === subjFilter);
  const sorted = [...baseFiltered].sort((a, b) => a.date.localeCompare(b.date));

  // ── Advanced Analytics computed dataset ──────────────────────────────────
  const advSorted = useMemo(() => {
    let h = [...history];
    if (aSubject !== "all") h = h.filter(s => s.subject === aSubject);
    if (aChapter !== "all") h = h.filter(s => s.chapter === aChapter);
    if (aSource !== "all") h = h.filter(s => s.source === aSource);
    const now = Date.now();
    if (aDatePreset === "7d") h = h.filter(s => new Date(s.date).getTime() >= now - 7 * 86400000);
    if (aDatePreset === "30d") h = h.filter(s => new Date(s.date).getTime() >= now - 30 * 86400000);
    if (aDatePreset === "90d") h = h.filter(s => new Date(s.date).getTime() >= now - 90 * 86400000);
    if (aDatePreset === "custom") {
      if (aDateFrom) h = h.filter(s => s.date >= aDateFrom);
      if (aDateTo) h = h.filter(s => s.date <= aDateTo + "T23:59:59");
    }
    return h.sort((a, b) => a.date.localeCompare(b.date));
  }, [history.length, version, aSubject, aChapter, aSource, aDatePreset, aDateFrom, aDateTo]);

  // Advanced filter chapter options (depend on aSubject selection)
  const advSubjects = useMemo(() => [...new Set(history.map(s => s.subject))].sort(), [history.length]);
  const advChapters = useMemo(() => {
    const base = aSubject === "all" ? history : history.filter(s => s.subject === aSubject);
    return [...new Set(base.map(s => s.chapter).filter(Boolean))].sort();
  }, [history.length, aSubject]);
  const advSources = useMemo(() => [...new Set(history.map(s => s.source).filter(Boolean))].sort(), [history.length]);

  // Summary stats for the advanced filter dataset
  const advStats = useMemo(() => {
    const totalQ = advSorted.reduce((a, s) => a + s.questions.length, 0);
    const totalSec = advSorted.reduce((a, s) => a + s.totalTimeSec, 0);
    const avgSec = totalQ > 0 ? Math.round(totalSec / totalQ) : 0;
    let cor = 0, chk = 0;
    advSorted.forEach(s => { const ak = s.answerKey || {}; s.questions.forEach(q => { if (ak[q.num]) { chk++; if (q.answer === ak[q.num]) cor++; } }); });
    const accuracy = chk > 0 ? Math.round(cor / chk * 100) : null;
    return { sessions: advSorted.length, totalQ, avgSec, accuracy };
  }, [advSorted]);

  const totalQ = sorted.reduce((a, s) => a + s.questions.length, 0);
  const totalTime = sorted.reduce((a, s) => a + s.totalTimeSec, 0);
  let totCor = 0, totChk = 0;
  sorted.forEach((s) => { const ak = s.answerKey || {}; s.questions.forEach((q) => { if (ak[q.num]) { totChk++; if (q.answer === ak[q.num]) totCor++; } }); });
  const acc = totChk > 0 ? Math.round((totCor / totChk) * 100) : null;
  const accCol = acc === null ? C.dim : acc >= 75 ? C.neonGreen : acc >= 50 ? C.neonOrange : C.neonRed;

  // improvement rate: compare first 30% vs last 30% accuracy
  const improvementRate = useMemo(() => {
    const withKey = sorted.filter(s => Object.keys(s.answerKey || {}).length > 0);
    if (withKey.length < 4) return null;
    const seg = Math.max(1, Math.floor(withKey.length * 0.3));
    const calc = (arr: Session[]) => {
      let c = 0, t = 0;
      arr.forEach(s => { const ak = s.answerKey; s.questions.forEach(q => { if (!ak[q.num]) return; t++; if (q.answer === ak[q.num]) c++; }); });
      return t ? c / t : 0;
    };
    const early = calc(withKey.slice(0, seg));
    const late = calc(withKey.slice(-seg));
    if (!early) return null;
    return Math.round(((late - early) / early) * 100);
  }, [sorted.length, subjFilter]);

  // ── Performance Insights ──────────────────────────────────────────────────
  const insights = useMemo(() => {
    const list: string[] = [];
    if (!sorted.length) return list;

    // Struggle rate by chapter
    const chapData: Record<string, { slow: number; total: number }> = {};
    sorted.forEach(s => {
      if (!s.chapter) return;
      if (!chapData[s.chapter]) chapData[s.chapter] = { slow: 0, total: 0 };
      s.questions.forEach(q => { chapData[s.chapter].total++; if (q.speed === "slow") chapData[s.chapter].slow++; });
    });
    const globalSlowRate = sorted.reduce((a, s) => a + s.questions.filter(q => q.speed === "slow").length, 0) / Math.max(1, totalQ);
    Object.entries(chapData).filter(([, v]) => v.total >= 5).forEach(([ch, v]) => {
      const r = v.slow / v.total;
      if (r > globalSlowRate * 1.4) list.push(`⚠ Struggle rate in "${ch}" (${Math.round(r * 100)}%) is above average (${Math.round(globalSlowRate * 100)}%).`);
    });

    // Speed improvement over last 10 sessions vs previous 10
    if (sorted.length >= 12) {
      const last10 = sorted.slice(-10); const prev10 = sorted.slice(-20, -10);
      const avgLast = last10.reduce((a, s) => a + (s.totalTimeSec / Math.max(1, s.questions.length)), 0) / 10;
      const avgPrev = prev10.reduce((a, s) => a + (s.totalTimeSec / Math.max(1, s.questions.length)), 0) / 10;
      if (avgPrev > 0) {
        const delta = Math.round(((avgPrev - avgLast) / avgPrev) * 100);
        if (delta > 5) list.push(`✓ Average solving speed improved by ${delta}% in the last 10 sessions.`);
        else if (delta < -5) list.push(`↓ Average solving speed slowed by ${Math.abs(delta)}% in the last 10 sessions.`);
      }
    }

    // Hard questions note
    const slowSessions = sorted.filter(s => s.questions.filter(q => q.speed === "slow").length / Math.max(1, s.questions.length) > 0.4);
    if (slowSessions.length >= 3) list.push(`📌 You consistently spend more time (60s+) on a high proportion of questions — consider working on exam pacing.`);

    // Accuracy trend
    if (improvementRate !== null) {
      if (improvementRate > 10) list.push(`📈 Your accuracy improved by ~${improvementRate}% comparing early vs recent sessions.`);
      else if (improvementRate < -5) list.push(`📉 Your accuracy has dipped by ~${Math.abs(improvementRate)}% recently. Review recent errors.`);
    }

    return list.slice(0, 5);
  }, [sorted.length, totalQ, improvementRate, subjFilter]);

  // ── chart helpers ─────────────────────────────────────────────────────────
  const chartDefaults = useCallback(() => {
    const gridCol = "#1c1c1c", tickColor = "#3a3a3a";
    const axis = { grid: { color: gridCol, drawBorder: false }, ticks: { color: tickColor, font: { family: "IBM Plex Mono", size: 9 } } };
    const tooltip = { backgroundColor: "#1a1a1a", titleColor: "#888", bodyColor: "#e8e8e8", borderColor: "#2e2e2e", borderWidth: 1 };
    return { axis, tooltip };
  }, []);

  // ── OVERVIEW CHARTS ───────────────────────────────────────────────────
  useEffect(() => {
    if (!history.length || !window.Chart) return;
    const C2 = window.Chart;
    const { axis, tooltip } = chartDefaults();
    const baseOpts = { responsive: true, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false }, tooltip }, scales: { x: axis, y: axis } };

    function mk(id: string, cfg: any) {
      const el = document.getElementById(id) as HTMLCanvasElement | null; if (!el) return;
      if (overviewChartsRef.current[id]) overviewChartsRef.current[id].destroy();
      overviewChartsRef.current[id] = new C2(el.getContext("2d"), cfg);
    }

    const daily: Record<string, { q: number; time: number; cor: number; chk: number; fast: number; ok: number; slow: number }> = {};
    sorted.forEach((s) => {
      const day = s.date.slice(0, 10);
      if (!daily[day]) daily[day] = { q: 0, time: 0, cor: 0, chk: 0, fast: 0, ok: 0, slow: 0 };
      daily[day].q += s.questions.length; daily[day].time += s.totalTimeSec;
      const ak = s.answerKey || {};
      s.questions.forEach((q) => {
        if (q.speed === "fast") daily[day].fast++; else if (q.speed === "ok") daily[day].ok++; else daily[day].slow++;
        if (!ak[q.num]) return; daily[day].chk++; if (q.answer === ak[q.num]) daily[day].cor++;
      });
    });
    const days = Object.keys(daily).sort();
    const dayLabels = days.map((d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }));
    const dailyQ = days.map((d) => daily[d].q);
    const dailyAcc = days.map((d) => daily[d].chk > 0 ? Math.round((daily[d].cor / daily[d].chk) * 100) : null);
    const dailyTime = days.map((d) => daily[d].q > 0 ? Math.round(daily[d].time / daily[d].q) : 0);
    let run = 0; const cumQ = dailyQ.map((q) => (run += q));

    const sc = { fast: 0, ok: 0, slow: 0 };
    sorted.forEach((s) => s.questions.forEach((q) => { if (q.speed === "fast") sc.fast++; else if (q.speed === "ok") sc.ok++; else if (q.speed === "slow") sc.slow++; }));

    const sa: Record<string, { cor: number; tot: number }> = {};
    sorted.forEach((s) => {
      if (!sa[s.subject]) sa[s.subject] = { cor: 0, tot: 0 };
      const ak = s.answerKey || {};
      s.questions.forEach((q) => { if (!ak[q.num]) return; sa[s.subject].tot++; if (q.answer === ak[q.num]) sa[s.subject].cor++; });
    });

    function line(id: string, labels: any[], data: any[], color: string, yMax?: number) {
      const opts = JSON.parse(JSON.stringify(baseOpts)); if (yMax) opts.scales.y.max = yMax;
      mk(id, { type: "line", data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + "14", pointRadius: 3, pointBackgroundColor: color, tension: 0.35, fill: true, spanGaps: true, borderWidth: 2 }] }, options: opts });
    }
    function bar(id: string, labels: any[], data: any[], color: string) {
      mk(id, { type: "bar", data: { labels, datasets: [{ data, backgroundColor: color + "99", borderColor: color, borderWidth: 1, borderRadius: 2 }] }, options: JSON.parse(JSON.stringify(baseOpts)) });
    }

    line("ov-acc", dayLabels, dailyAcc, CHART_COLORS.acc, 100);
    bar("ov-daily", dayLabels, dailyQ, CHART_COLORS.daily);
    line("ov-time", dayLabels, dailyTime, CHART_COLORS.time);
    mk("ov-speed", {
      type: "bar",
      data: { labels: ["Fast ≤30s", "OK 30–60s", "Slow 60s+"], datasets: [{ data: [sc.fast, sc.ok, sc.slow], backgroundColor: [CHART_COLORS.fast + "99", CHART_COLORS.ok + "99", CHART_COLORS.slow + "99"], borderColor: [CHART_COLORS.fast, CHART_COLORS.ok, CHART_COLORS.slow], borderWidth: 1, borderRadius: 2 }] },
      options: { ...JSON.parse(JSON.stringify(baseOpts)), plugins: { legend: { display: false }, tooltip } },
    });
    const subjKeys = Object.keys(sa);
    bar("ov-subj", subjKeys, subjKeys.map((k) => sa[k].tot ? Math.round((sa[k].cor / sa[k].tot) * 100) : null), CHART_COLORS.subj);
    line("ov-cum", dayLabels, cumQ, CHART_COLORS.cum);

    return () => { Object.values(overviewChartsRef.current).forEach((c: any) => c?.destroy()); overviewChartsRef.current = {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjFilter, history.length, version]);

  // ── ADVANCED ANALYTICS CHARTS ─────────────────────────────────────────
  useEffect(() => {
    if (!window.Chart) return;
    const C2 = window.Chart;
    const { axis, tooltip } = chartDefaults();
    const baseOpts = { responsive: true, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false }, tooltip }, scales: { x: axis, y: axis } };

    function mk(id: string, cfg: any) {
      const el = document.getElementById(id) as HTMLCanvasElement | null; if (!el) return;
      if (advChartsRef.current[id]) advChartsRef.current[id].destroy();
      advChartsRef.current[id] = new C2(el.getContext("2d"), cfg);
    }
    function line(id: string, labels: any[], datasets: any[], yMax?: number) {
      const opts = JSON.parse(JSON.stringify(baseOpts)); if (yMax) opts.scales.y.max = yMax;
      mk(id, { type: "line", data: { labels, datasets }, options: opts });
    }
    function bar(id: string, labels: any[], datasets: any[]) {
      mk(id, { type: "bar", data: { labels, datasets }, options: JSON.parse(JSON.stringify(baseOpts)) });
    }

    // use advSorted (advanced-filter-aware dataset)

    const sessLabels = advSorted.map((_s, i) => `S${i + 1}`);

    // 1. Improvement over time (accuracy per session with 7-session MA)
    const sessAcc = advSorted.map(s => {
      const ak = s.answerKey || {}; let c = 0, t = 0;
      s.questions.forEach(q => { if (!ak[q.num]) return; t++; if (q.answer === ak[q.num]) c++; });
      return t ? Math.round(c / t * 100) : null;
    });
    const ma7 = sessAcc.map((_, i, arr) => {
      const win = arr.slice(Math.max(0, i - 6), i + 1).filter(v => v !== null) as number[];
      return win.length ? Math.round(win.reduce((a, b) => a + b, 0) / win.length) : null;
    });
    line("adv-improve", sessLabels, [
      { data: sessAcc, borderColor: C.neonBlue + "88", backgroundColor: "transparent", pointRadius: 2, tension: 0.3, spanGaps: true, borderWidth: 1, label: "Accuracy" },
      { data: ma7, borderColor: C.accent, backgroundColor: C.accent + "18", pointRadius: 0, tension: 0.5, spanGaps: true, borderWidth: 2.5, fill: true, label: "7-Session MA" },
    ], 100);

    // 2. Time efficiency trend
    const timePerQ = advSorted.map(s => s.questions.length ? Math.round(s.totalTimeSec / s.questions.length) : null);
    line("adv-time-eff", sessLabels, [
      { data: timePerQ, borderColor: C.neonOrange, backgroundColor: C.neonOrange + "14", pointRadius: 3, tension: 0.35, fill: true, spanGaps: true, borderWidth: 2, label: "Avg sec/Q" }
    ]);

    // 3. Struggle rate trend (slow%)
    const struggleRate = advSorted.map(s => {
      const n = s.questions.length; if (!n) return null;
      return Math.round(s.questions.filter(q => q.speed === "slow").length / n * 100);
    });
    line("adv-struggle", sessLabels, [
      { data: struggleRate, borderColor: C.neonRed, backgroundColor: C.neonRed + "14", pointRadius: 3, tension: 0.35, fill: true, spanGaps: true, borderWidth: 2, label: "Slow %" }
    ], 100);

    // 4. Variance analysis
    const variances = advSorted.map(s => {
      const times = s.questions.map(q => q.timeSec);
      if (!times.length) return null;
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      return Math.round(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length);
    });
    bar("adv-variance", sessLabels, [
      { data: variances, backgroundColor: C.neonPurple + "99", borderColor: C.neonPurple, borderWidth: 1, borderRadius: 2, label: "Variance" }
    ]);

    // 5. Chapter difficulty heatmap (render as horizontal bar)
    const chapSlowMap: Record<string, { slow: number; ok: number; fast: number; total: number }> = {};
    advSorted.forEach(s => {
      if (!s.chapter) return;
      if (!chapSlowMap[s.chapter]) chapSlowMap[s.chapter] = { slow: 0, ok: 0, fast: 0, total: 0 };
      s.questions.forEach(q => {
        chapSlowMap[s.chapter].total++;
        if (q.speed === "slow") chapSlowMap[s.chapter].slow++;
        else if (q.speed === "ok") chapSlowMap[s.chapter].ok++;
        else chapSlowMap[s.chapter].fast++;
      });
    });
    const chapKeys = Object.keys(chapSlowMap).sort((a, b) => (chapSlowMap[b].slow / chapSlowMap[b].total) - (chapSlowMap[a].slow / chapSlowMap[a].total)).slice(0, 10);
    const hmOpts = JSON.parse(JSON.stringify(baseOpts));
    hmOpts.indexAxis = "y"; hmOpts.plugins.legend = { display: true, labels: { color: "#888", font: { family: "IBM Plex Mono", size: 9 }, boxWidth: 10 } };
    mk("adv-heatmap", {
      type: "bar",
      data: {
        labels: chapKeys,
        datasets: [
          { label: "Fast", data: chapKeys.map(k => Math.round(chapSlowMap[k].fast / chapSlowMap[k].total * 100)), backgroundColor: C.neonGreen + "99", borderColor: C.neonGreen, borderWidth: 1, stack: "s" },
          { label: "OK", data: chapKeys.map(k => Math.round(chapSlowMap[k].ok / chapSlowMap[k].total * 100)), backgroundColor: C.neonOrange + "99", borderColor: C.neonOrange, borderWidth: 1, stack: "s" },
          { label: "Slow", data: chapKeys.map(k => Math.round(chapSlowMap[k].slow / chapSlowMap[k].total * 100)), backgroundColor: C.neonRed + "99", borderColor: C.neonRed, borderWidth: 1, stack: "s" },
        ]
      },
      options: hmOpts,
    });

    // 6. Stacked question distribution per session
    const stackedOpts = JSON.parse(JSON.stringify(baseOpts));
    stackedOpts.plugins.legend = { display: true, labels: { color: "#888", font: { family: "IBM Plex Mono", size: 9 }, boxWidth: 10 } };
    stackedOpts.scales.x = { ...axis, stacked: true };
    stackedOpts.scales.y = { ...axis, stacked: true };
    mk("adv-stacked", {
      type: "bar",
      data: {
        labels: sessLabels,
        datasets: [
          { label: "Fast", data: advSorted.map(s => s.questions.filter(q => q.speed === "fast").length), backgroundColor: C.neonGreen + "99", borderColor: C.neonGreen, borderWidth: 1, stack: "s" },
          { label: "OK", data: advSorted.map(s => s.questions.filter(q => q.speed === "ok").length), backgroundColor: C.neonOrange + "99", borderColor: C.neonOrange, borderWidth: 1, stack: "s" },
          { label: "Slow", data: advSorted.map(s => s.questions.filter(q => q.speed === "slow").length), backgroundColor: C.neonRed + "99", borderColor: C.neonRed, borderWidth: 1, stack: "s" },
        ]
      },
      options: stackedOpts,
    });
    return () => { Object.values(advChartsRef.current).forEach((c: any) => c?.destroy()); advChartsRef.current = {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advSorted, version]);

  // ── CUSTOM GRAPH BUILDER ──────────────────────────────────────────────
  useEffect(() => {
    if (!history.length || !window.Chart) return;
    const C2 = window.Chart;
    const { axis, tooltip } = chartDefaults();

    const el = builderCanvasRef.current; if (!el) return;
    if (chartsRef.current["builder"]) chartsRef.current["builder"].destroy();

    // Apply custom builder filters
    let data = [...history].sort((a, b) => a.date.localeCompare(b.date));
    if (cbDateFrom) data = data.filter(s => s.date >= cbDateFrom);
    if (cbDateTo) data = data.filter(s => s.date <= cbDateTo + "T23:59:59");
    if (cbSubject !== "all") data = data.filter(s => s.subject === cbSubject);
    if (cbChapter !== "all") data = data.filter(s => s.chapter === cbChapter);
    if (cbSource !== "all") data = data.filter(s => s.source === cbSource);

    const labels = data.map((s, i) => `S${i + 1} ${fmtDateShort(s.date)}`);
    const values = data.map(s => {
      const qs = s.questions;
      if (!qs.length) return null;
      const ak = s.answerKey || {};
      let c = 0, t = 0;
      qs.forEach(q => { if (ak[q.num]) { t++; if (q.answer === ak[q.num]) c++; } });
      if (cbMetric === "accuracy") return t ? Math.round(c / t * 100) : null;
      if (cbMetric === "avgTime") return Math.round(s.totalTimeSec / qs.length);
      if (cbMetric === "questions") return qs.length;
      if (cbMetric === "variance") {
        const times = qs.map(q => q.timeSec);
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        return Math.round(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length);
      }
      if (cbMetric === "struggleRate") return Math.round(qs.filter(q => q.speed === "slow").length / qs.length * 100);
      return null;
    });

    const color = cbMetric === "accuracy" ? C.accent : cbMetric === "avgTime" ? C.neonBlue : cbMetric === "questions" ? C.neonOrange : cbMetric === "variance" ? C.neonPurple : C.neonRed;
    const baseOpts = { responsive: true, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false }, tooltip }, scales: { x: { ...axis, stacked: cbChartType === "stackedBar" }, y: { ...axis, stacked: cbChartType === "stackedBar", max: cbMetric === "accuracy" || cbMetric === "struggleRate" ? 100 : undefined } } };

    chartsRef.current["builder"] = new C2(el.getContext("2d"), {
      type: cbChartType === "line" ? "line" : "bar",
      data: { labels, datasets: [{ data: values, borderColor: color, backgroundColor: color + (cbChartType === "line" ? "18" : "99"), pointRadius: 3, pointBackgroundColor: color, tension: 0.35, fill: cbChartType === "line", spanGaps: true, borderWidth: 2, borderRadius: cbChartType !== "line" ? 2 : 0 }] },
      options: baseOpts,
    });

    return () => { if (chartsRef.current["builder"]) { chartsRef.current["builder"].destroy(); delete chartsRef.current["builder"]; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cbDateFrom, cbDateTo, cbSubject, cbChapter, cbSource, cbMetric, cbChartType, history.length, version]);

  if (!history.length) {
    return (
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
        <SectionLabel>Analytics</SectionLabel>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.dim, padding: "40px 0" }}>Complete some sessions to see analytics.</div>
      </div>
    );
  }

  const monoSm: React.CSSProperties = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, padding: "5px 12px", borderRadius: 2, cursor: "pointer", letterSpacing: ".06em", transition: "all .12s" };
  const selBtn = (active: boolean): React.CSSProperties => ({ ...monoSm, border: `1px solid ${active ? C.accent : C.border2}`, background: active ? C.accent : "none", color: active ? "#000" : C.dim });

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px" }}>
      <SectionLabel>Analytics</SectionLabel>

      {/* subject filter */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {["all", ...subjects].map((s) => (
          <button key={s} className="preset-h" onClick={() => setSubjFilter(s)} style={selBtn(subjFilter === s)}>{s === "all" ? "All" : s}</button>
        ))}
      </div>

      {/* ── DATA ACCESS SUMMARY (top-level) ── */}
      {(() => {
        const avgScore = sorted.length
          ? Math.round(sorted.reduce((a, s) => a + calcScore(s.questions, s.answerKey || {}), 0) / sorted.length)
          : 0;
        const scCol = scoreCol(avgScore);
        return (
          <div style={{ ...card(), padding: "16px 20px", marginBottom: 28, display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: C.accent, lineHeight: 1 }}>{totalQ}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Total Questions</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: C.text, lineHeight: 1 }}>{sorted.length}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Sessions</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: C.neonBlue, lineHeight: 1 }}>{fmtHMS(totalTime)}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Total Study Time</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: accCol, lineHeight: 1 }}>{acc !== null ? acc + "%" : "—"}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Overall Accuracy</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}`, paddingRight: 12 }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: scCol, lineHeight: 1 }}>{avgScore}</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Avg Score</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 600, color: improvementRate !== null ? (improvementRate >= 0 ? C.neonGreen : C.neonRed) : C.dim, lineHeight: 1 }}>
                {improvementRate !== null ? (improvementRate >= 0 ? "+" : "") + improvementRate + "%" : "—"}
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 4 }}>Improvement Rate</div>
            </div>
          </div>
        );
      })()}

      {/* ── OVERVIEW CHARTS (fixed 6, unchanged) ── */}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".14em", marginBottom: 16 }}>Overview</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 36 }}>
        {[
          ["ov-acc", "Accuracy Over Time (%)"],
          ["ov-daily", "Questions Per Day"],
          ["ov-time", "Avg Time Per Question (sec)"],
          ["ov-speed", "Speed Breakdown — Fast / OK / Slow"],
          ["ov-subj", "Subject Accuracy (%)"],
          ["ov-cum", "Cumulative Questions"],
        ].map(([id, title]) => (
          <div key={id} style={{ ...card(), padding: 18 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim2, marginBottom: 14, letterSpacing: ".12em", textTransform: "uppercase" }}>{title}</div>
            <canvas id={id} style={{ maxHeight: 190 }} />
          </div>
        ))}
      </div>



      {/* ── PERFORMANCE INTELLIGENCE ── */}
      {insights.length > 0 && (
        <>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".14em", marginBottom: 12 }}>Performance Intelligence</div>
          <div style={{ ...card(), padding: "16px 18px", marginBottom: 28 }}>
            {insights.map((ins, i) => (
              <div key={i} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.dim3, lineHeight: 1.8, borderBottom: i < insights.length - 1 ? `1px solid ${C.border}` : "none", padding: "8px 0" }}>{ins}</div>
            ))}
          </div>
        </>
      )}

      {/* ── ADVANCED ANALYTICS ── */}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".14em", marginBottom: 16 }}>Advanced Analytics</div>

      {/* ── Advanced Analytics Filter Panel ── */}
      <div style={{ ...card({ borderColor: C.accent + "33" }), padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.accent, textTransform: "uppercase", letterSpacing: ".12em" }}>Filter Dataset</div>
          <button className="btn-outline-h" onClick={() => { setASubject("all"); setAChapter("all"); setASource("all"); setADatePreset("all"); setADateFrom(""); setADateTo(""); }}
            style={{ ...btnOutline(), fontSize: 9, padding: "3px 9px" }}>Reset Filters</button>
        </div>

        {/* Row 1 — dropdowns */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <div style={lblSt}>Subject</div>
            <select value={aSubject} onChange={e => { setASubject(e.target.value); setAChapter("all"); }}
              style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 10px", borderRadius: 2, outline: "none", cursor: "pointer" }}>
              <option value="all">All Subjects</option>
              {advSubjects.map(s => <option key={s} value={s} style={{ background: C.surface2 }}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={lblSt}>Chapter</div>
            <select value={aChapter} onChange={e => setAChapter(e.target.value)}
              style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 10px", borderRadius: 2, outline: "none", cursor: "pointer" }}>
              <option value="all">All Chapters</option>
              {advChapters.map(c => <option key={c} value={c} style={{ background: C.surface2 }}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={lblSt}>Source</div>
            <select value={aSource} onChange={e => setASource(e.target.value)}
              style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 10px", borderRadius: 2, outline: "none", cursor: "pointer" }}>
              <option value="all">All Sources</option>
              {advSources.map(s => <option key={s} value={s} style={{ background: C.surface2 }}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Row 2 — date range presets */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={lblSt}>Date Range</div>
            <div style={{ display: "flex", gap: 5 }}>
              {([["all", "All Time"], ["7d", "Last 7d"], ["30d", "Last 30d"], ["90d", "Last 90d"], ["custom", "Custom"]] as [typeof aDatePreset, string][]).map(([p, label]) => (
                <button key={p} className="grp-btn" onClick={() => setADatePreset(p)}
                  style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, padding: "5px 10px", borderRadius: 2, cursor: "pointer", letterSpacing: ".06em", transition: "all .12s", border: `1px solid ${aDatePreset === p ? C.accent : C.border2}`, background: aDatePreset === p ? C.accent : "none", color: aDatePreset === p ? "#000" : C.dim }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {aDatePreset === "custom" && (
            <>
              <div>
                <div style={lblSt}>From</div>
                <input type="date" value={aDateFrom} onChange={e => setADateFrom(e.target.value)}
                  style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "5px 8px", borderRadius: 2, outline: "none" }} />
              </div>
              <div>
                <div style={lblSt}>To</div>
                <input type="date" value={aDateTo} onChange={e => setADateTo(e.target.value)}
                  style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "5px 8px", borderRadius: 2, outline: "none" }} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Dataset Summary Bar ── */}
      <div style={{ ...card(), padding: "12px 18px", marginBottom: 20, display: "flex", gap: 28, flexWrap: "wrap", alignItems: "center", borderColor: C.border2 }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".1em" }}>Analysing:</div>
        <AdvSummaryItem label="Sessions" val={String(advStats.sessions)} col={C.accent} />
        <AdvSummaryItem label="Total Questions" val={String(advStats.totalQ)} col={C.text} />
        <AdvSummaryItem label="Avg Time / Q" val={advStats.totalQ > 0 ? fmt2(advStats.avgSec) : "—"} col={C.neonBlue} />
        <AdvSummaryItem label="Avg Performance" val={advStats.accuracy !== null ? advStats.accuracy + "%" : "—"} col={advStats.accuracy !== null ? (advStats.accuracy >= 75 ? C.neonGreen : advStats.accuracy >= 50 ? C.neonOrange : C.neonRed) : C.dim} />
        {advStats.sessions === 0 && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: C.neonRed }}>No sessions match the selected filters.</div>}
      </div>

      {/* ── 6 Advanced Charts ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        {[
          ["adv-improve", "Improvement Over Time (Accuracy + 7-Session MA)"],
          ["adv-time-eff", "Time Efficiency Trend (Avg sec/Q)"],
          ["adv-struggle", "Struggle Rate Trend (Slow % per session)"],
          ["adv-variance", "Variance Analysis (Time Spread per Session)"],
          ["adv-stacked", "Question Distribution (Fast / OK / Slow per Session)"],
          ["adv-heatmap", "Chapter Difficulty (Fast / OK / Slow % — top 10 chapters)"],
        ].map(([id, title]) => (
          <div key={id} style={{ ...card(), padding: 18 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.accent + "aa", marginBottom: 14, letterSpacing: ".12em", textTransform: "uppercase" }}>{title}</div>
            <canvas id={id} style={{ maxHeight: 220 }} />
          </div>
        ))}
      </div>

      {/* ── CUSTOM GRAPH BUILDER (new, fully custom) ── */}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: C.dim, textTransform: "uppercase", letterSpacing: ".14em", marginBottom: 16 }}>Custom Graph Builder</div>
      <div style={{ ...card({ borderColor: C.neonBlue + "44" }), padding: 20, marginBottom: 28 }}>
        {/* Filters */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div style={lblSt}>Date From</div>
            <input type="date" value={cbDateFrom} onChange={e => setCbDateFrom(e.target.value)} style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 8px", borderRadius: 2, outline: "none" }} />
          </div>
          <div>
            <div style={lblSt}>Date To</div>
            <input type="date" value={cbDateTo} onChange={e => setCbDateTo(e.target.value)} style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 8px", borderRadius: 2, outline: "none" }} />
          </div>
          <div>
            <div style={lblSt}>Subject</div>
            <select value={cbSubject} onChange={e => setCbSubject(e.target.value)} style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 8px", borderRadius: 2, outline: "none" }}>
              <option value="all">All</option>
              {subjects.map(s => <option key={s} value={s} style={{ background: C.surface2 }}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={lblSt}>Chapter</div>
            <select value={cbChapter} onChange={e => setCbChapter(e.target.value)} style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 8px", borderRadius: 2, outline: "none" }}>
              <option value="all">All</option>
              {allChapters.map(c => <option key={c} value={c} style={{ background: C.surface2 }}>{c}</option>)}
            </select>
          </div>
          <div>
            <div style={lblSt}>Source</div>
            <select value={cbSource} onChange={e => setCbSource(e.target.value)} style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, padding: "6px 8px", borderRadius: 2, outline: "none" }}>
              <option value="all">All</option>
              {allSources.map(s => <option key={s} value={s} style={{ background: C.surface2 }}>{s}</option>)}
            </select>
          </div>
        </div>
        {/* Metric + type */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div style={{ ...lblSt, marginBottom: 6 }}>Metric</div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {([["accuracy", "Accuracy %"], ["avgTime", "Avg Time"], ["questions", "Questions"], ["variance", "Variance"], ["struggleRate", "Struggle %"]] as [typeof cbMetric, string][]).map(([m, label]) => (
                <button key={m} className="grp-btn" onClick={() => setCbMetric(m)} style={selBtn(cbMetric === m)}>{label}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ ...lblSt, marginBottom: 6 }}>Chart Type</div>
            <div style={{ display: "flex", gap: 5 }}>
              {([["line", "Line"], ["bar", "Bar"], ["stackedBar", "Stacked"]] as [typeof cbChartType, string][]).map(([t, label]) => (
                <button key={t} className="grp-btn" onClick={() => setCbChartType(t)} style={selBtn(cbChartType === t)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ background: C.surface2, borderRadius: 3, padding: 16 }}>
          <canvas ref={builderCanvasRef} style={{ maxHeight: 300 }} />
        </div>
      </div>
    </div>
  );
}
