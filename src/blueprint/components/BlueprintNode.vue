<template>
  <div class="bp-node" :class="{selected, pure: def.kind === 'pure'}"
       :style="{left: node.pos.x + 'px', top: node.pos.y + 'px', width: NODE_W + 'px', height: lay.height + 'px'}"
       @mousedown.stop="onBodyDown">
    <!-- 头部:可拖动移动 -->
    <div class="bp-head" :style="{background: headBg, borderColor: headColor}" @mousedown.stop="onHeadDown">
      <span class="bp-dot" :style="{background: headColor}"></span>
      <span class="bp-title">{{ def.label }}</span>
      <span class="bp-del" @mousedown.stop @click.stop="emit('remove', node.id)">×</span>
    </div>

    <div class="bp-body">
      <!-- 字面量节点:整块编辑器 -->
      <div v-if="def.special === 'literal' && def.pins[0]" class="bp-litrow">
        <input v-if="def.pins[0].dataType !== 'boolean'" class="bp-lit" :value="litVal(def.pins[0])"
               @mousedown.stop @input="onLit(def.pins[0].id, ($event.target as HTMLInputElement).value)"/>
        <select v-else class="bp-lit" :value="litVal(def.pins[0]) || 'true'" @mousedown.stop
                @change="onLit(def.pins[0].id, ($event.target as HTMLSelectElement).value)">
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </div>

      <!-- 输入针脚行 -->
      <div v-for="row in lay.inputs" :key="'i'+row.pin.id" class="bp-row in" :style="{top: (row.y - HEADER_H) + 'px'}">
        <span class="pin" :class="pinShape(row.pin)" :style="pinStyle(row.pin, 'in')"
              @mousedown.stop="emit('pindown', {nodeId: node.id, pin: row.pin, ev: $event})"
              @mouseup.stop="emit('pinup', {nodeId: node.id, pin: row.pin, ev: $event})"></span>
        <span class="pin-name">{{ row.pin.name }}</span>
        <input v-if="showInlineLit(row.pin)" class="bp-lit inline" :value="litVal(row.pin)"
               :placeholder="row.pin.dataType" @mousedown.stop
               @input="onLit(row.pin.id, ($event.target as HTMLInputElement).value)"/>
      </div>

      <!-- 输出针脚行 -->
      <div v-for="row in lay.outputs" :key="'o'+row.pin.id" class="bp-row out" :style="{top: (row.y - HEADER_H) + 'px'}">
        <span v-if="def.special !== 'literal'" class="pin-name">{{ row.pin.name }}</span>
        <span class="pin" :class="pinShape(row.pin)" :style="pinStyle(row.pin, 'out')"
              @mousedown.stop="emit('pindown', {nodeId: node.id, pin: row.pin, ev: $event})"
              @mouseup.stop="emit('pinup', {nodeId: node.id, pin: row.pin, ev: $event})"></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { GraphNode, NodeDef, PinDef } from "../model";
import { NODE_W, HEADER_H, layoutOf } from "../layout";
import { typeColor, EXEC_COLOR, categoryColor } from "../colors";
import { useBlueprint } from "../useBlueprint";

const props = defineProps<{ node: GraphNode; def: NodeDef; selected: boolean }>();
const emit = defineEmits<{
    (e: "pindown", p: { nodeId: string; pin: PinDef; ev: MouseEvent }): void;
    (e: "pinup", p: { nodeId: string; pin: PinDef; ev: MouseEvent }): void;
    (e: "headdown", p: { nodeId: string; ev: MouseEvent }): void;
    (e: "bodydown", p: { nodeId: string; ev: MouseEvent }): void;
    (e: "remove", id: string): void;
}>();

const bp = useBlueprint();
const lay = computed(() => layoutOf(props.def));
const headColor = computed(() => categoryColor(props.def.category));
const headBg = computed(() => `linear-gradient(180deg, ${hex(headColor.value, 0.32)}, ${hex(headColor.value, 0.14)})`);

function hex(c: string, a: number): string {
    const m = c.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
}

function pinShape(p: PinDef) { return p.pinKind === "exec" ? "exec" : "data"; }
function pinColor(p: PinDef) { return p.pinKind === "exec" ? EXEC_COLOR : typeColor(p.dataType); }
function pinStyle(p: PinDef, dir: "in" | "out") {
    const connected = bp.isPinConnected(props.node.id, p.id, dir);
    const c = pinColor(p);
    return p.pinKind === "exec"
        ? { borderLeftColor: c, opacity: connected ? 1 : 0.85 }
        : { borderColor: c, background: connected ? c : "transparent" };
}

const LIT_CAPABLE = new Set(["String", "int", "long", "double", "float", "short", "byte", "char", "boolean"]);
function showInlineLit(p: PinDef): boolean {
    if (p.pinKind !== "data" || p.direction !== "in") return false;
    if (bp.isPinConnected(props.node.id, p.id, "in")) return false;
    const t = (p.dataType || "").replace(/<.*/, "");
    return LIT_CAPABLE.has(t);
}
function litVal(p?: PinDef) { return (p && props.node.literals?.[p.id]) || ""; }
function onLit(pinId: string, value: string) { bp.setLiteral(props.node.id, pinId, value); }
function onHeadDown(ev: MouseEvent) { emit("headdown", { nodeId: props.node.id, ev }); }
function onBodyDown(ev: MouseEvent) { emit("bodydown", { nodeId: props.node.id, ev }); }
</script>

<style scoped>
.bp-node {
  position: absolute;
  display: flex;
  flex-direction: column;
  border-radius: 4px;
  background: rgba(22, 22, 26, 0.96);
  /* Minecraft 方块浮雕:亮上左 + 暗下右 */
  box-shadow: inset 2px 2px 0 rgba(255,255,255,0.10), inset -2px -2px 0 rgba(0,0,0,0.55),
              0 6px 18px rgba(0,0,0,0.45);
  border: 1px solid rgba(0,0,0,0.6);
  color: rgba(255,255,255,0.86);
  user-select: none;
  font-size: 12px;
}
.bp-node.selected {
  box-shadow: inset 2px 2px 0 rgba(255,255,255,0.12), inset -2px -2px 0 rgba(0,0,0,0.55),
              0 0 0 2px wheat, 0 8px 22px rgba(0,0,0,0.5);
}
.bp-node.pure { background: rgba(26, 28, 24, 0.96); }

.bp-head {
  display: flex; align-items: center; gap: 6px;
  height: 34px; flex-shrink: 0; padding: 0 8px;
  border-bottom: 2px solid;
  cursor: grab;
  box-shadow: inset 0 2px 0 rgba(255,255,255,0.08);
}
.bp-head:active { cursor: grabbing; }
.bp-dot { width: 9px; height: 9px; border-radius: 2px; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); flex-shrink: 0; }
.bp-title { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.3px; }
.bp-del { color: rgba(255,255,255,0.35); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
.bp-del:hover { color: #ff7a7a; }

.bp-body { position: relative; flex: 1; }
.bp-row { position: absolute; display: flex; align-items: center; gap: 6px; height: 0; transform: translateY(-50%); }
.bp-row.in { left: 10px; right: 10px; justify-content: flex-start; }
.bp-row.out { left: 10px; right: 10px; justify-content: flex-end; }

.pin { width: 11px; height: 11px; flex-shrink: 0; cursor: crosshair; box-sizing: border-box; }
.pin.data { border-radius: 2px; border: 2px solid; }
.pin.exec {
  width: 0; height: 0; background: none !important;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent;
  border-left: 9px solid; border-radius: 0;
}
.bp-row.in .pin { position: absolute; left: -16px; }
.bp-row.out .pin { position: absolute; right: -16px; }
.pin:hover { filter: brightness(1.4); transform: scale(1.15); }

.pin-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgba(255,255,255,0.78); max-width: 110px; }
.bp-row.out .pin-name { text-align: right; }

.bp-litrow { padding: 8px; }
.bp-lit {
  width: 100%; box-sizing: border-box;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 3px; color: wheat; font-size: 11px; padding: 3px 6px; outline: none; font-family: inherit;
}
.bp-lit.inline { width: 78px; flex-shrink: 0; }
.bp-lit:focus { border-color: rgba(245,222,179,0.5); }
</style>
