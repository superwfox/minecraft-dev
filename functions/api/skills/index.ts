// GET /api/skills —— 公开只读：实时拉社区 skill 仓库（superwfox/TAHAI-Skills）的
// 顶层 README + 各子目录 brief.json，聚合成 { readme, skills[] }。
//
// 拉取核心（仓库/分支/UA/raw）复用 functions/_lib/skills.ts。
// 中间件（functions/api/_middleware.ts）只对 /api/generate/、/api/chat、/api/stream
// 强制登录+限流，所以本端点天然公开只读，无需鉴权。
//
// KV(TASKS) 缓存 10 分钟 + 7 天兜底；GitHub 失败/仓库不存在 → 回退兜底或空态，始终 200。

import { BRANCHES, listRoot, rawText, type SkillEnv } from "../../_lib/skills";

const CACHE_KEY = "skills:index";
const BACKUP_KEY = "skills:index:backup";
const CACHE_TTL = 600;                    // 10 分钟新鲜缓存
const BACKUP_TTL = 7 * 24 * 3600;         // 7 天降级兜底

function json(obj: any, status = 200): Response {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
    });
}

const BRIEF_FIELDS = [
    "id", "name", "author", "version", "description", "capability",
    "tags", "coreTypes", "mcVersions", "expectedGlobals", "structure",
];
function pickBrief(o: any, dir: string): any {
    const out: any = {};
    for (const k of BRIEF_FIELDS) if (o[k] !== undefined) out[k] = o[k];
    if (!out.id) out.id = dir;
    out.path = dir;
    return out;
}

async function buildIndex(env: SkillEnv): Promise<{ readme: string; skills: any[] }> {
    // README 走 raw（raw.githubusercontent.com 不受 api 的匿名 60/h 限流，CF 共享出口 IP 上也稳）：
    // 依次试各分支，第一个拿到的即用，与「列目录」解耦——列目录被限流也不影响 README 展示。
    let readme = "";
    for (const b of BRANCHES) {
        const t = await rawText(b, "README.md");
        if (t != null) { readme = t; break; }
    }

    // skill 列表需要列目录（api.github.com，CF 共享 IP 上可能被匿名限流）：失败则 skills 为空，但 README 仍在。
    // 一旦某次成功，结果会进 7 天兜底缓存，后续限流期间从兜底返回。
    let skills: any[] = [];
    const root = await listRoot(env);
    if (root) {
        const { branch, entries } = root;
        if (!readme) {
            const re = entries.find((e: any) => e.type === "file" && /^readme\.md$/i.test(e.name));
            if (re) readme = (await rawText(branch, re.name)) || "";
        }
        const dirs = entries.filter((e: any) => e.type === "dir");
        const briefs = await Promise.all(dirs.map(async (d: any) => {
            const txt = await rawText(branch, `${d.name}/brief.json`);
            if (!txt) return null;
            try { return pickBrief(JSON.parse(txt), d.name); } catch { return null; }
        }));
        skills = briefs.filter(Boolean);
    }
    return { readme, skills };
}

export const onRequestGet: PagesFunction<SkillEnv> = async (context) => {
    const { env } = context;
    const fresh = new URL(context.request.url).searchParams.get("fresh") === "1";

    // 1) 新鲜缓存命中（?fresh=1 跳过，便于部署后强制刷新验证）
    if (!fresh) {
        try {
            const cached = await env.TASKS.get(CACHE_KEY);
            if (cached) return json(JSON.parse(cached));
        } catch { /* ignore */ }
    }

    // 2) 实时构建
    try {
        const data = await buildIndex(env);
        const payload = JSON.stringify(data);
        context.waitUntil((async () => {
            try {
                await env.TASKS.put(CACHE_KEY, payload, { expirationTtl: CACHE_TTL });
                // 仅在拿到非空数据时刷新兜底，避免空态覆盖好数据
                if (data.skills.length || data.readme) {
                    await env.TASKS.put(BACKUP_KEY, payload, { expirationTtl: BACKUP_TTL });
                }
            } catch { /* ignore */ }
        })());
        return json(data);
    } catch { /* 落到兜底 */ }

    // 3) 兜底：长效缓存
    try {
        const backup = await env.TASKS.get(BACKUP_KEY);
        if (backup) return json(JSON.parse(backup));
    } catch { /* ignore */ }

    // 4) 实在没有 → 空态
    return json({ readme: "", skills: [] });
};
