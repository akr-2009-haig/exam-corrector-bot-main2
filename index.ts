/**
 * Thin launcher bot.
 *
 * All product logic now lives in the Mini App (Next.js). This process only:
 *   1. opens the Mini App (inline web_app button + chat menu button),
 *   2. keeps the forced channel-membership gate,
 *   3. keeps the `users` table fresh (for broadcasts / name fallback),
 *   4. drains the `outbox` table — notifications the Mini App queued
 *      (new-exam announcements, retake decisions, competition results).
 */
import { Telegraf, Markup, type Context } from "telegraf";
import { config, isAdmin } from "./src/config.js";
import { upsertUser, unsentOutbox, markOutboxSent, type OutboxRow } from "./src/db.js";
import { isChannelMember, sendJoinPrompt, CB_CHECK_JOIN } from "./src/membership.js";

const bot = new Telegraf(config.botToken, { handlerTimeout: 30_000 });

process.on("unhandledRejection", (r) => console.error("[process] unhandled rejection:", r));
process.on("uncaughtException",  (e) => console.error("[process] uncaught exception:",  e));

// Keep each user's profile fresh — used by the Mini App for names/broadcasts.
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && !ctx.from.is_bot) {
      upsertUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    }
  } catch (err) {
    console.error("[middleware] upsertUser failed:", err);
  }
  return next();
});

// Channel-join gate (admins exempt). Verified live on every interaction.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId === undefined || ctx.from?.is_bot || isAdmin(userId)) return next();

  const isCheckTap = (ctx.callbackQuery as any)?.data === CB_CHECK_JOIN;
  const ok = await isChannelMember(ctx.telegram, userId);
  if (ok) {
    if (isCheckTap) {
      await ctx.answerCbQuery("✅ تم التحقق من اشتراكك").catch(() => {});
      await ctx.editMessageText("✅ <b>شكرًا لاشتراكك!</b>", { parse_mode: "HTML" }).catch(() => {});
      await sendLauncher(ctx);
      return;
    }
    return next();
  }
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("❌ لم تشترك في القناة بعد", { show_alert: isCheckTap }).catch(() => {});
    if (isCheckTap) return;
  }
  await sendJoinPrompt(ctx);
});

/** Open the Mini App, optionally jumping to a specific section (view query param). */
async function sendLauncher(ctx: Context, view?: string): Promise<void> {
  const base = config.miniAppUrl;
  if (!base) {
    await ctx.reply("⚠️ لم يتم ضبط رابط التطبيق بعد. تواصل مع المشرف.");
    return;
  }
  const url = view ? `${base}?view=${view}` : base;
  const intro =
    "👋 <b>أهلًا بك في منصة الامتحانات</b>\n\n" +
    "كل شيء أصبح داخل التطبيق: إرسال ورقتك وتصحيحها، نتائجك، التصنيف، والمسابقات.\n\n" +
    "اضغط الزر بالأسفل لفتح التطبيق 👇";
  await ctx.reply(intro, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([[Markup.button.webApp("🚀 فتح التطبيق", url)]]),
  });
}

/** Send a contextual message for a specific section with a direct deep-link button. */
async function sendViewButton(ctx: Context, view: string, title: string, desc: string): Promise<void> {
  const base = config.miniAppUrl;
  if (!base) {
    await ctx.reply("⚠️ لم يتم ضبط رابط التطبيق بعد. تواصل مع المشرف.");
    return;
  }
  await ctx.reply(
    `<b>${title}</b>\n\n${desc}\n\n👇 اضغط الزر للانتقال مباشرة:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.webApp("🚀 انتقل الآن", `${base}?view=${view}`)]]),
    },
  );
}

const safe =
  (label: string, fn: (ctx: Context) => Promise<unknown> | unknown) =>
  async (ctx: Context) => {
    try {
      await fn(ctx);
    } catch (err) {
      console.error(`[${label}] failed:`, err);
    }
  };

// ─── Core launcher commands ────────────────────────────────────────────────
bot.start(safe("start", sendLauncher));
bot.command("app",  safe("app",  sendLauncher));
bot.command("open", safe("open", sendLauncher));

// ─── Student commands — each opens the right section in the Mini App ───────
bot.command("exams",   safe("exams",   (ctx) => sendViewButton(ctx, "grade",   "📝 الامتحانات",       "اختر الامتحان المتاح وأرسل ورقتك للتصحيح الفوري.")));
bot.command("results", safe("results", (ctx) => sendViewButton(ctx, "results", "📊 نتائجي",           "كل درجاتك وتصحيحاتك التفصيلية.")));
bot.command("history", safe("history", (ctx) => sendViewButton(ctx, "results", "📋 سجل إجاباتي",     "تصفّح جميع محاولاتك السابقة وتصحيحاتها.")));

// ─── Admin commands ────────────────────────────────────────────────────────
bot.command("students", safe("students", (ctx) => sendViewButton(ctx, "students", "👤 الطلاب",          "اعرض درجات كل طالب ومحاولاته.")));
bot.command("new",      safe("new",      (ctx) => sendViewButton(ctx, "register", "📝 تسجيل امتحان جديد", "ارفع مفتاح الإجابة النموذجية وفعّل الامتحان.")));

// ─── Legacy commands — now handled inside the Mini App ────────────────────
bot.command("test",   safe("test",   (ctx) => ctx.reply("ℹ️ ميزة الاختبار متاحة داخل التطبيق. استخدم /app للفتح.", { parse_mode: "HTML" })));
bot.command("cancel", safe("cancel", (ctx) => ctx.reply("ℹ️ جميع العمليات تُدار داخل التطبيق. استخدم /app للفتح.", { parse_mode: "HTML" })));
bot.command("skip",   safe("skip",   (ctx) => ctx.reply("ℹ️ جميع العمليات تُدار داخل التطبيق. استخدم /app للفتح.", { parse_mode: "HTML" })));

// Anything else → open launcher.
bot.on("message", safe("msg", sendLauncher));

bot.catch((err, ctx) => {
  const msg = String((err as any)?.message || err);
  if (msg.includes("bot was blocked") || msg.includes("message is not modified")) return;
  console.error(`[Telegraf] error on ${ctx.updateType}:`, msg);
});

// ─── Outbox drainer ────────────────────────────────────────────────────────
async function drainOutbox(): Promise<void> {
  const rows = unsentOutbox(25);
  for (const row of rows) {
    await sendOutbox(row);
    await new Promise((r) => setTimeout(r, 60)); // ~16/sec, safely under limits
  }
}

async function sendOutbox(row: OutboxRow): Promise<void> {
  try {
    let buttons: { text: string; url: string }[][] | null = null;
    if (row.buttons_json) {
      try { buttons = JSON.parse(row.buttons_json); } catch { buttons = null; }
    }
    const extra: any = { parse_mode: "HTML", disable_web_page_preview: true };
    if (buttons?.length) {
      extra.reply_markup = {
        inline_keyboard: buttons.map((r) => r.map((b) => ({ text: b.text, url: b.url }))),
      };
    }
    await bot.telegram.sendMessage(row.user_id, row.text, extra);
    markOutboxSent(row.id);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (
      msg.includes("bot was blocked") ||
      msg.includes("chat not found") ||
      msg.includes("user is deactivated")
    ) {
      markOutboxSent(row.id); // Permanent failure: drop so we don't loop.
    } else {
      console.warn(`[outbox] send to ${row.user_id} failed: ${msg}`);
    }
  }
}

/** Set the persistent chat menu button to open the Mini App. */
async function setupMenuButton(): Promise<void> {
  if (!config.miniAppUrl) return;
  await bot.telegram
    .setChatMenuButton({
      menuButton: { type: "web_app", text: "📚 التطبيق", web_app: { url: config.miniAppUrl } },
    })
    .catch((err) => console.warn("[menu] setChatMenuButton failed:", err?.message));
}

bot
  .launch(() => {
    console.log(`Launcher bot started. Admins: ${config.adminIds.join(", ") || "(none)"}`);
    bot.telegram
      .setMyCommands([
        { command: "start",    description: "🏠 البداية" },
        { command: "app",      description: "🚀 فتح التطبيق" },
        { command: "exams",    description: "📝 الامتحانات المتاحة" },
        { command: "results",  description: "📊 نتائجي" },
        { command: "history",  description: "📋 سجل إجاباتي" },
        { command: "students", description: "👤 قائمة الطلاب (للمشرف)" },
        { command: "new",      description: "➕ تسجيل امتحان جديد (للمشرف)" },
      ])
      .catch(() => {});
    setupMenuButton();
    setInterval(
      () => drainOutbox().catch((err) => console.error("[outbox] crash:", err)),
      3000,
    );
  })
  .catch((err) => {
    console.error("[launch] bot crashed:", err);
    process.exit(1);
  });

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
