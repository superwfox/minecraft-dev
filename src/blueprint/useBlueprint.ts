// 蓝图 reactive store(模块单例,沿用 useIDEChat/useIDEStore 范式)。
// 持有当前 doc / 图 / 选区,提供节点边增删改 + 防抖落盘。

import { reactive, computed } from "vue";
import type {
    BlueprintDoc, BlueprintGraph, GraphNode, GraphEdge,
    NodeDef, NodePos, Variable, GraphType, Viewport,
} from "./model";
import { newId } from "./model";
import { loadDoc, saveDoc } from "./persist";
import { resolveDef } from "./registry";
import { pinsCompatible } from "./types";
import { LITERAL_DEFAULTS } from "./curated";

const state = reactive<{
    taskId: string;
    doc: BlueprintDoc | null;
    currentGraphId: string;
    selection: string[];
    loaded: boolean;
}>({
    taskId: "",
    doc: null,
    currentGraphId: "",
    selection: [],
    loaded: false,
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

async function loadForTask(taskId: string) {
    state.loaded = false;
    state.taskId = taskId;
    const loaded = await loadDoc(taskId);
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
    // 成员节点把定义内联,保证 jar 未加载/重载仍能渲染
    if (def.special === "member") node.inlineDef = def;
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

function removeNode(id: string) {
    const g = currentGraph.value;
    if (!g) return;
    g.nodes = g.nodes.filter(n => n.id !== id);
    g.edges = g.edges.filter(e => e.from.node !== id && e.to.node !== id);
    state.selection = state.selection.filter(s => s !== id);
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
        createNode, createVarNode, removeNode, moveNode, setLiteral, defOf,
        connect, removeEdge, isPinConnected,
        addVariable, removeVariable,
        setViewport, setSelection,
    };
}
