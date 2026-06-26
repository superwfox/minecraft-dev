// 导入代码时的首次自动布局(bluemap §2.5:仅导入/手动整理时摆放,渲染不重算)。
// 按 exec 链分列(从入口向右),纯数据源节点落到消费者左侧;同列纵向堆叠。

import type { BlueprintGraph, GraphNode, NodeDef } from "./model";
import { layoutOf, NODE_W } from "./layout";

const COL_GAP = 96;
const ROW_GAP = 28;

export function autoLayout(graph: BlueprintGraph, defOf: (n: GraphNode) => NodeDef) {
    const nodes = graph.nodes;
    if (!nodes.length) return;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const col = new Map<string, number>();

    // 入口(无 exec 入边的 impure 节点)起列 0;沿 exec 边向右推进
    const hasExecIn = new Set(graph.edges.filter(e => e.pinKind === "exec").map(e => e.to.node));
    const roots = nodes.filter(n => !hasExecIn.has(n.id) && graph.edges.some(e => e.pinKind === "exec" && e.from.node === n.id));
    const queue: string[] = [];
    for (const r of (roots.length ? roots : nodes.slice(0, 1))) { col.set(r.id, 0); queue.push(r.id); }
    while (queue.length) {
        const id = queue.shift()!;
        const c = col.get(id)!;
        for (const e of graph.edges) {
            if (e.pinKind !== "exec" || e.from.node !== id) continue;
            const cur = col.get(e.to.node);
            if (cur == null || cur < c + 1) { col.set(e.to.node, c + 1); queue.push(e.to.node); }
        }
    }

    // 纯数据源:落到其数据消费者左侧(多轮松弛)
    for (let pass = 0; pass < 6; pass++) {
        for (const e of graph.edges) {
            if (e.pinKind !== "data") continue;
            const to = col.get(e.to.node);
            if (to == null) continue;
            const cur = col.get(e.from.node);
            if (cur == null || cur >= to) col.set(e.from.node, to - 1);
        }
    }
    for (const n of nodes) if (!col.has(n.id)) col.set(n.id, 0);

    // 归一化到非负,按列堆叠
    const minCol = Math.min(...[...col.values()]);
    const colNodes = new Map<number, GraphNode[]>();
    for (const n of nodes) {
        const c = col.get(n.id)! - minCol;
        col.set(n.id, c);
        (colNodes.get(c) || colNodes.set(c, []).get(c)!).push(n);
    }

    const colX: number[] = [];
    let x = 40;
    const maxCol = Math.max(...[...colNodes.keys()]);
    for (let c = 0; c <= maxCol; c++) {
        colX[c] = x;
        x += NODE_W + COL_GAP;
    }
    for (const [c, list] of colNodes) {
        let y = 40;
        for (const n of list) {
            n.pos = { x: colX[c], y };
            y += layoutOf(defOf(n)).height + ROW_GAP;
        }
    }
}
