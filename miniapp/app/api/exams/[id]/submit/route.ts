/**
 * POST /api/exams/[id]/submit — a student uploads answer-sheet photo(s)
 * (multipart field "photos"); we grade them against the exam key, apply speed
 * + loyalty bonuses, record the submission, post to the points ledger and
 * return the full report. Admins always submit in TEST mode (never counted).
 *
 * One graded attempt per exam; a second needs a teacher-granted retake, which
 * is consumed here and replaces the earlier attempt (and its ledger rows).
 */
import { type NextRequest, NextResponse } from "next/server";
import { authUser } from "@/lib/auth";
import {
  getExam,
  getUser,
  resolveName,
  lastSubmissionForExam,
  hasRetake,
  consumeRetake,
  replaceOldSubmissions,
  reverseExamLedger,
  recordSubmission,
  postLedger,
  ledgerBalance,
} from "@/lib/db";
import { buildGradingPrompt, normalizeGradingResult, type GradingResult } from "@/lib/prompts";
import { visionJSON, imagePart, isConfigured, MODELS, type ContentPart } from "@/lib/gemini";
import { saveImage, newGroup } from "@/lib/uploads";
import { speedBonus, loyaltyBonus } from "@/lib/scoring";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PHOTOS = 8;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Early check — fail fast before reading uploaded files.
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "خدمة الذكاء الاصطناعي غير مهيأة. تواصل مع المشرف." },
      { status: 503 },
    );
  }

  const { id: examId } = await params;
  const exam = getExam(examId);
  if (!exam || !exam.row.is_active) {
    return NextResponse.json({ error: "هذا الامتحان لم يعد متاحًا." }, { status: 404 });
  }

  const isTest = user.isAdmin;

  // One real attempt per exam (unless a retake was granted).
  const prior      = isTest ? null : lastSubmissionForExam(examId, user.id);
  const usingRetake = !!prior && hasRetake(examId, user.id);
  if (prior && !usingRetake) {
    return NextResponse.json(
      {
        error:   "أجبتَ عن هذا الامتحان من قبل.",
        already: true,
        score:   { awarded: prior.score_awarded, max: prior.score_max },
      },
      { status: 409 },
    );
  }

  // Collect uploaded images.
  let files: File[];
  try {
    const form = await req.formData();
    files = form
      .getAll("photos")
      .filter((f): f is File => f instanceof File && f.size > 0)
      .slice(0, MAX_PHOTOS);
  } catch (err) {
    console.error("[submit] formData failed:", (err as any)?.message ?? err);
    return NextResponse.json({ error: "تعذّر قراءة الصور المرفوعة." }, { status: 400 });
  }
  if (!files.length) {
    return NextResponse.json({ error: "أرسل صورة ورقة إجاباتك." }, { status: 400 });
  }

  const submittedAt = Date.now();
  const group = newGroup();
  let saved;
  try {
    saved = await Promise.all(files.map((f, i) => saveImage(f, group, i)));
  } catch (err) {
    console.error("[submit] saveImage failed:", (err as any)?.message ?? err);
    return NextResponse.json(
      { error: "تعذّر حفظ الصور. تأكد أنها صور صحيحة وأعد المحاولة." },
      { status: 400 },
    );
  }

  // Grade.
  let result: GradingResult;
  try {
    const prompt = buildGradingPrompt(exam.row.key_json, "balanced");
    const parts: ContentPart[] = [
      { type: "text", text: "هذه صور ورقة إجابة الطالب. صحّحها وفق المفتاح." },
      ...saved.map((s) => imagePart(s.dataUrl)),
    ];
    const raw = await visionJSON<GradingResult>(MODELS.grading(), prompt, parts);
    if (!raw?.questions?.length) throw new Error("empty grading result");
    result = normalizeGradingResult(exam.key, raw);
  } catch (err: any) {
    console.error("[submit] grading failed:", err?.message ?? err);
    return NextResponse.json(
      { error: "تعذّر قراءة ورقتك بوضوح. أعد تصويرها بإضاءة جيدة وأعد المحاولة." },
      { status: 422 },
    );
  }

  const base    = result.total_awarded;
  const speed   = isTest ? { points: 0, pct: 0 }           : speedBonus(base, submittedAt, exam.row.created_at);
  const loyalty = isTest ? { points: 0, pct: 0, streak: 0 } : loyaltyBonus(base, user.id, examId);

  const studentName  = resolveName(getUser(user.id), user.id);
  const submissionId = recordSubmission({
    examId,
    userId:        user.id,
    username:      user.username ?? null,
    studentName,
    photoPaths:    saved.map((s) => s.rel),
    isTest,
    scoreAwarded:  base,
    scoreMax:      result.total_max,
    speedBonus:    speed.points,
    loyaltyBonus:  loyalty.points,
    result,
  });

  if (!isTest) {
    if (usingRetake) {
      reverseExamLedger(examId, user.id);
      consumeRetake(examId, user.id);
      replaceOldSubmissions(examId, user.id, submissionId);
    }
    postLedger(user.id, base,                       "exam_base",  examId, submittedAt);
    postLedger(user.id, speed.points + loyalty.points, "exam_bonus", examId, submittedAt);
  }

  return NextResponse.json({
    submissionId,
    result,
    isTest,
    bonus: {
      speed:   { points: speed.points,   pct: speed.pct },
      loyalty: { points: loyalty.points, pct: loyalty.pct, streak: loyalty.streak },
      total:   Math.round((speed.points + loyalty.points) * 10) / 10,
    },
    pointsEarned: Math.round((base + speed.points + loyalty.points) * 10) / 10,
    balance:      ledgerBalance(user.id),
  });
}
