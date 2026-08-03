import { getSessionCookie, verifySession } from "../../../_lib/session";
import { isAdmin } from "../../../_lib/sponsor";
import {
    LearningStoreUnavailableError,
    reviewKnowledgeItem,
} from "../../../_lib/learning/store";

interface Env {
    ADMIN_UID: string;
    DB?: D1Database;
    SESSION_SECRET: string;
}

type ReviewAction = "approve" | "reject" | "deprecate";

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const session = await verifySession(
        getSessionCookie(context.request),
        context.env.SESSION_SECRET,
    );
    if (!isAdmin(session?.uid, context.env)) {
        return json({ ok: false, reason: "无权限" }, 403);
    }

    let body: any = {};
    try { body = await context.request.json(); } catch { /* validated below */ }
    const knowledgeId = typeof body.knowledgeId === "string" ? body.knowledgeId.trim() : "";
    const action = String(body.action || "") as ReviewAction;
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
    if (knowledgeId.length > 80 || !/^know_[a-z0-9]+$/i.test(knowledgeId)) {
        return json({ ok: false, reason: "知识条目 ID 无效" }, 400);
    }

    const statuses = {
        approve: "active",
        reject: "rejected",
        deprecate: "deprecated",
    } as const;
    const status = statuses[action];
    if (!status) return json({ ok: false, reason: "未知操作" }, 400);

    try {
        const item = await reviewKnowledgeItem(context.env, {
            knowledgeId,
            status,
            note,
        });
        if (!item) {
            const reasons: Record<ReviewAction, string> = {
                approve: "条目已处理、不是最新 revision，或策略知识暂不可激活",
                reject: "条目已处理或不是最新 revision",
                deprecate: "条目已失效或状态已变化",
            };
            return json({ ok: false, reason: reasons[action] }, 409);
        }
        return json({ ok: true, item });
    } catch (error) {
        if (error instanceof LearningStoreUnavailableError) {
            return json({ ok: false, reason: "学习存储未配置" }, 503);
        }
        console.warn("knowledge admin review failed", error);
        return json({ ok: false, reason: "知识审核操作失败" }, 500);
    }
};
