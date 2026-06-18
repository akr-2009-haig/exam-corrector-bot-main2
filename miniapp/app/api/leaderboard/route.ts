/**
 * GET /api/leaderboard
 *
 * Auth: the Telegram Mini App sends `window.Telegram.WebApp.initData` in the
 * `x-init-data` header; it is HMAC-verified against the bot token. Without a
 * valid signature the API refuses (unless ALLOW_ANON=1, for local testing only).
 *
 * Returns the ranking for all three tabs at once so switching is instant.
 */
import { type NextRequest, NextResponse } from "next/server";
import { leaderboard, getSeen, setSeen, type LeaderboardEntry } from "@/lib/db";
import { validateInitData } from "@/lib/telegram";

export const dynamic = "force-dynamic";

const TOP_N = 10;
/** Iraq is UTC+3 all year (no DST). Change TZ_OFFSET_MS for other regions. */
const TZ_OFFSET_MS = Number(process.env.TZ_OFFSET_MS ?? 3 * 60 * 60 * 1000);

interface RankedEntry {
  rank: number;
  name: string;
  points: number;
  exams: number;
  isMe: boolean;
}

interface PeriodData {
  top: RankedEntry[];
  me: (RankedEntry & { gap: number }) | null;
  total: number;
}

/** Start of the current week (Saturday) in local time, as a UTC ms stamp. */
function startOfWeek(now: number): number {
  const local        = new Date(now + TZ_OFFSET_MS);
  const sinceSaturday = (local.getUTCDay() + 1) % 7; // Sat→0 … Fri→6
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - sinceSaturday)
    - TZ_OFFSET_MS
  );
}

function startOfMonth(now: number): number {
  const local = new Date(now + TZ_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET_MS;
}

function rank(entries: LeaderboardEntry[], meId: number | null): PeriodData {
  const ranked = entries.map((e, i) => ({
    rank:   i + 1,
    name:   e.name,
    points: Math.round(e.points * 10) / 10,
    exams:  e.exams,
    isMe:   meId !== null && e.userId === meId,
  }));

  const meIdx = ranked.findIndex((e) => e.isMe);
  const me =
    meIdx >= 0
      ? {
          ...ranked[meIdx]!,
          gap:
            meIdx > 0
              ? Math.max(1, Math.ceil(ranked[meIdx - 1]!.points - ranked[meIdx]!.points))
              : 0,
        }
      : null;

  return { top: ranked.slice(0, TOP_N), me, total: ranked.length };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const initData = req.headers.get("x-init-data") || "";
  const user     = validateInitData(initData, process.env.BOT_TOKEN || "");

  if (!user && process.env.ALLOW_ANON !== "1") {
    return NextResponse.json({ error: "افتح هذه الصفحة من داخل تيليجرام" }, { status: 401 });
  }

  const meId = user?.id ?? null;
  const now  = Date.now();

  try {
    const all = rank(leaderboard(0), meId);

    let celebration: {
      prevRank: number;
      newRank: number;
      pointsGained: number;
      overtook: number;
    } | null = null;

    if (meId !== null && all.me) {
      const prev   = getSeen(meId);
      const gained = prev ? Math.round((all.me.points - prev.points) * 10) / 10 : 0;
      if (prev && (all.me.rank < prev.rank || gained > 0)) {
        celebration = {
          prevRank:     prev.rank,
          newRank:      all.me.rank,
          pointsGained: Math.max(0, gained),
          overtook:     Math.max(0, prev.rank - all.me.rank),
        };
      }
      setSeen(meId, all.me.rank, all.me.points);
    }

    return NextResponse.json({
      periods: {
        all,
        week:  rank(leaderboard(startOfWeek(now)),  meId),
        month: rank(leaderboard(startOfMonth(now)), meId),
      },
      celebration,
      updatedAt: now,
    });
  } catch (err) {
    console.error("[leaderboard] query failed:", err);
    return NextResponse.json({ error: "تعذّر تحميل البيانات" }, { status: 500 });
  }
}
