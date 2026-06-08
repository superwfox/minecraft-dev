// POST /api/sponsor/bind → 用爱发电订单号兑换额度
// body: { orderNo: string }

import { verifySession, getSessionCookie } from "../../_lib/session";
import { queryOrder } from "../../_lib/afdian";
import { redeem } from "../../_lib/quota";

interface Env {
    SESSION_SECRET: string;
    TASKS: KVNamespace;
    AFDIAN_USER_ID: string;
    AFDIAN_TOKEN: string;
}

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const session = await verifySession(getSessionCookie(context.request), context.env.SESSION_SECRET);
    if (!session) return json({ ok: false, reason: "请先登录" }, 401);

    let orderNo = "";
    try {
        orderNo = String((await context.request.json() as any).orderNo || "").trim();
    } catch { /* ignore */ }
    if (!orderNo) return json({ ok: false, reason: "请输入订单号" }, 400);

    let order;
    try {
        order = await queryOrder(context.env.AFDIAN_USER_ID, context.env.AFDIAN_TOKEN, orderNo);
    } catch (e: any) {
        return json({ ok: false, reason: "查询订单失败，请稍后再试" }, 502);
    }
    if (!order) return json({ ok: false, reason: "未查询到该订单，请确认订单号" }, 404);

    const result = await redeem(context.env.TASKS, session.uid, order.outTradeNo, order.amount);
    return json(result, result.ok ? 200 : 409);
};
