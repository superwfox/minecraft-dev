// 上下文敏感枚举(bluemap §3.3)。给定起点针脚 → 产出相容候选 NodeDef 集。
// 「拖线松开搜索」与右键建节点共用;也是后续 AI「下一卡预测」的复用层。

import type { NodeDef, PinDef } from "./model";
import { allCuratedDefs, memberDefsForType, allMemberDefs, eventRootDefs } from "./registry";
import { isCompatible } from "./types";

export interface DragSource {
    pinKind: "exec" | "data";
    direction: "in" | "out"; // 起点针脚方向
    dataType?: string;
}

// 候选:能与起点针脚相容连接的节点(成员方法 + 接受/产出该类型的策展节点 + cast)
export function candidatesForPin(src: DragSource): NodeDef[] {
    const all = allCuratedDefs();

    if (src.pinKind === "exec") {
        // 从 exec-out 找有 exec-in 的;从 exec-in 找有 exec-out 的
        const wantDir = src.direction === "out" ? "in" : "out";
        return all.filter(d => d.pins.some(p => p.pinKind === "exec" && p.direction === wantDir));
    }

    const out: NodeDef[] = [];
    if (src.direction === "out") {
        // 拖一个值出来 → 找消费该类型的:data-in 相容
        for (const d of all) {
            if (d.pins.some(p => p.pinKind === "data" && p.direction === "in" && isCompatible(src.dataType, p.dataType))) out.push(d);
        }
        // 成员方法节点(self 接收该类型)
        for (const m of memberDefsForType(src.dataType || "")) out.push(m);
    } else {
        // 拖一个输入槽 → 找产出该类型的:data-out 相容
        for (const d of all) {
            if (d.pins.some(p => p.pinKind === "data" && p.direction === "out" && isCompatible(p.dataType, src.dataType))) out.push(d);
        }
    }
    return out;
}

// 在 def 上找第一个能与起点针脚连接的针脚 id(用于松手后自动接线)
export function matchPin(def: NodeDef, src: DragSource): string | null {
    const wantDir = src.direction === "out" ? "in" : "out";
    let best: PinDef | null = null;
    for (const p of def.pins) {
        if (p.pinKind !== src.pinKind || p.direction !== wantDir) continue;
        if (src.pinKind === "exec") return p.id;
        const ok = src.direction === "out"
            ? isCompatible(src.dataType, p.dataType)
            : isCompatible(p.dataType, src.dataType);
        if (ok) { best = p; break; }
    }
    return best ? best.id : null;
}

// 右键建节点:策展集(结构入口,置顶)+ jar 派生真实方法(搜索框过滤可达)。
// 无搜索词时弹层只取前若干条 → 策展在前;输入关键词即可搜到真实 Paper 方法。
export function allCreateCandidates(): NodeDef[] {
    // 顺序:策展入口 → jar 事件根(监听器入口)→ jar 真实方法。靠前者搜索更易命中。
    return [...allCuratedDefs(), ...eventRootDefs(), ...allMemberDefs()];
}
