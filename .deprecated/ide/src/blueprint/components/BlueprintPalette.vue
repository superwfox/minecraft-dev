<template>
  <div class="bp-palette">
    <!-- 节点类别(常驻)──────────────────────────── -->
    <div class="bp-sec nodes">
      <div class="sec-title">节点</div>
      <div class="cat-scroll">
        <div v-for="c in grouped" :key="c.name" class="cat">
          <div class="cat-head" @click="toggle(c.name)">
            <span class="chev" :class="{open: !collapsed[c.name]}">▸</span>
            <span class="cat-dot" :style="{background: color(c.name)}"></span>
            <span class="cat-name">{{ c.name }}</span>
            <span class="cat-num">{{ c.defs.length }}</span>
          </div>
          <div v-show="!collapsed[c.name]" class="cat-items">
            <div v-for="d in c.defs" :key="d.type" class="node-item" draggable="true"
                 @dragstart="onDragDef($event, d.type)" @click="$emit('pick', d.type)" :title="d.desc || d.label">
              <span class="ni-bar" :style="{background: color(c.name)}"></span>
              <span class="ni-label">{{ d.label }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 变量(get/set)──────────────────────────── -->
    <div class="bp-sec bottom">
      <div class="sec-title">
        变量<span class="sec-add" @click="adding = !adding">+</span>
      </div>
      <div v-if="adding" class="var-add">
        <input v-model="newName" class="va-in" placeholder="名称"
               @compositionstart="onImeCompositionStart" @compositionend="onImeCompositionEnd"
               @keydown.enter="onVarEnter"/>
        <select v-model="newType" class="va-sel">
          <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
        <button class="va-btn" @click="commitVar">加</button>
      </div>
      <div class="var-list">
        <div v-for="v in bp.variables.value" :key="v.name" class="var-row" draggable="true"
             @dragstart="onDragVar($event, v.name)" @click="$emit('pickVar', v.name)">
          <span class="v-dot"></span>
          <span class="v-name">{{ v.name }}</span>
          <span class="v-type">{{ v.dataType }}</span>
          <span class="v-del" @click.stop="bp.removeVariable(v.name)">×</span>
        </div>
        <div v-if="!bp.variables.value.length" class="var-empty">拖出可建 get/set 节点</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from "vue";
import { allCuratedDefs } from "../registry";
import { CATEGORIES } from "../curated";
import { categoryColor } from "../colors";
import { useBlueprint } from "../useBlueprint";
import {isImeComposing, onImeCompositionEnd, onImeCompositionStart} from "../../logic/keyboard";

defineEmits<{ (e: "pick", defType: string): void; (e: "pickVar", name: string): void }>();
const bp = useBlueprint();

const grouped = computed(() => {
    const all = allCuratedDefs();
    return CATEGORIES.map(name => ({ name, defs: all.filter(d => d.category === name) }))
        .filter(c => c.defs.length);
});

const collapsed = reactive<Record<string, boolean>>({});
function toggle(name: string) { collapsed[name] = !collapsed[name]; }
function color(c: string) { return categoryColor(c); }

function onDragDef(ev: DragEvent, type: string) {
    ev.dataTransfer?.setData("bp/def", type);
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = "copy");
}
function onDragVar(ev: DragEvent, name: string) {
    ev.dataTransfer?.setData("bp/var", name);
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = "copy");
}

// 变量新增
const TYPES = ["String", "int", "double", "boolean", "Player", "Location", "ItemStack", "Object"];
const adding = ref(false);
const newName = ref("");
const newType = ref("String");
function onVarEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    commitVar();
}
function commitVar() {
    const n = newName.value.trim();
    if (!n) return;
    if (bp.addVariable(n, newType.value, "field")) { newName.value = ""; adding.value = false; }
}
</script>

<style scoped>
.bp-palette {
  width: 232px; flex-shrink: 0; display: flex; flex-direction: column;
  background: rgba(8, 8, 10, 0.7); border-right: 1px solid rgba(255,255,255,0.06);
  min-height: 0;
  animation: paletteIn 0.42s cubic-bezier(0.32,0.72,0.24,1) both;
}
@keyframes paletteIn { from { transform: translateX(-40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.bp-sec { display: flex; flex-direction: column; min-height: 0; }
.bp-sec.nodes { flex: 1; }
.bp-sec.bottom {
  flex: 0 0 auto; max-height: 46%; border-top: 1px solid rgba(255,255,255,0.07);
  animation: bottomIn 0.46s cubic-bezier(0.32,0.72,0.24,1) 0.12s both;
}
@keyframes bottomIn { from { transform: translateY(28px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.sec-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 12px; font-size: 11px; color: rgba(255,255,255,0.45);
  text-transform: uppercase; letter-spacing: 1.2px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.sec-add { cursor: pointer; font-size: 15px; color: rgba(255,255,255,0.4); padding: 0 4px; }
.sec-add:hover { color: wheat; }

.cat-scroll { overflow-y: auto; padding: 4px 0; flex: 1; }
.cat-head { display: flex; align-items: center; gap: 6px; padding: 5px 12px; cursor: pointer; font-size: 11px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 0.8px; }
.cat-head:hover { background: rgba(255,255,255,0.03); }
.chev { font-size: 9px; transition: transform 0.15s; color: rgba(255,255,255,0.4); }
.chev.open { transform: rotate(90deg); }
.cat-dot { width: 10px; height: 10px; border-radius: 2px; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); }
.cat-name { flex: 1; }
.cat-num { font-family: monospace; font-size: 10px; color: rgba(255,255,255,0.35); }

.cat-items { padding: 2px 0 6px; }
.node-item {
  display: flex; align-items: center; gap: 8px; padding: 4px 12px 4px 26px;
  cursor: grab; font-size: 12px; color: rgba(255,255,255,0.78);
}
.node-item:hover { background: rgba(245,222,179,0.08); color: #fff; }
.node-item:active { cursor: grabbing; }
.ni-bar { width: 3px; height: 13px; border-radius: 2px; flex-shrink: 0; }
.ni-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.graph-list { overflow-y: auto; padding: 4px 0; max-height: 130px; }
.graph-row { display: flex; align-items: center; gap: 7px; padding: 5px 12px; cursor: pointer; font-size: 12px; color: rgba(255,255,255,0.72); }
.graph-row:hover { background: rgba(255,255,255,0.04); }
.graph-row.active { background: rgba(245,222,179,0.1); color: wheat; }
.g-icon { color: rgba(255,255,255,0.4); }
.g-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-type { font-size: 10px; color: rgba(255,255,255,0.35); }

.var-add { display: flex; gap: 4px; padding: 6px 12px; }
.va-in { flex: 1; min-width: 0; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; color: wheat; font-size: 11px; padding: 4px 6px; outline: none; }
.va-sel { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; color: rgba(255,255,255,0.85); font-size: 11px; outline: none; }
.va-btn { background: rgba(137,221,255,0.2); border: 1px solid rgba(0,0,0,0.4); border-radius: 3px; color: #fff; font-size: 11px; padding: 0 8px; cursor: pointer; }

.var-list { overflow-y: auto; padding: 2px 0 8px; }
.var-row { display: flex; align-items: center; gap: 7px; padding: 4px 12px; cursor: grab; font-size: 12px; color: rgba(255,255,255,0.78); }
.var-row:hover { background: rgba(137,221,255,0.08); }
.v-dot { width: 9px; height: 9px; border-radius: 2px; background: #89ddff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); }
.v-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-type { font-size: 10px; color: rgba(255,255,255,0.4); font-family: monospace; }
.v-del { color: rgba(255,255,255,0.3); cursor: pointer; }
.v-del:hover { color: #ff7a7a; }
.var-empty { padding: 8px 12px; font-size: 11px; color: rgba(255,255,255,0.3); font-style: italic; }
</style>
