<template>
  <div ref="canvasEl" class="bp-canvas" :class="{panning: spaceDown}" :style="gridStyle"
       @mousedown="onCanvasDown" @wheel.prevent="onWheel"
       @contextmenu.prevent="onContextMenu" @dragover.prevent @drop="onDrop">
    <div class="bp-viewport" :style="vpStyle">
      <BlueprintEdges :temp="tempEdge"/>
      <div v-if="selBox.visible" class="bp-selbox"
           :style="{left: selBox.x + 'px', top: selBox.y + 'px', width: selBox.w + 'px', height: selBox.h + 'px'}"></div>
      <BlueprintNode v-for="n in nodes" :key="n.id"
                     :node="n" :def="bp.defOf(n)" :selected="sel.has(n.id)"
                     :connecting-pin="connectingPin" :connecting-node-id="connectingPin ? connectSrc.nodeId : ''"
                     @pindown="onPinDown" @pinup="onPinUp"
                     @headdown="onHeadDown" @bodydown="onBodyDown" @remove="bp.removeNode"/>
    </div>

    <div v-if="!nodes.length" class="bp-hint">右键新建节点 · 左侧拖入节点/变量 · 空白拖拽框选 · 按住空格拖拽平移</div>
    <Transition name="toast"><div v-if="toast.visible" class="bp-toast">{{ toast.msg }}</div></Transition>

    <NodeSearchPopup :visible="search.visible" :x="search.x" :y="search.y"
                     :candidates="search.candidates" :all-candidates="search.allCandidates" :title="search.title"
                     @select="onSearchSelect" @cancel="closePopups"/>
    <VarChoicePopup :visible="varPop.visible" :x="varPop.x" :y="varPop.y" :var-name="varPop.varName"
                    @choose="onVarChoose" @cancel="closePopups"/>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import type { NodeDef, NodePos, PinDef } from "../model";
import { useBlueprint } from "../useBlueprint";
import { pinAnchor, layoutOf, NODE_W } from "../layout";
import { typeColor, EXEC_COLOR } from "../colors";
import { candidatesForPin, allCreateCandidates, matchPin, type DragSource } from "../enumerate";
import { curatedDef } from "../registry";
import BlueprintNode from "./BlueprintNode.vue";
import BlueprintEdges from "./BlueprintEdges.vue";
import NodeSearchPopup from "./NodeSearchPopup.vue";
import VarChoicePopup from "./VarChoicePopup.vue";

const bp = useBlueprint();
const canvasEl = ref<HTMLElement | null>(null);

const panX = ref(0), panY = ref(0), scale = ref(1);
const nodes = computed(() => bp.currentGraph.value?.nodes || []);
const sel = computed(() => new Set(bp.state.selection));

// 载入图后同步 viewport
watch(() => bp.state.loaded, (v) => { if (v) syncViewport(); }, { immediate: true });
watch(() => bp.state.currentGraphId, () => syncViewport());
function syncViewport() {
    const vp = bp.state.doc?.viewport;
    if (vp) { panX.value = vp.panX; panY.value = vp.panY; scale.value = vp.scale || 1; }
}

const vpStyle = computed(() => ({
    transform: `translate(${panX.value}px, ${panY.value}px) scale(${scale.value})`,
    transformOrigin: "0 0",
}));
const gridStyle = computed(() => {
    const s = 26 * scale.value;
    return {
        backgroundSize: `${s}px ${s}px, ${s}px ${s}px`,
        backgroundPosition: `${panX.value}px ${panY.value}px, ${panX.value}px ${panY.value}px`,
    };
});

// ── 坐标换算 ─────────────────────────────────────────────────
function rect() { return canvasEl.value!.getBoundingClientRect(); }
function toGraph(clientX: number, clientY: number): NodePos {
    const r = rect();
    return { x: (clientX - r.left - panX.value) / scale.value, y: (clientY - r.top - panY.value) / scale.value };
}
function toLocal(clientX: number, clientY: number) {
    const r = rect();
    return { x: clientX - r.left, y: clientY - r.top };
}

// ── 手势状态机 ───────────────────────────────────────────────
type Mode = "idle" | "pan" | "move" | "connect" | "select";
const mode = ref<Mode>("idle");
const spaceDown = ref(false); // 按住空格 → 拖拽平移;否则空白拖拽 = 框选
const selBox = reactive({ visible: false, x: 0, y: 0, w: 0, h: 0 }); // 框选矩形(图空间)
let selStart: NodePos = { x: 0, y: 0 };
let panStart = { x: 0, y: 0, px: 0, py: 0, moved: false };
let moveData: { ids: string[]; start: NodePos; orig: Map<string, NodePos> } | null = null;
const connectSrc = reactive<{ nodeId: string; pin: PinDef | null; anchor: NodePos | null }>({ nodeId: "", pin: null, anchor: null });
const tempTo = ref<NodePos | null>(null);
let connectConsumed = false;

const tempEdge = computed(() => {
    if (mode.value !== "connect" || !connectSrc.anchor || !tempTo.value || !connectSrc.pin) return null;
    const c = connectSrc.pin.pinKind === "exec" ? EXEC_COLOR : typeColor(connectSrc.pin.dataType);
    return { from: connectSrc.anchor, to: tempTo.value, color: c };
});
// 拖线进行中的源针脚 —— 供节点做可连性暗淡
const connectingPin = computed(() => mode.value === "connect" ? connectSrc.pin : null);

// 不兼容提示 toast
const toast = reactive<{ visible: boolean; msg: string }>({ visible: false, msg: "" });
let toastTimer: any = null;
function showToast(msg: string) {
    toast.msg = msg; toast.visible = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.visible = false; }, 1600);
}

function addWin() { window.addEventListener("mousemove", onWinMove); window.addEventListener("mouseup", onWinUp); }
function rmWin() { window.removeEventListener("mousemove", onWinMove); window.removeEventListener("mouseup", onWinUp); }

function onCanvasDown(ev: MouseEvent) {
    if (ev.button === 2) return; // 右键交给 contextmenu
    closePopups();
    // 中键 或 按住空格 → 平移;否则左键空白拖拽 = 框选
    if (ev.button === 1 || spaceDown.value) {
        panStart = { x: ev.clientX, y: ev.clientY, px: panX.value, py: panY.value, moved: false };
        mode.value = "pan";
        addWin();
        return;
    }
    selStart = toGraph(ev.clientX, ev.clientY);
    selBox.x = selStart.x; selBox.y = selStart.y; selBox.w = 0; selBox.h = 0; selBox.visible = true;
    mode.value = "select";
    addWin();
}

function onHeadDown(p: { nodeId: string; ev: MouseEvent }) {
    closePopups();
    if (!sel.value.has(p.nodeId)) bp.setSelection([p.nodeId]);
    const ids = bp.state.selection.length ? [...bp.state.selection] : [p.nodeId];
    const orig = new Map<string, NodePos>();
    for (const id of ids) {
        const n = nodes.value.find(x => x.id === id);
        if (n) orig.set(id, { ...n.pos });
    }
    moveData = { ids, start: toGraph(p.ev.clientX, p.ev.clientY), orig };
    mode.value = "move";
    addWin();
}
function onBodyDown(p: { nodeId: string; ev: MouseEvent }) {
    closePopups();
    bp.setSelection([p.nodeId]);
}

function pinAnchorOf(nodeId: string, pinId: string): NodePos | null {
    const n = nodes.value.find(x => x.id === nodeId);
    if (!n) return null;
    return pinAnchor(n, bp.defOf(n), pinId);
}

function onPinDown(p: { nodeId: string; pin: PinDef; ev: MouseEvent }) {
    closePopups();
    connectSrc.nodeId = p.nodeId;
    connectSrc.pin = p.pin;
    connectSrc.anchor = pinAnchorOf(p.nodeId, p.pin.id);
    tempTo.value = toGraph(p.ev.clientX, p.ev.clientY);
    connectConsumed = false;
    mode.value = "connect";
    addWin();
}
function onPinUp(p: { nodeId: string; pin: PinDef; ev: MouseEvent }) {
    // 松手落在某针脚上 —— 无论当前是连线/移动/平移手势,都在此收尾(pin 的 .stop 会吞掉 window mouseup)
    if (mode.value === "connect" && connectSrc.pin) {
        const ok = bp.connect(connectSrc.nodeId, connectSrc.pin.id, p.nodeId, p.pin.id);
        connectConsumed = true;
        if (!ok) showToast("类型不兼容，无法接入");
    } else if (mode.value === "pan") {
        bp.setViewport({ panX: panX.value, panY: panY.value, scale: scale.value });
    }
    endGesture();
}

// move / connect 的拖动落地(供 onWinMove 与 edge-pan 帧循环复用)
function applyDrag(cx: number, cy: number) {
    if (mode.value === "move" && moveData) {
        const g = toGraph(cx, cy);
        const dx = g.x - moveData.start.x, dy = g.y - moveData.start.y;
        for (const id of moveData.ids) {
            const o = moveData.orig.get(id);
            if (o) bp.moveNode(id, { x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
        }
    } else if (mode.value === "connect") {
        tempTo.value = toGraph(cx, cy);
    }
}

const lastClient = { x: 0, y: 0 };
function onWinMove(ev: MouseEvent) {
    lastClient.x = ev.clientX; lastClient.y = ev.clientY;
    if (mode.value === "pan") {
        panX.value = panStart.px + (ev.clientX - panStart.x);
        panY.value = panStart.py + (ev.clientY - panStart.y);
        if (Math.abs(ev.clientX - panStart.x) + Math.abs(ev.clientY - panStart.y) > 3) panStart.moved = true;
    } else if (mode.value === "select") {
        const g = toGraph(ev.clientX, ev.clientY);
        selBox.x = Math.min(selStart.x, g.x); selBox.y = Math.min(selStart.y, g.y);
        selBox.w = Math.abs(g.x - selStart.x); selBox.h = Math.abs(g.y - selStart.y);
    } else {
        applyDrag(ev.clientX, ev.clientY);
        updateEdgePan(ev.clientX, ev.clientY);
    }
}

function finalizeSelect() {
    const x0 = selBox.x, y0 = selBox.y, x1 = selBox.x + selBox.w, y1 = selBox.y + selBox.h;
    const ids: string[] = [];
    for (const n of nodes.value) {
        const h = layoutOf(bp.defOf(n)).height;
        if (n.pos.x < x1 && n.pos.x + NODE_W > x0 && n.pos.y < y1 && n.pos.y + h > y0) ids.push(n.id);
    }
    bp.setSelection(ids);
    selBox.visible = false;
}

// ── 拖到边缘自动平移视图 ─────────────────────────────────────
let edgeRAF = 0;
const edgeVec = { x: 0, y: 0 };
function updateEdgePan(cx: number, cy: number) {
    const r = rect();
    const M = 56; // 触发边距
    let vx = 0, vy = 0;
    if (cx < r.left + M) vx = -(M - (cx - r.left));
    else if (cx > r.right - M) vx = M - (r.right - cx);
    if (cy < r.top + M) vy = -(M - (cy - r.top));
    else if (cy > r.bottom - M) vy = M - (r.bottom - cy);
    const sp = 0.22;
    edgeVec.x = Math.max(-16, Math.min(16, vx * sp));
    edgeVec.y = Math.max(-16, Math.min(16, vy * sp));
    if ((edgeVec.x || edgeVec.y) && !edgeRAF) edgeRAF = requestAnimationFrame(edgeTick);
    else if (!edgeVec.x && !edgeVec.y && edgeRAF) { cancelAnimationFrame(edgeRAF); edgeRAF = 0; }
}
function edgeTick() {
    if (mode.value !== "move" && mode.value !== "connect") { edgeRAF = 0; return; }
    panX.value -= edgeVec.x; panY.value -= edgeVec.y;
    applyDrag(lastClient.x, lastClient.y); // 内容随之移动,拖动对象保持在指针下
    edgeRAF = requestAnimationFrame(edgeTick);
}
function stopEdgePan() { if (edgeRAF) { cancelAnimationFrame(edgeRAF); edgeRAF = 0; } edgeVec.x = 0; edgeVec.y = 0; }
function onWinUp(ev: MouseEvent) {
    if (mode.value === "pan") {
        if (!panStart.moved) bp.setSelection([]); // 空白点击:清选
        bp.setViewport({ panX: panX.value, panY: panY.value, scale: scale.value });
    } else if (mode.value === "select") {
        if (selBox.w < 3 && selBox.h < 3) bp.setSelection([]); // 轻点空白:清选
        else finalizeSelect();
        selBox.visible = false;
    } else if (mode.value === "connect" && !connectConsumed && connectSrc.pin) {
        // 松手在空白 → 上下文搜索
        const src: DragSource = { pinKind: connectSrc.pin.pinKind, direction: connectSrc.pin.direction, dataType: connectSrc.pin.dataType };
        const loc = toLocal(ev.clientX, ev.clientY);
        openSearch(loc.x, loc.y, candidatesForPin(src), "连接到…", toGraph(ev.clientX, ev.clientY), "connect", allCreateCandidates());
        stopEdgePan();
        bp.setViewport({ panX: panX.value, panY: panY.value, scale: scale.value });
        rmWin();
        mode.value = "idle";
        return; // 保留 connectSrc 供 popup 完成接线
    }
    endGesture();
}
function endGesture() {
    stopEdgePan();
    rmWin();
    if (mode.value === "move" || mode.value === "connect") {
        bp.setViewport({ panX: panX.value, panY: panY.value, scale: scale.value }); // edge-pan 可能改了视图
    }
    mode.value = "idle";
    moveData = null;
    tempTo.value = null;
    if (!search.visible) { connectSrc.pin = null; connectSrc.anchor = null; }
}

// ── 缩放 ─────────────────────────────────────────────────────
function onWheel(ev: WheelEvent) {
    // 与 deltaY 成比例的平滑缩放,系数小 → 不过敏(触控板/滚轮都温和)
    const factor = Math.exp(-ev.deltaY * 0.0012);
    const ns = Math.min(2.5, Math.max(0.3, scale.value * factor));
    const r = rect();
    const lx = ev.clientX - r.left, ly = ev.clientY - r.top;
    const gx = (lx - panX.value) / scale.value, gy = (ly - panY.value) / scale.value;
    panX.value = lx - gx * ns;
    panY.value = ly - gy * ns;
    scale.value = ns;
    bp.setViewport({ panX: panX.value, panY: panY.value, scale: ns });
}

// ── 右键建节点 ───────────────────────────────────────────────
function onContextMenu(ev: MouseEvent) {
    const loc = toLocal(ev.clientX, ev.clientY);
    openSearch(loc.x, loc.y, allCreateCandidates(), "新建节点 · 输入可搜 Paper 方法", toGraph(ev.clientX, ev.clientY), "create");
}

// ── 拖放(左侧面板)─────────────────────────────────────────────
function onDrop(ev: DragEvent) {
    const defType = ev.dataTransfer?.getData("bp/def");
    const varName = ev.dataTransfer?.getData("bp/var");
    const graphId = ev.dataTransfer?.getData("bp/graph");
    const g = toGraph(ev.clientX, ev.clientY);
    if (defType) {
        const d = curatedDef(defType);
        if (d) bp.createNode(d, g);
    } else if (varName) {
        const loc = toLocal(ev.clientX, ev.clientY);
        varPop.visible = true; varPop.x = loc.x; varPop.y = loc.y; varPop.varName = varName; varPop.dropPos = g;
    } else if (graphId) {
        bp.instantiateGraph(graphId, g);
    }
}

// ── 搜索 / 变量 弹层 ─────────────────────────────────────────
const search = reactive<{ visible: boolean; x: number; y: number; candidates: NodeDef[]; allCandidates: NodeDef[] | undefined; title: string; dropPos: NodePos; mode: "create" | "connect" }>(
    { visible: false, x: 0, y: 0, candidates: [], allCandidates: undefined, title: "", dropPos: { x: 0, y: 0 }, mode: "create" });
const varPop = reactive<{ visible: boolean; x: number; y: number; varName: string; dropPos: NodePos }>(
    { visible: false, x: 0, y: 0, varName: "", dropPos: { x: 0, y: 0 } });

function openSearch(x: number, y: number, candidates: NodeDef[], title: string, dropPos: NodePos, m: "create" | "connect", allCandidates?: NodeDef[]) {
    search.visible = true; search.x = x; search.y = y; search.candidates = candidates; search.allCandidates = allCandidates; search.title = title; search.dropPos = dropPos; search.mode = m;
}
function onSearchSelect(def: NodeDef) {
    const node = bp.createNode(def, search.dropPos);
    if (search.mode === "connect" && connectSrc.pin) {
        const src: DragSource = { pinKind: connectSrc.pin.pinKind, direction: connectSrc.pin.direction, dataType: connectSrc.pin.dataType };
        const pid = matchPin(def, src);
        if (pid) bp.connect(connectSrc.nodeId, connectSrc.pin.id, node.id, pid);
        else showToast("该节点没有可接入的针脚");
    }
    closePopups();
}
function onVarChoose(m: "get" | "set") {
    bp.createVarNode(varPop.varName, m, varPop.dropPos);
    closePopups();
}
function closePopups() {
    search.visible = false;
    varPop.visible = false;
    connectSrc.pin = null; connectSrc.anchor = null;
}

// 暴露给 BlueprintView:面板点击「加到画布中央」
function centerGraph(): NodePos {
    const r = rect();
    return toGraph(r.left + r.width / 2, r.top + r.height / 3);
}
function addDefAtCenter(defType: string) {
    const d = curatedDef(defType);
    if (d) bp.createNode(d, centerGraph());
}
function varAtCenter(varName: string) {
    const r = rect();
    varPop.visible = true; varPop.x = r.width / 2 - 75; varPop.y = r.height / 3; varPop.varName = varName; varPop.dropPos = centerGraph();
}
defineExpose({ addDefAtCenter, varAtCenter });

// ── 键盘:删除选中 ───────────────────────────────────────────
function onKey(ev: KeyboardEvent) {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.code === "Space") { spaceDown.value = true; ev.preventDefault(); return; }
    if (ev.key === "Delete" || ev.key === "Backspace") {
        if (bp.state.selection.length) { ev.preventDefault(); for (const id of [...bp.state.selection]) bp.removeNode(id); }
    } else if (ev.key === "Escape") {
        closePopups();
    }
}
function onKeyUp(ev: KeyboardEvent) { if (ev.code === "Space") spaceDown.value = false; }
function onBlur() { spaceDown.value = false; }
onMounted(() => { window.addEventListener("keydown", onKey); window.addEventListener("keyup", onKeyUp); window.addEventListener("blur", onBlur); });
onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); window.removeEventListener("blur", onBlur);
    rmWin(); stopEdgePan();
});
</script>

<style scoped>
.bp-canvas {
  position: relative; flex: 1; overflow: hidden;
  background-color: #101015;
  background-image:
    linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
  cursor: default;
}
.bp-canvas.panning { cursor: grab; }
.bp-canvas.panning:active { cursor: grabbing; }
.bp-viewport { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.bp-selbox {
  position: absolute; pointer-events: none;
  background: rgba(137,221,255,0.1); border: 1px solid rgba(137,221,255,0.6);
  border-radius: 2px;
}
.bp-hint {
  position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
  font-size: 12px; color: rgba(255,255,255,0.3); pointer-events: none;
  padding: 6px 14px; border-radius: 20px; background: rgba(0,0,0,0.3);
}
.bp-toast {
  position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
  font-size: 12px; color: #ffcaca; pointer-events: none; z-index: 60;
  padding: 8px 16px; border-radius: 8px;
  background: rgba(40,12,12,0.92); border: 1px solid rgba(255,120,120,0.4);
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>
