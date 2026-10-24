// 稳定节点身份(bluemap §2.2):由「结构/内容指纹」派生,不依赖坐标/创建顺序/显示名。
// 同一段逻辑无论被重解析多少次,未变部分指纹不变 —— 用于重解析时的布局保全与 diff。
//
// 算法:从入口沿 exec 链 + data 来源做确定性 DFS,给每个节点一条由"内容键路径"组成的地址;
// 指纹 = 图键 + 地址哈希。对值改动(字面量/参数变更)与同级重排稳定;链中插入会使下游地址变,
// 下游节点重新布局(best-effort,符合规范"尽量保全")。

import type { BlueprintGraph, GraphNode } from "./model";

function hashStr(s: string): string {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
}

// 节点内容键:决定"是不是同一种节点",刻意排除字面量取值(取值可变而身份不变)
function contentKey(n: GraphNode): string {
    if (n.varRef) return `var:${n.varRef.mode}:${n.varRef.name}`;
    if (n.graphRef) return `gr:${n.graphRef}`;
    return n.defType;
}

const isEntry = (dt?: string) => !!dt && (dt.startsWith("event") || dt.startsWith("life.") || dt === "fn:in");

// 图身份:由入口决定(事件类型 / 生命周期 / 函数名),与节点布局解耦
export function graphKey(g: BlueprintGraph): string {
    const entry = g.nodes.find(n => isEntry(n.defType));
    let k = g.graphType + "|";
    if (entry) {
        if (entry.defType.startsWith("event")) k += "event:" + (entry.inlineDef?.desc || entry.defType);
        else if (entry.defType.startsWith("life.")) k += entry.defType;
        else k += "fn:" + g.name;
    } else k += "name:" + g.name;
    return hashStr(k);
}

export function assignFingerprints(g: BlueprintGraph): void {
    g.fp = graphKey(g);

    const nodes = new Map(g.nodes.map(n => [n.id, n]));
    const execOut = new Map<string, { pin: string; to: string }[]>();
    const dataIn = new Map<string, { pin: string; from: string }[]>();
    const hasExecIn = new Set<string>();
    for (const e of g.edges) {
        if (e.pinKind === "exec") {
            (execOut.get(e.from.node) ?? execOut.set(e.from.node, []).get(e.from.node)!).push({ pin: e.from.pin, to: e.to.node });
            hasExecIn.add(e.to.node);
        } else {
            (dataIn.get(e.to.node) ?? dataIn.set(e.to.node, []).get(e.to.node)!).push({ pin: e.to.pin, from: e.from.node });
        }
    }

    const visited = new Set<string>();
    const sortByPin = <T extends { pin: string }>(a: T[]) => a.slice().sort((x, y) => x.pin < y.pin ? -1 : x.pin > y.pin ? 1 : 0);

    function dfs(id: string, addr: string) {
        if (visited.has(id)) return;
        visited.add(id);
        const n = nodes.get(id); if (!n) return;
        n.fp = g.fp + ":" + hashStr(addr);
        // 先 data 来源(纯值节点挂到消费者地址下),再 exec 子节点
        for (const d of sortByPin(dataIn.get(id) ?? [])) {
            const src = nodes.get(d.from); if (!src) continue;
            dfs(d.from, `${addr}|d.${d.pin}.${contentKey(src)}`);
        }
        for (const x of sortByPin(execOut.get(id) ?? [])) {
            const tgt = nodes.get(x.to); if (!tgt) continue;
            dfs(x.to, `${addr}|e.${x.pin}.${contentKey(tgt)}`);
        }
    }

    // 根:入口节点 或 有 exec 出边且无 exec 入边的节点(确定性按内容键排序)
    const roots = g.nodes
        .filter(n => isEntry(n.defType) || (execOut.has(n.id) && !hasExecIn.has(n.id)))
        .sort((a, b) => contentKey(a) < contentKey(b) ? -1 : 1);
    for (const r of roots) dfs(r.id, "R." + contentKey(r));

    // 未被结构触达的孤立节点:按内容键 + 序号兜底
    let oi = 0;
    for (const n of g.nodes) if (!visited.has(n.id)) n.fp = `${g.fp}:o:${hashStr(contentKey(n) + "#" + oi++)}`;
}
