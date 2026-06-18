/**
 * Forced channel membership ("join gate").
 *
 * Every non-admin interaction is allowed only when the user is a member of
 * the required channel (config.requiredChannelId). The check is performed
 * live on every interaction — no caching — so the moment a user leaves the
 * channel they are locked out immediately.
 *
 * The bot must be an ADMIN of the channel; if the check itself fails (e.g.
 * misconfigured channel), we FAIL OPEN with a log warning rather than locking
 * everyone out.
 */
import { Markup, type Context } from "telegraf";
import type { Telegram } from "telegraf";
import { config } from "./config.js";

/** Callback id of the "verify my membership" button. */
export const CB_CHECK_JOIN = "chkjoin";

/**
 * Is the user a member of the required channel?
 * Checked live against Telegram on EVERY call (no caching).
 */
export async function isChannelMember(
  telegram: Telegram,
  userId: number,
): Promise<boolean> {
  if (!config.requiredChannelId) return true; // gate disabled

  try {
    const m = await telegram.getChatMember(config.requiredChannelId, userId);
    return (
      m.status === "creator" ||
      m.status === "administrator" ||
      m.status === "member" ||
      (m.status === "restricted" && (m as any).is_member === true)
    );
  } catch (err: any) {
    // Bot not admin in the channel / bad id — don't lock users out.
    console.warn(`[membership] getChatMember failed: ${err?.message ?? err}`);
    return true;
  }
}

/** The join-required prompt with the channel link + verify button. */
export async function sendJoinPrompt(ctx: Context): Promise<void> {
  const username = config.requiredChannelUsername;
  const rows = [];
  if (username) {
    rows.push([Markup.button.url("📢 الانضمام إلى القناة", `https://t.me/${username}`)]);
  }
  rows.push([Markup.button.callback("✅ تحقّقت من الاشتراك", CB_CHECK_JOIN)]);

  await ctx
    .reply(
      "‎🔒 <b>الاشتراك في القناة مطلوب</b>\n" +
        "\n" +
        "للاستفادة من البوت يجب الاشتراك في قناتنا أولًا" +
        (username ? `:\n📢 @${username}` : ".") +
        "\n\n" +
        "بعد الاشتراك اضغط «✅ تحقّقت من الاشتراك».",
      { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) },
    )
    .catch(() => {});
}
