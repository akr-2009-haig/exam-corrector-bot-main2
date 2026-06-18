"use client";

/**
 * Mini App shell: loads the caller's profile, enforces the channel gate and a
 * first-run name prompt, then routes between capability views (cards on Home).
 * Navigation drives Telegram's NATIVE back button via a small back-stack
 * (see nav.tsx) — no in-app navigation bar. All logic lives in app/api/*.
 *
 * Deep-link navigation: bot commands open the Mini App with ?view=<ViewKey>
 * so students land directly on the requested section.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, setupViewport, tg } from "./tg";
import { NavContext } from "./nav";
import Home from "./components/Home";
import Grade from "./components/Grade";
import MyResults from "./components/MyResults";
import Leaderboard from "./components/Leaderboard";
import Competition from "./components/Competition";
import ResultToast from "./components/ResultToast";
import Loader from "./components/Loader";
import RegisterExam from "./components/admin/RegisterExam";
import ManageExams from "./components/admin/ManageExams";
import Students from "./components/admin/Students";
import Retakes from "./components/admin/Retakes";

export type ViewKey =
  | "home"
  | "grade"
  | "results"
  | "leaderboard"
  | "competition"
  | "register"
  | "manage"
  | "students"
  | "retakes";

const VALID_VIEWS: ViewKey[] = [
  "grade", "results", "leaderboard", "competition",
  "register", "manage", "students", "retakes",
];

interface Me {
  id: number;
  name: string;
  hasName: boolean;
  isAdmin: boolean;
  balance: number;
  gated: boolean;
  channel: { id: string; username: string };
}

const TITLES: Record<ViewKey, string> = {
  home:        "",
  grade:       "📝 الامتحانات",
  results:     "📊 نتائجي",
  leaderboard: "🏆 التصنيف",
  competition: "🎯 المسابقات",
  register:    "📝 تسجيل امتحان",
  manage:      "📚 الامتحانات",
  students:    "👤 الطلاب",
  retakes:     "🙏 طلبات الإعادة",
};

export default function Page() {
  const [me,    setMe]    = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view,  setView]  = useState<ViewKey>("home");

  // Native back-button stack: each screen pushes a "go back" handler.
  const backStack = useRef<(() => void)[]>([]);
  const [depth, setDepth] = useState(0);
  const push = useCallback((handler: () => void) => {
    backStack.current.push(handler);
    setDepth(backStack.current.length);
    return () => {
      const i = backStack.current.lastIndexOf(handler);
      if (i >= 0) backStack.current.splice(i, 1);
      setDepth(backStack.current.length);
    };
  }, []);

  useEffect(() => {
    setupViewport();
    api<Me>("/api/me")
      .then((meData) => {
        setMe(meData);
        // Deep-link: bot commands open the app with ?view=<ViewKey>.
        // Read it once on first load and navigate to the requested section.
        const params    = new URLSearchParams(window.location.search);
        const deepLink  = params.get("view") as ViewKey | null;
        if (deepLink && VALID_VIEWS.includes(deepLink)) {
          setView(deepLink);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  // Wire the native back button once; it always invokes the top of the stack.
  useEffect(() => {
    const bb = tg()?.BackButton;
    if (!bb) return;
    const onClick = () => backStack.current[backStack.current.length - 1]?.();
    bb.onClick(onClick);
    return () => bb.offClick?.(onClick);
  }, []);
  useEffect(() => {
    const bb = tg()?.BackButton;
    if (!bb) return;
    if (depth > 0) bb.show();
    else bb.hide();
  }, [depth]);

  // Top-level views push a back entry that returns to the home cards.
  useEffect(() => {
    if (view === "home") return;
    return push(() => setView("home"));
  }, [view, push]);

  if (error) return <main className="wrap"><div className="state state-error">⚠️ {error}</div></main>;
  if (!me)   return <main className="wrap"><Loader text="جارٍ التحميل..." /></main>;

  if (me.gated)
    return <main className="wrap"><JoinGate channel={me.channel} /></main>;
  if (!me.isAdmin && !me.hasName)
    return <main className="wrap"><NameGate onSaved={(name) => setMe({ ...me, name, hasName: true })} /></main>;

  return (
    <NavContext.Provider value={{ push }}>
      <main className="wrap">
        {view === "home" && <ResultToast />}
        {/* leaderboard renders its own animated hero header instead of the title */}
        {view !== "home" && view !== "leaderboard" && (
          <h1 className="page-title">{TITLES[view]}</h1>
        )}

        {view === "home"        && <Home isAdmin={me.isAdmin} name={me.name} balance={me.balance} photoUrl={tg()?.initDataUnsafe?.user?.photo_url || null} onNavigate={setView} />}
        {view === "grade"       && <Grade />}
        {view === "results"     && <MyResults />}
        {view === "leaderboard" && <Leaderboard />}
        {view === "competition" && <Competition isAdmin={me.isAdmin} />}
        {view === "register"    && <RegisterExam onDone={() => setView("home")} />}
        {view === "manage"      && <ManageExams />}
        {view === "students"    && <Students />}
        {view === "retakes"     && <Retakes />}
      </main>
    </NavContext.Provider>
  );
}

function JoinGate({ channel }: { channel: { username: string } }) {
  return (
    <div className="gate">
      <div className="gate-lock">🔒</div>
      <h2>الاشتراك في القناة مطلوب</h2>
      <p>للاستفادة من التطبيق اشترك في قناتنا أولًا{channel.username ? `: @${channel.username}` : "."}</p>
      {channel.username && (
        <a className="btn btn-primary" href={`https://t.me/${channel.username}`} target="_blank" rel="noreferrer">
          📢 الانضمام إلى القناة
        </a>
      )}
      <button className="btn btn-ghost" onClick={() => location.reload()}>
        ✅ تحقّقت — إعادة المحاولة
      </button>
    </div>
  );
}

function NameGate({ onSaved }: { onSaved: (name: string) => void }) {
  const [name,  setName]  = useState("");
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ name: string }>("/api/me", { body: { name } });
      onSaved(d.name);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-lock">👋</div>
      <h2>أهلًا بك!</h2>
      <p>أرسل اسمك الكامل لتظهر نتيجتك وترتيبك باسمك.</p>
      <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="الاسم الكامل" />
      {error && <div className="state state-error">{error}</div>}
      <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>
        {busy ? "…" : "حفظ والمتابعة"}
      </button>
    </div>
  );
}
