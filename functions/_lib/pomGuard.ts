// pom.xml 安全 scrub：上传给 GitHub 触发 Actions 前的最后一道闸。
// 防御目标：恶意 pom 在 Actions runner 内执行任意命令、写仓库、对外攻击。
//
// 已知威胁向量与对应黑名单：
//   - <extensions> 加载任意类
//   - exec-maven-plugin / maven-antrun-plugin 等可执行任意命令的插件
//   - <repository> 指向攻击者控制的 Maven 仓库拉恶意依赖
//   - <dependency> groupId 不在常见 Paper 插件依赖范围内

const PLUGIN_BLACKLIST = [
    "exec-maven-plugin",
    "maven-antrun-plugin",
    "groovy-maven-plugin",
    "gmavenplus-plugin",
];

const REPO_HOST_WHITELIST = [
    "repo.maven.apache.org",
    "repo1.maven.org",
    "papermc.io",
    "repo.papermc.io",
    "hub.spigotmc.org",
    "oss.sonatype.org",
];

const DEP_GROUP_WHITELIST = [
    "io.papermc",
    "com.destroystokyo.paper",
    "org.spigotmc",
    "org.bukkit",
    "net.md-5",
    "org.apache.maven.plugins",
    "org.projectlombok",
    "com.google.code.gson",
    "com.google.guava",
    "org.yaml.snakeyaml",
    "mysql",
    "com.mysql",
    "com.h2database",
    "com.zaxxer",
    "org.xerial",
    "org.postgresql",
    "redis.clients",
    "org.jetbrains",
    "org.junit",
    "org.junit.jupiter",
    "junit",
    "org.mockito",
];

export interface PomCheckResult { ok: boolean; reason?: string; }

export function checkPom(content: string, extraGroups: string[] = []): PomCheckResult {
    // 1. 禁 extensions（任意类加载）
    if (/<extensions\b[^>]*>(?!\s*<\/extensions>)/i.test(content)) {
        return { ok: false, reason: "pom 不允许 <extensions> 元素" };
    }

    // 2. 禁高危插件（artifactId 命中即拒）
    for (const bad of PLUGIN_BLACKLIST) {
        const re = new RegExp(`<artifactId>\\s*${bad}\\s*</artifactId>`, "i");
        if (re.test(content)) {
            return { ok: false, reason: `pom 禁止使用插件 ${bad}` };
        }
    }

    // 3. <repository> / <pluginRepository> 的 url 必须在白名单
    //    只检测出现在 <repositories>/<pluginRepositories> 块内的 <url>，
    //    避免误伤 project / scm / organization 的 <url>。
    const repoBlocks = [
        ...content.matchAll(/<repositories\b[^>]*>([\s\S]*?)<\/repositories>/gi),
        ...content.matchAll(/<pluginRepositories\b[^>]*>([\s\S]*?)<\/pluginRepositories>/gi),
    ];
    for (const m of repoBlocks) {
        const body = m[1];
        const urls = [...body.matchAll(/<url>\s*([^<\s][^<]*?)\s*<\/url>/g)].map(u => u[1].trim());
        for (const u of urls) {
            let host = "";
            try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
            const ok = REPO_HOST_WHITELIST.some(w => host === w || host.endsWith("." + w));
            if (!ok) return { ok: false, reason: `pom 出现非白名单仓库 host: ${host}` };
        }
    }

    // 4. <dependency> groupId 白名单（基础白名单 ∪ 挂载 skill 声明的依赖）
    const allowGroups = [...DEP_GROUP_WHITELIST, ...extraGroups];
    const deps = [...content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)];
    for (const m of deps) {
        const block = m[1];
        const gMatch = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/);
        if (!gMatch) continue;
        const g = gMatch[1].trim();
        // 允许 ${...} 变量（一般是 project.groupId 引用，构建期 Maven 自己解析）
        if (g.startsWith("${")) continue;
        const ok = allowGroups.some(w => g === w || g.startsWith(w + "."));
        if (!ok) return { ok: false, reason: `pom 出现非白名单依赖 groupId: ${g}` };
    }

    return { ok: true };
}

/**
 * 从挂载的 skill bundle 提取它们在 md frontmatter 的 pom 里声明的依赖 groupId。
 * skill 经 PR 人工审批入库，其声明的依赖视为可信 → 该次构建放行（见 checkPom 的 extraGroups）。
 */
export function extractSkillGroups(skills: any[]): string[] {
    const groups = new Set<string>();
    for (const b of skills || []) {
        for (const f of b?.files || []) {
            const body = typeof f?.body === "string" ? f.body : "";
            for (const m of body.matchAll(/<groupId>\s*([^<\s$][^<]*?)\s*<\/groupId>/g)) {
                groups.add(m[1].trim());
            }
        }
    }
    return [...groups];
}
