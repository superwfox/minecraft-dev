// 节点几何布局 —— 画布与连线层共用同一套常量,保证针脚锚点对齐。
// 所有坐标都在「图空间」(graph space),viewport 变换在最外层统一施加。

import type { NodeDef, PinDef, GraphNode, NodePos } from "./model";

export const NODE_W = 216;
export const HEADER_H = 34;
export const ROW_H = 26;
export const PAD_Y = 10;

export interface PinRow { pin: PinDef; y: number; }     // y 相对节点顶部
export interface NodeLayout {
    inputs: PinRow[];
    outputs: PinRow[];
    height: number;
}

function order(pins: PinDef[], dir: "in" | "out"): PinDef[] {
    return pins
        .filter(p => p.direction === dir)
        // exec 在前,data 在后
        .sort((a, b) => (a.pinKind === b.pinKind ? 0 : a.pinKind === "exec" ? -1 : 1));
}

export function layoutOf(def: NodeDef): NodeLayout {
    const ins = order(def.pins, "in");
    const outs = order(def.pins, "out");
    const rowY = (i: number) => HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2;
    const inputs: PinRow[] = ins.map((pin, i) => ({ pin, y: rowY(i) }));
    const outputs: PinRow[] = outs.map((pin, i) => ({ pin, y: rowY(i) }));
    const rows = Math.max(ins.length, outs.length, 1);
    const height = HEADER_H + PAD_Y * 2 + rows * ROW_H;
    return { inputs, outputs, height };
}

// 针脚锚点(图空间绝对坐标)
export function pinAnchor(node: GraphNode, def: NodeDef, pinId: string): NodePos | null {
    const lay = layoutOf(def);
    for (const r of lay.inputs) {
        if (r.pin.id === pinId) return { x: node.pos.x, y: node.pos.y + r.y };
    }
    for (const r of lay.outputs) {
        if (r.pin.id === pinId) return { x: node.pos.x + NODE_W, y: node.pos.y + r.y };
    }
    return null;
}

// 贝塞尔连线路径(水平外延控制点)
export function edgePath(a: NodePos, b: NodePos): string {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}
