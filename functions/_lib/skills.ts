// 社区 skill 仓库（superwfox/TAHAI-Skills）拉取核心 + skill bundle（含各 md 正文）。
// 被 /api/skills（列表/README 展示）与生成流水线（plan.ts 注入）共用。
//
// 防 GitHub 匿名限流：列目录走 api.github.com（少量），README/brief/md 正文走
// raw.githubusercontent.com（不计 api 限额）；bundle 结果再各自 KV 缓存。

export const REPO = "superwfox/TAHAI-Skills";
export const BRANCHES = ["main", "master"];   // 仓库默认分支为 main，优先 main，master 兜底

export interface SkillEnv {
    TASKS: KVNamespace;
    GITHUB_TOKEN?: string;
}

export function ghHeaders(env: { GITHUB_TOKEN?: string }): Record<string, string> {
    const h: Record<string, string> = {
        "User-Agent": "tahai-skills",       // api.github.com 要求 UA，否则 403
        "Accept": "application/vnd.github+json",
    };
    if (env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    return h;
}

/** 取首个可用分支的顶层目录列表 */
export async function listRoot(env: { GITHUB_TOKEN?: string }): Promise<{ branch: string; entries: any[] } | null> {
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

export async function rawText(branch: string, path: string): Promise<string | null> {
    try {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${branch}/${path}`);
        return r.ok ? await r.text() : null;
    } catch { return null; }
}

// ─── skill bundle（注入用：每个 skill 的 brief 摘要 + 所有 md 正文）───

export interface SkillBundleFile {
    file: string;
    kind: "gen" | "ref";
    fileGen?: string;
    role?: string;
    depends?: string[];
    body: string;            // md 原文（frontmatter + 正文骨架）
}

export interface SkillBundle {
    id: string;
    name: string;
    capability?: string;
    expectedGlobals?: Record<string, string>;
    files: SkillBundleFile[];
    usage?: string;          // 根目录 usage.md：整体怎么用（教学）
    deny?: string;           // 根目录 deny.md：什么绝对不准做（禁忌）
}

const BUNDLE_TTL = 1800;     // 30 分钟

async function fetchOneBundle(id: string): Promise<SkillBundle | null> {
    // 先确定哪个分支有该 skill 的 brief.json
    let briefTxt: string | null = null;
    let branch = "";
    for (const b of BRANCHES) {
        const t = await rawText(b, `${id}/brief.json`);
        if (t) { briefTxt = t; branch = b; break; }
    }
    if (!briefTxt) return null;

    let brief: any;
    try { brief = JSON.parse(briefTxt); } catch { return null; }

    const structure: any[] = Array.isArray(brief.structure) ? brief.structure : [];
    const files = (await Promise.all(structure.map(async (s) => {
        if (!s?.file) return null;
        const body = await rawText(branch, `${id}/${s.file}`);
        if (body == null) return null;
        const f: SkillBundleFile = { file: s.file, kind: s.kind === "gen" ? "gen" : "ref", body };
        if (s.fileGen) f.fileGen = s.fileGen;
        if (s.role) f.role = s.role;
        if (Array.isArray(s.depends)) f.depends = s.depends;
        return f;
    }))).filter((x): x is SkillBundleFile => !!x);

    // 根目录可选的教学 / 禁忌文件（不在 structure 里，单独拉）
    const [usage, deny] = await Promise.all([
        rawText(branch, `${id}/usage.md`),
        rawText(branch, `${id}/deny.md`),
    ]);

    return {
        id: brief.id || id,
        name: brief.name || id,
        capability: brief.capability,
        expectedGlobals: brief.expectedGlobals,
        files,
        usage: usage ?? undefined,
        deny: deny ?? undefined,
    };
}

/**
 * 按 id 拉取 skill bundle（含各 md 正文），用于注入生成上下文。
 * 每个 id 先查 KV `skillbundle:<id>`，miss 才拉 GitHub 并回写缓存。
 * 找不到 / 拉取失败的 id 跳过（不抛错）。
 */
export async function getSkillBundles(env: SkillEnv, ids: string[]): Promise<SkillBundle[]> {
    const out: SkillBundle[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (!id || typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);

        let bundle: SkillBundle | null = null;
        try {
            const cached = await env.TASKS.get(`skillbundle:${id}`);
            if (cached) bundle = JSON.parse(cached);
        } catch { /* ignore */ }

        if (!bundle) {
            bundle = await fetchOneBundle(id);
            if (bundle) {
                try { await env.TASKS.put(`skillbundle:${id}`, JSON.stringify(bundle), { expirationTtl: BUNDLE_TTL }); } catch { /* ignore */ }
            }
        }
        if (bundle) out.push(bundle);
    }
    return out;
}
