// 蓝图 reactive store(模块单例,沿用 useIDEChat/useIDEStore 范式)。
// 持有当前 doc / 图 / 选区,提供节点边增删改 + 防抖落盘。

import { reactive, computed } from "vue";
import type {
    BlueprintDoc, BlueprintGraph, GraphNode, GraphEdge,
    NodeDef, PinDef, NodePos, Variable, GraphType, Viewport,
} from "./model";
import { newId } from "./model";
import { loadDoc, saveDoc } from "./persist";
import { resolveDef, curatedDef } from "./registry";
import { pinsCompatible } from "./types";
import { LITERAL_DEFAULTS } from "./curated";
import { autoLayout } from "./autolayout";
import type { ParseResult } from "./parse";

const state = reactive<{
    taskId: string;
    doc: BlueprintDoc | null;
    currentGraphId: string;
    selection: string[];
    loaded: boolean;
    fresh: boolean; // 尚无有意义的蓝图(仅默认空图)→ 可从已生成代码自动导入
}>({
    taskId: "",
    doc: null,
    currentGraphId: "",
    selection: [],
    loaded: false,
    fresh: false,
});

const currentGraph = computed<BlueprintGraph | null>(() =>
    state.doc?.graphs.find(g => g.id === state.currentGraphId) || null);
const variables = computed<Variable[]>(() => state.doc?.variables || []);

// ── 防抖落盘 ────────────────────────────────────────────────
let saveTimer: any = null;
function markDirty() {
    if (!state.doc) return;
    clearTimeout(saveTimer);
    const doc = state.doc;
    saveTimer = setTimeout(() => saveDoc(doc), 400);
}

function emptyDoc(taskId: string): BlueprintDoc {
    const g: BlueprintGraph = { id: newId(), name: "新建图", graphType: "event", nodes: [], edges: [] };
    return { taskId, graphs: [g], variables: [], viewport: { scale: 1, panX: 0, panY: 0 } };
}

// 仅默认空图(或全空)→ 视为「尚无蓝图」,允许从已生成代码自动导入
function isFreshDoc(d: BlueprintDoc | null): boolean {
    if (!d || !d.graphs?.length) return true;
    return d.graphs.length === 1 && d.graphs[0].nodes.length === 0;
}

async function loadForTask(taskId: string) {
    state.loaded = false;
    state.taskId = taskId;
    const loaded = await loadDoc(taskId);
    state.fresh = isFreshDoc(loaded);
    state.doc = loaded && loaded.graphs?.length ? loaded : emptyDoc(taskId);
    state.currentGraphId = state.doc.graphs[0].id;
    state.selection = [];
    state.loaded = true;
}

// ── 图 ──────────────────────────────────────────────────────
function addGraph(name: string, graphType: GraphType = "function"): string {
    if (!state.doc) return "";
    const g: BlueprintGraph = { id: newId(), name: name || "未命名图", graphType, nodes: [], edges: [] };
    state.doc.graphs.push(g);
    state.currentGraphId = g.id;
    state.selection = [];
    markDirty();
    return g.id;
}
function selectGraph(id: string) {
    state.currentGraphId = id;
    state.selection = [];
}
function removeGraph(id: string) {
    if (!state.doc || state.doc.graphs.length <= 1) return;
    state.doc.graphs = state.doc.graphs.filter(g => g.id !== id);
    if (state.currentGraphId === id) state.currentGraphId = state.doc.graphs[0].id;
    markDirty();
}
function renameGraph(id: string, name: string) {
    const g = state.doc?.graphs.find(x => x.id === id);
    if (g) { g.name = name || g.name; markDirty(); }
}

// ── 节点 ────────────────────────────────────────────────────
function pushNode(n: GraphNode) {
    currentGraph.value?.nodes.push(n);
    state.selection = [n.id];
    markDirty();
}

function createNode(def: NodeDef, pos: NodePos): GraphNode {
    const node: GraphNode = { id: newId(), defType: def.type, pos: { ...pos } };
    // 非策展定义(jar 成员节点 / 事件根等)把定义内联,保证 jar 未加载/重载仍能渲染
    if (!curatedDef(def.type)) node.inlineDef = def;
    const lit = LITERAL_DEFAULTS[def.type];
    if (lit) node.literals = { [lit.pin]: lit.value };
    pushNode(node);
    return node;
}

function createVarNode(varName: string, mode: "get" | "set", pos: NodePos): GraphNode {
    const node: GraphNode = {
        id: newId(),
        defType: mode === "get" ? "var:get" : "var:set",
        pos: { ...pos },
        varRef: { name: varName, mode },
    };
    pushNode(node);
    return node;
}

// 函数引用节点:把一张图折叠成单个节点。针脚 = exec + 图的输入(fn-in 声明)+ 输出(fn-out 声明)+ 图用到的变量
function buildGraphRefDef(graphId: string): NodeDef {
    const g = state.doc?.graphs.find(x => x.id === graphId);
    const label = g ? g.name : "函数(已删除)";
    const pins: PinDef[] = [
        { id: "exec", name: "▷", direction: "in", pinKind: "exec" },
        { id: "then", name: "▷", direction: "out", pinKind: "exec" },
    ];
    if (g) {
        for (const inp of g.inputs || []) pins.push({ id: `in:${inp.id}`, name: inp.name, direction: "in", pinKind: "data", dataType: inp.type });
        for (const out of g.outputs || []) pins.push({ id: `out:${out.id}`, name: out.name, direction: "out", pinKind: "data", dataType: out.type });
        const used = new Set<string>();
        for (const n of g.nodes) if (n.varRef) used.add(n.varRef.name);
        for (const vn of used) {
            const v = state.doc!.variables.find(x => x.name === vn);
            pins.push({ id: `var:${vn}`, name: `⚙ ${vn}`, direction: "in", pinKind: "data", dataType: v?.dataType || "Object" });
        }
    }
    return { type: `graphref:${graphId}`, category: "函数", label, kind: "impure", special: "function", desc: "调用图：" + label, pins };
}

// 函数入口/出口节点:针脚随当前图的 inputs/outputs 动态生成
function buildFnInDef(): NodeDef {
    const g = currentGraph.value;
    const pins: PinDef[] = [{ id: "then", name: "▷", direction: "out", pinKind: "exec" }];
    for (const inp of g?.inputs || []) pins.push({ id: `p:${inp.id}`, name: inp.name, direction: "out", pinKind: "data", dataType: inp.type });
    return { type: "fn:in", category: "流程", label: "函数入口", kind: "impure", special: "fn-in", desc: "函数参数", pins };
}
function buildFnOutDef(): NodeDef {
    const g = currentGraph.value;
    const pins: PinDef[] = [{ id: "exec", name: "▷", direction: "in", pinKind: "exec" }];
    for (const out of g?.outputs || []) pins.push({ id: `p:${out.id}`, name: out.name, direction: "in", pinKind: "data", dataType: out.type });
    return { type: "fn:out", category: "流程", label: "函数出口", kind: "impure", special: "fn-out", desc: "函数返回", pins };
}

// 图参数 / 返回 增删(由 fn-in / fn-out 节点驱动)
function addGraphInput(name: string, type: string) {
    const g = currentGraph.value; if (!g || !name) return;
    if (!g.inputs) g.inputs = [];
    g.inputs.push({ id: newId(), name, type: type || "Object" });
    markDirty();
}
function addGraphOutput(name: string, type: string) {
    const g = currentGraph.value; if (!g || !name) return;
    if (!g.outputs) g.outputs = [];
    g.outputs.push({ id: newId(), name, type: type || "Object" });
    markDirty();
}
function removeGraphInput(id: string) {
    const g = currentGraph.value; if (!g?.inputs) return;
    g.inputs = g.inputs.filter(p => p.id !== id);
    g.edges = g.edges.filter(e => e.from.pin !== `p:${id}` && e.to.pin !== `p:${id}`);
    markDirty();
}
function removeGraphOutput(id: string) {
    const g = currentGraph.value; if (!g?.outputs) return;
    g.outputs = g.outputs.filter(p => p.id !== id);
    g.edges = g.edges.filter(e => e.from.pin !== `p:${id}` && e.to.pin !== `p:${id}`);
    markDirty();
}

function createGraphRefNode(graphId: string, pos: NodePos): GraphNode {
    const node: GraphNode = { id: newId(), defType: `graphref:${graphId}`, graphRef: graphId, pos: { ...pos } };
    pushNode(node);
    return node;
}

// 把某张图整体复制进当前图(拖图复用):节点全换新 id、相对落点偏移、连线随之重映射
function instantiateGraph(srcId: string, at: NodePos) {
    const cur = currentGraph.value;
    const src = state.doc?.graphs.find(g => g.id === srcId);
    if (!cur || !src || !src.nodes.length) return;
    // 关键:用快照遍历。源图可能就是当前图(拖自己),否则边遍历边 push 同一数组会死循环
    const srcNodes = src.nodes.slice();
    const srcEdges = src.edges.slice();
    const minX = Math.min(...srcNodes.map(n => n.pos.x));
    const minY = Math.min(...srcNodes.map(n => n.pos.y));
    const idMap = new Map<string, string>();
    const newSel: string[] = [];
    for (const n of srcNodes) {
        const nid = newId();
        idMap.set(n.id, nid);
        cur.nodes.push({
            id: nid,
            defType: n.defType,
            pos: { x: Math.round(at.x + (n.pos.x - minX)), y: Math.round(at.y + (n.pos.y - minY)) },
            literals: n.literals ? { ...n.literals } : undefined,
            varRef: n.varRef ? { ...n.varRef } : undefined,
            inlineDef: n.inlineDef,
            title: n.title,
        });
        newSel.push(nid);
    }
    for (const e of srcEdges) {
        const fn = idMap.get(e.from.node), tn = idMap.get(e.to.node);
        if (!fn || !tn) continue;
        cur.edges.push({ id: newId(), from: { node: fn, pin: e.from.pin }, to: { node: tn, pin: e.to.pin }, pinKind: e.pinKind });
    }
    state.selection = newSel;
    markDirty();
}

// 码→图:把解析结果导入当前 doc(追加图、合并变量、对每张新图首次自动布局)
function importParsed(res: ParseResult): { added: number; warnings: number } {
    if (!state.doc || !res.graphs.length) return { added: 0, warnings: 0 };
    // 合并变量(按名去重,已存在的不覆盖)
    for (const v of res.variables) {
        if (!state.doc.variables.some(x => x.name === v.name)) state.doc.variables.push(v);
    }
    for (const g of res.graphs) state.doc.graphs.push(g); // 先全部入库,函数引用节点才能解析到目标图
    for (const g of res.graphs) {
        state.currentGraphId = g.id; // 让 defOf 的 fn:in/out 按本图(而非首图)解析针脚
        autoLayout(g, defOf);
    }
    state.currentGraphId = res.graphs[0].id;
    state.selection = [];
    markDirty();
    return { added: res.graphs.length, warnings: res.warnings.length };
}

// 从已生成代码的解析结果重建蓝图(替换默认空图);仅在 fresh 时由视图调用
function replaceWithParsed(res: ParseResult): { added: number; warnings: number } {
    if (!state.doc || !res.graphs.length) return { added: 0, warnings: res.warnings.length };
    state.doc.graphs = [];
    state.doc.variables = [];
    const r = importParsed(res);
    state.fresh = false;
    return r;
}

function removeNode(id: string) {
    const g = currentGraph.value;
    if (!g) return;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.edges = g.edges.filter(e => e.from.node !== id && e.to.node !== id);
    state.selection = state.selection.filter(s => s !== id);
    markDirty();
}

// 复制选中节点 + 其内部连线(供 Ctrl/Cmd C-V)
function copyNodes(ids: string[]): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
    const g = currentGraph.value;
    if (!g || !ids.length) return null;
    const set = new Set(ids);
    const nodes = g.nodes.filter(n => set.has(n.id)).map(n => JSON.parse(JSON.stringify(n)));
    const edges = g.edges.filter(e => set.has(e.from.node) && set.has(e.to.node)).map(e => JSON.parse(JSON.stringify(e)));
    return { nodes, edges };
}
function pasteNodes(payload: { nodes: GraphNode[]; edges: GraphEdge[] } | null, at: NodePos) {
    const g = currentGraph.value;
    if (!g || !payload?.nodes?.length) return;
    const minX = Math.min(...payload.nodes.map(n => n.pos.x));
    const minY = Math.min(...payload.nodes.map(n => n.pos.y));
    const idMap = new Map<string, string>();
    const newSel: string[] = [];
    for (const n of payload.nodes) {
        const nid = newId();
        idMap.set(n.id, nid);
        const copy: GraphNode = JSON.parse(JSON.stringify(n));
        copy.id = nid;
        copy.pos = { x: Math.round(at.x + (n.pos.x - minX)), y: Math.round(at.y + (n.pos.y - minY)) };
        g.nodes.push(copy);
        newSel.push(nid);
    }
    for (const e of payload.edges) {
        const fn = idMap.get(e.from.node), tn = idMap.get(e.to.node);
        if (!fn || !tn) continue;
        g.edges.push({ id: newId(), from: { node: fn, pin: e.from.pin }, to: { node: tn, pin: e.to.pin }, pinKind: e.pinKind });
    }
    state.selection = newSel;
    markDirty();
}

function moveNode(id: string, pos: NodePos) {
    const n = currentGraph.value?.nodes.find(x => x.id === id);
    if (n) { n.pos = { ...pos }; markDirty(); }
}

function setLiteral(nodeId: string, pinId: string, value: string) {
    const n = currentGraph.value?.nodes.find(x => x.id === nodeId);
    if (!n) return;
    if (!n.literals) n.literals = {};
    n.literals[pinId] = value;
    markDirty();
}

function defOf(node: GraphNode): NodeDef {
    if (node.defType === "fn:in") return buildFnInDef();
    if (node.defType === "fn:out") return buildFnOutDef();
    if (node.graphRef) return buildGraphRefDef(node.graphRef);
    return resolveDef(node, variables.value);
}

// ── 边(带类型校验,bluemap §2.3)──────────────────────────────
function findPin(node: GraphNode, pinId: string) {
    return defOf(node).pins.find(p => p.id === pinId) || null;
}

// 返回 true=成功连接;false=不相容拒绝
function connect(aNode: string, aPin: string, bNode: string, bPin: string): boolean {
    const g = currentGraph.value;
    if (!g || aNode === bNode) return false;
    const na = g.nodes.find(n => n.id === aNode);
    const nb = g.nodes.find(n => n.id === bNode);
    if (!na || !nb) return false;
    const pa = findPin(na, aPin);
    const pb = findPin(nb, bPin);
    if (!pa || !pb) return false;
    if (!pinsCompatible(pa, pb)) return false;

    const outEnd = pa.direction === "out" ? { node: aNode, pin: aPin } : { node: bNode, pin: bPin };
    const inEnd = pa.direction === "out" ? { node: bNode, pin: bPin } : { node: aNode, pin: aPin };
    const kind = pa.pinKind;

    // 单连约束:exec-out 仅一条出;data-in 仅一条入
    if (kind === "exec") {
        g.edges = g.edges.filter(e => !(e.from.node === outEnd.node && e.from.pin === outEnd.pin));
    } else {
        g.edges = g.edges.filter(e => !(e.to.node === inEnd.node && e.to.pin === inEnd.pin));
    }
    // 去重
    if (g.edges.some(e => e.from.node === outEnd.node && e.from.pin === outEnd.pin && e.to.node === inEnd.node && e.to.pin === inEnd.pin)) {
        return true;
    }
    const edge: GraphEdge = { id: newId(), from: outEnd, to: inEnd, pinKind: kind };
    g.edges.push(edge);
    markDirty();
    return true;
}

function removeEdge(id: string) {
    const g = currentGraph.value;
    if (!g) return;
    g.edges = g.edges.filter(e => e.id !== id);
    markDirty();
}

// 该输入针脚是否已被占用(决定是否显示字面量框)
function isPinConnected(nodeId: string, pinId: string, dir: "in" | "out"): boolean {
    const g = currentGraph.value;
    if (!g) return false;
    return dir === "in"
        ? g.edges.some(e => e.to.node === nodeId && e.to.pin === pinId)
        : g.edges.some(e => e.from.node === nodeId && e.from.pin === pinId);
}

// ── 变量 ────────────────────────────────────────────────────
function addVariable(name: string, dataType: string, scope: Variable["scope"] = "field"): boolean {
    if (!state.doc || !name) return false;
    if (state.doc.variables.some(v => v.name === name)) return false;
    state.doc.variables.push({ name, dataType: dataType || "Object", scope });
    markDirty();
    return true;
}
function removeVariable(name: string) {
    if (!state.doc) return;
    state.doc.variables = state.doc.variables.filter(v => v.name !== name);
    markDirty();
}

// ── 视图 ────────────────────────────────────────────────────
function setViewport(v: Viewport) {
    if (state.doc) { state.doc.viewport = { ...v }; markDirty(); }
}

function setSelection(ids: string[]) { state.selection = ids; }

export function useBlueprint() {
    return {
        state, currentGraph, variables,
        loadForTask,
        addGraph, selectGraph, removeGraph, renameGraph, instantiateGraph,
        createNode, createVarNode, createGraphRefNode, removeNode, moveNode, setLiteral, defOf,
        connect, removeEdge, isPinConnected,
        addVariable, removeVariable,
        addGraphInput, addGraphOutput, removeGraphInput, removeGraphOutput,
        copyNodes, pasteNodes, importParsed, replaceWithParsed,
        setViewport, setSelection,
    };
}
