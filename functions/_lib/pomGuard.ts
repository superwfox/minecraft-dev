// pom.xml 安全 scrub：上传给 GitHub 触发 Actions 前的最后一道闸。
// 防御目标：恶意 pom 在 Actions runner 内执行任意命令、写仓库、对外攻击。
//
// 策略：黑名单，不再用依赖白名单。只拦截明显危险的构建能力、危险仓库 URL，
// 以及不适合小型 Minecraft 插件生成的超大框架/库。
//
// 已知威胁向量与对应黑名单：
//   - <extensions> 加载任意类
//   - exec-maven-plugin / maven-antrun-plugin 等可执行任意命令的插件
//   - <repository> 指向本机、内网或云元数据地址
//   - <dependency> 引入脚本执行、原生调用、桌面浏览器、云大 SDK、大数据/AI/企业后端框架

const PLUGIN_BLACKLIST = [
    "exec-maven-plugin",
    "maven-antrun-plugin",
    "groovy-maven-plugin",
    "gmavenplus-plugin",
    "frontend-maven-plugin",
    "docker-maven-plugin",
    "jib-maven-plugin",
    "nar-maven-plugin",
    "native-maven-plugin",
];

const DEP_GROUP_BLACKLIST = [
    // 大型后端 / 容器框架：会把简单插件变成服务端应用，体量和构建风险都过高
    "org.springframework",
    "io.quarkus",
    "io.micronaut",
    "org.apache.tapestry",
    "com.vaadin",
    "org.apache.wicket",

    // 大数据 / 搜索 / 消息平台
    "org.apache.hadoop",
    "org.apache.spark",
    "org.apache.flink",
    "org.apache.storm",
    "org.elasticsearch",
    "org.opensearch",
    "org.apache.solr",
    "org.apache.kafka",

    // AI / 数值计算大包
    "org.tensorflow",
    "ai.djl",
    "org.deeplearning4j",
    "org.nd4j",

    // 云厂商大 SDK
    "software.amazon.awssdk",
    "com.amazonaws",
    "com.azure",
    "com.google.cloud",

    // 浏览器自动化 / 桌面 UI
    "org.seleniumhq.selenium",
    "com.microsoft.playwright",
    "org.openjfx",

    // 原生调用 / 进程执行 / 脚本运行时
    "net.java.dev.jna",
    "com.github.oshi",
    "org.zeroturnaround",
    "org.codehaus.groovy",
    "org.apache.groovy",
    "org.jruby",
    "org.python",
    "org.mozilla",
    "org.openjdk.nashorn",
];

const DEP_COORD_BLACKLIST = [
    "org.apache.commons:commons-exec",
    "commons-beanutils:commons-beanutils",
    "org.beanshell:bsh",
    "org.jline:jline-terminal-jna",
    "com.github.jnr:jnr-posix",
    "com.github.jnr:jnr-ffi",
    "com.github.jnr:jffi",
    "com.kenai.jffi:jffi",
];

const PRIVATE_HOST_RE = /^(localhost|metadata\.google\.internal)$/i;

export interface PomCheckResult { ok: boolean; reason?: string; }

function isBlacklistedGroup(groupId: string): boolean {
    return DEP_GROUP_BLACKLIST.some(g => groupId === g || groupId.startsWith(g + "."));
}

function isPrivateIp(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "");
    if (/^127\./.test(h) || /^10\./.test(h) || /^0\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    const m = h.match(/^172\.(\d+)\./);
    if (m) {
        const n = Number(m[1]);
        if (n >= 16 && n <= 31) return true;
    }
    return h === "::1" || h.toLowerCase().startsWith("fe80:");
}

function checkRepositoryUrl(rawUrl: string): PomCheckResult {
    let u: URL;
    try {
        u = new URL(rawUrl);
    } catch {
        return { ok: true };
    }
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
        return { ok: false, reason: `pom 仓库 URL 使用危险协议: ${protocol}` };
    }
    const host = u.hostname.toLowerCase();
    if (PRIVATE_HOST_RE.test(host) || isPrivateIp(host)) {
        return { ok: false, reason: `pom 仓库 URL 指向本机/内网地址: ${host}` };
    }
    return { ok: true };
}

export function checkPom(content: string): PomCheckResult {
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

    // 3. <repository> / <pluginRepository> 的 url 只拦危险地址，不做公网仓库白名单
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
            const r = checkRepositoryUrl(u);
            if (!r.ok) return r;
        }
    }

    // 4. <dependency> 黑名单：只拦截危险或超大依赖
    const deps = [...content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)];
    for (const m of deps) {
        const block = m[1];
        const gMatch = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/);
        const aMatch = block.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
        if (!gMatch) continue;
        const g = gMatch[1].trim();
        const a = aMatch?.[1]?.trim() || "";
        // 允许 ${...} 变量（一般是 project.groupId 引用，构建期 Maven 自己解析）
        if (g.startsWith("${")) continue;
        if (isBlacklistedGroup(g)) {
            return { ok: false, reason: `pom 禁止使用危险或超大依赖 groupId: ${g}` };
        }
        if (DEP_COORD_BLACKLIST.includes(`${g}:${a}`)) {
            return { ok: false, reason: `pom 禁止使用危险依赖: ${g}:${a}` };
        }
    }

    return { ok: true };
}

/**
 * 兼容旧调用：pomGuard 已切换为黑名单策略，不再需要从 skill 中放行依赖 groupId。
 */
export function extractSkillGroups(skills: any[]): string[] {
    void skills;
    return [];
}
