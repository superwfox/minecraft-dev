// GET /api/skills —— 公开只读：实时拉社区 skill 仓库（superwfox/TAHAI-Skills）的
// 顶层 README + 各子目录 brief.json，聚合成 { readme, skills[] }。
//
// 中间件（functions/api/_middleware.ts）只对 /api/generate/、/api/chat、/api/stream
// 强制登录+限流，所以本端点天然公开只读，无需鉴权。
//
// 防 GitHub 匿名限流（60/h）：
//   - 列目录走 api.github.com（仅 1 次），README/brief.json 走 raw.githubusercontent.com（不计 api 限额）。
//   - KV(TASKS) 缓存 10 分钟；另存 7 天「兜底」缓存。GitHub 失败/仓库不存在 → 回退兜底或空态，始终 200。

interface Env {
    TASKS: KVNamespace;
    GITHUB_TOKEN?: string;
}

const REPO = "superwfox/TAHAI-Skills";
const BRANCHES = ["master", "main"];     // README 写的是 master，404 回退 main
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

function ghHeaders(env: Env): Record<string, string> {
    const h: Record<string, string> = {
        "User-Agent": "tahai-skills",      // api.github.com 要求 UA，否则 403
        "Accept": "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    return h;
}

// 取首个可用分支的顶层目录列表
async function listRoot(env: Env): Promise<{ branch: string; entries: any[] } | null> {
    for (const branch of BRANCHES) {
        try {
            const r = await fetch(`https://api.github.com/repos/${REPO}/contents?ref=${branch}`, { headers: ghHeaders(env) });
            if (r.ok) {
                const entries = await r.json();
                if (Array.isArray(entries)) return { branch, entries };
            }
        } catch { /* 试下一个分支 */ }
    }
    return null;
}

async function rawText(branch: string, path: string): Promise<string | null> {
    try {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${branch}/${path}`);
        return r.ok ? await r.text() : null;
    } catch { return null; }
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

async function buildIndex(env: Env): Promise<{ readme: string; skills: any[] }> {
    const root = await listRoot(env);
    if (!root) return { readme: "", skills: [] };
    const { branch, entries } = root;

    const readmeEntry = entries.find((e: any) => e.type === "file" && /^readme\.md$/i.test(e.name));
    const readmeP = readmeEntry ? rawText(branch, readmeEntry.name) : Promise.resolve(null);

    const dirs = entries.filter((e: any) => e.type === "dir");
    const briefPs = dirs.map(async (d: any) => {
        const txt = await rawText(branch, `${d.name}/brief.json`);
        if (!txt) return null;
        try { return pickBrief(JSON.parse(txt), d.name); } catch { return null; }
    });

    const [readme, briefs] = await Promise.all([readmeP, Promise.all(briefPs)]);
    return { readme: readme || "", skills: briefs.filter(Boolean) };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { env } = context;

    // 1) 新鲜缓存命中
    try {
        const cached = await env.TASKS.get(CACHE_KEY);
        if (cached) return json(JSON.parse(cached));
    } catch { /* ignore */ }

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
