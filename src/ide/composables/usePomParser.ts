export type PomDep = {
    groupId: string;
    artifactId: string;
    version: string;
    scope?: string;
};

// 我们只把这些 groupId 当作"值得拉补全"的 API JAR，其他依赖（Guava、Apache Commons 等）暂不处理
const COMPLETION_GROUPS = [
    "io.papermc.paper",
    "io.papermc",
    "com.destroystokyo.paper",
    "org.spigotmc",
    "org.bukkit",
];

function isCompletionTarget(d: PomDep): boolean {
    if (d.scope === "test") return false;
    return COMPLETION_GROUPS.some(g => d.groupId === g || d.groupId.startsWith(g + "."));
}

function resolveProperty(value: string, props: Map<string, string>): string {
    let out = value;
    let safety = 5;
    while (safety-- > 0 && /\$\{([^}]+)\}/.test(out)) {
        out = out.replace(/\$\{([^}]+)\}/g, (_, k) => props.get(k) ?? "");
    }
    return out.trim();
}

export function parsePom(xmlText: string): PomDep[] {
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(xmlText, "application/xml");
        if (doc.getElementsByTagName("parsererror").length) return [];
    } catch { return []; }

    // 收集 properties
    const props = new Map<string, string>();
    const propsNode = doc.querySelector("project > properties");
    if (propsNode) {
        for (const ch of Array.from(propsNode.children)) {
            props.set(ch.tagName, (ch.textContent || "").trim());
        }
    }

    const deps: PomDep[] = [];
    const seen = new Set<string>();
    const nodes = doc.querySelectorAll("project > dependencies > dependency, project > dependencyManagement > dependencies > dependency");
    for (const n of Array.from(nodes)) {
        const g = resolveProperty(n.querySelector(":scope > groupId")?.textContent || "", props);
        const a = resolveProperty(n.querySelector(":scope > artifactId")?.textContent || "", props);
        const v = resolveProperty(n.querySelector(":scope > version")?.textContent || "", props);
        const s = (n.querySelector(":scope > scope")?.textContent || "").trim();
        if (!g || !a || !v) continue;
        const key = `${g}:${a}:${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deps.push({groupId: g, artifactId: a, version: v, scope: s || undefined});
    }
    return deps;
}

export function filterDepsForCompletion(deps: PomDep[]): PomDep[] {
    return deps.filter(isCompletionTarget);
}
