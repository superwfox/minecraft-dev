import { getSessionCookie, verifySession } from "../../../_lib/session";
import { isAdmin } from "../../../_lib/sponsor";
import {
    getLearningEvidenceItems,
    LearningStoreUnavailableError,
    listReviewableKnowledge,
} from "../../../_lib/learning/store";

interface Env {
    ADMIN_UID: string;
    DB?: D1Database;
    SESSION_SECRET: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await verifySession(
        getSessionCookie(context.request),
        context.env.SESSION_SECRET,
    );
    if (!isAdmin(session?.uid, context.env)) {
        return json({ ok: false, reason: "无权限" }, 403);
    }

    const url = new URL(context.request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;

    try {
        const items = await listReviewableKnowledge(context.env, limit);
        const evidence = await getLearningEvidenceItems(
            context.env,
            items.map((item) => item.knowledgeId),
        );
        const sourcesByKnowledge = new Map(
            evidence.map((item) => [item.knowledgeId, item.sources]),
        );
        return json({
            ok: true,
            items: items.map((item) => ({
                ...item,
                sources: sourcesByKnowledge.get(item.knowledgeId) ?? [],
            })),
        });
    } catch (error) {
        if (error instanceof LearningStoreUnavailableError) {
            return json({ ok: false, reason: "学习存储未配置" }, 503);
        }
        console.warn("knowledge admin list failed", error);
        return json({ ok: false, reason: "知识审核列表加载失败" }, 500);
    }
};
