// POST /api/skills/submit —— 登录用户上传 skill（前端 jszip 解压后传 files JSON），
// 后端严格兜底校验 → 自动在 skill 仓库开 PR（@mention 提交者）。
//
// 鉴权：中间件 functions/api/_middleware.ts 已把 /api/skills/submit 纳入 needsAuth，
// 验证登录并注入 context.data.uid / context.data.login（不在此重复验证、不扣费）。

import { createSkillPR, type SubmitFile } from "../../_lib/skillPR";

interface Env {
    TASKS: KVNamespace;
    GITHUB_PR_TOKEN?: string;
}

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const MAX_FILES = 40;
const MAX_FILE = 256 * 1024;       // 单文件 256KB
const MAX_TOTAL = 1024 * 1024;     // 总 1MB
const ALLOW_EXT = /\.(md|json|txt|yml|yaml)$/i;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;   // kebab-case

// 路径安全：拒绝越界 / 绝对 / 反斜杠 / 超过两层 / 空段
function badPath(p: string): boolean {
    if (p.includes("..") || p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return true;
    const segs = p.split("/");
    if (segs.length > 2) return true;             // skill 内最多一层子目录
    if (segs.some((s) => s.trim() === "")) return true;
    return false;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const uid: string | undefined = (context.data as any)?.uid;
    const login: string | undefined = (context.data as any)?.login;
    if (!uid || !login) return json({ ok: false, error: "请先登录" }, 401);

    let body: any = {};
    try { body = await context.request.json(); } catch { /* ignore */ }

    const skillId = String(body.skillId || "").trim();
    const files: SubmitFile[] = Array.isArray(body.files) ? body.files : [];
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";

    // ── 校验 ──
    if (!ID_RE.test(skillId)) return json({ ok: false, error: "skill id 不合法（仅小写字母/数字/中划线）" }, 400);
    if (!files.length) return json({ ok: false, error: "没有文件" }, 400);
    if (files.length > MAX_FILES) return json({ ok: false, error: `文件数超限（最多 ${MAX_FILES}）` }, 400);

    let total = 0;
    for (const f of files) {
        if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
            return json({ ok: false, error: "文件项格式错误" }, 400);
        }
        if (badPath(f.path)) return json({ ok: false, error: `非法路径：${f.path}` }, 400);
        if (!ALLOW_EXT.test(f.path)) return json({ ok: false, error: `不允许的文件类型：${f.path}` }, 400);
        const size = new TextEncoder().encode(f.content).length;
        if (size > MAX_FILE) return json({ ok: false, error: `文件过大：${f.path}` }, 400);
        total += size;
    }
    if (total > MAX_TOTAL) return json({ ok: false, error: "总体积超限（最多 1MB）" }, 400);

    const brief = files.find((f) => f.path === "brief.json");
    if (!brief) return json({ ok: false, error: "缺少 brief.json" }, 400);
    let briefObj: any;
    try { briefObj = JSON.parse(brief.content); } catch { return json({ ok: false, error: "brief.json 不是合法 JSON" }, 400); }
    if (!briefObj.id || !briefObj.name || !Array.isArray(briefObj.structure)) {
        return json({ ok: false, error: "brief.json 缺少 id / name / structure" }, 400);
    }
    if (briefObj.id !== skillId) return json({ ok: false, error: "brief.json.id 与目录名不一致" }, 400);

    // ── 每用户限频（60s 一次，防刷 PR）──
    try {
        const k = `submit:${uid}`;
        if (await context.env.TASKS.get(k)) return json({ ok: false, error: "提交过于频繁，请稍后再试" }, 429);
        await context.env.TASKS.put(k, "1", { expirationTtl: 60 });
    } catch { /* ignore */ }

    // ── 开 PR ──
    try {
        const { prUrl } = await createSkillPR(context.env, { skillId, files, author: { uid, login }, note });
        return json({ ok: true, prUrl });
    } catch (e: any) {
        return json({ ok: false, error: "开 PR 失败：" + (e?.message || String(e)) }, 502);
    }
};
