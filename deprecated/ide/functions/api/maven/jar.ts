// Cloudflare Pages Function: 代理 Maven 仓库的 JAR / metadata 请求
// 浏览器无法直接拉 Maven 仓库（CORS 没开），用这个 Worker 桥接。
// 同时处理 SNAPSHOT 版本的 maven-metadata.xml 解析。
//
// 请求：
//   GET /api/maven/jar?coords=<groupId>:<artifactId>:<version>&kind=jar|metadata
//   - kind=jar 默认，返回 JAR 二进制
//   - kind=metadata 返回 maven-metadata.xml 文本
//
// 仅允许白名单仓库，防止滥用 worker 做任意 GET。

interface Env {}

const REPOS = [
    {host: "https://repo.papermc.io/repository/maven-public", match: ["io.papermc.paper", "io.papermc", "com.destroystokyo.paper"]},
    {host: "https://hub.spigotmc.org/nexus/content/repositories/snapshots", match: ["org.spigotmc", "org.bukkit"]},
    {host: "https://repo1.maven.org/maven2", match: []}, // fallback
];

function pickRepo(groupId: string): string {
    for (const r of REPOS) {
        if (r.match.some(p => groupId === p || groupId.startsWith(p + "."))) return r.host;
    }
    return REPOS[REPOS.length - 1].host;
}

function groupPath(groupId: string): string {
    return groupId.replace(/\./g, "/");
}

async function resolveSnapshot(baseUrl: string, artifactId: string, version: string): Promise<string | null> {
    const metaUrl = `${baseUrl}/${artifactId}/${version}/maven-metadata.xml`;
    const r = await fetch(metaUrl);
    if (!r.ok) return null;
    const xml = await r.text();
    const ts = xml.match(/<timestamp>([^<]+)<\/timestamp>/)?.[1];
    const bn = xml.match(/<buildNumber>([^<]+)<\/buildNumber>/)?.[1];
    if (!ts || !bn) return null;
    const realVer = version.replace(/-SNAPSHOT$/, `-${ts}-${bn}`);
    return `${baseUrl}/${artifactId}/${version}/${artifactId}-${realVer}.jar`;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const coords = url.searchParams.get("coords") || "";
    const kind = url.searchParams.get("kind") || "jar";

    const m = coords.match(/^([^:]+):([^:]+):([^:]+)$/);
    if (!m) return new Response("Bad coords. Expect group:artifact:version", {status: 400});
    const [, groupId, artifactId, version] = m;

    const repo = pickRepo(groupId);
    const base = `${repo}/${groupPath(groupId)}`;

    let target: string;

    if (kind === "metadata") {
        target = `${base}/${artifactId}/${version}/maven-metadata.xml`;
    } else if (version.endsWith("-SNAPSHOT")) {
        const real = await resolveSnapshot(base, artifactId, version);
        if (!real) {
            return new Response(`Cannot resolve snapshot ${coords}`, {status: 404});
        }
        target = real;
    } else {
        target = `${base}/${artifactId}/${version}/${artifactId}-${version}.jar`;
    }

    const upstream = await fetch(target, {cf: {cacheTtl: 21600, cacheEverything: true}} as any);
    if (!upstream.ok) {
        return new Response(`Upstream ${upstream.status} for ${target}`, {status: upstream.status});
    }

    const ct = kind === "metadata" ? "application/xml" : "application/java-archive";
    const headers = new Headers({
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Resolved-Url": target,
    });
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);

    return new Response(upstream.body, {headers});
};
