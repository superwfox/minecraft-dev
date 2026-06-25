<template>
  <div class="bp-tray" :class="{open}">
    <div class="tray-handle" @click="open = !open">
      <span class="th-icon">▤</span>
      <span class="th-text">图库</span>
      <span class="th-num">{{ graphs.length }}</span>
    </div>

    <div class="tray-panel">
      <div class="tray-head">
        <span>图库</span>
        <span class="tray-add" @click="toggleAdd">{{ adding ? "取消" : "+ 新建图" }}</span>
      </div>
      <div v-if="adding" class="tray-newrow">
        <input ref="addInp" v-model="newName" class="tn-in" placeholder="图名称(事件 / 函数)"
               @keydown.enter="commitGraph" @keydown.esc="adding = false"/>
        <button class="tn-btn" @click="commitGraph">建</button>
      </div>
      <div class="tray-hint">把卡片拖到画布 → 该图整体复用进当前图</div>

      <div class="tray-list">
        <div v-for="g in graphs" :key="g.id" class="graph-card"
             :class="{active: g.id === bp.state.currentGraphId}"
             draggable="true" @dragstart="onDrag($event, g.id)" @click="bp.selectGraph(g.id)">
          <div class="gc-top">
            <span class="gc-dot"></span>
            <span class="gc-name">{{ g.name }}</span>
            <span v-if="graphs.length > 1" class="gc-del" @click.stop="bp.removeGraph(g.id)">×</span>
          </div>
          <div class="gc-meta">{{ g.nodes.length }} 节点 · {{ g.edges.length }} 连线 · {{ g.graphType === 'event' ? '事件' : '函数' }}</div>
          <div class="gc-grip">⠿ 拖出复用</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from "vue";
import { useBlueprint } from "../useBlueprint";

const bp = useBlueprint();
const open = ref(false);
const graphs = computed(() => bp.state.doc?.graphs || []);

const adding = ref(false);
const newName = ref("");
const addInp = ref<HTMLInputElement | null>(null);
async function toggleAdd() {
    adding.value = !adding.value;
    if (adding.value) { await nextTick(); addInp.value?.focus(); }
}
function commitGraph() {
    const n = newName.value.trim();
    if (!n) return;
    bp.addGraph(n, "function");
    newName.value = "";
    adding.value = false;
}

function onDrag(ev: DragEvent, id: string) {
    ev.dataTransfer?.setData("bp/graph", id);
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = "copy");
}
</script>

<style scoped>
.bp-tray {
  position: absolute; top: 0; right: 0; bottom: 0; width: 244px; z-index: 20;
  transform: translateX(100%); transition: transform 0.32s cubic-bezier(0.32,0.72,0.24,1);
}
.bp-tray.open { transform: translateX(0); }

.tray-handle {
  position: absolute; left: -36px; top: 50%; transform: translateY(-50%);
  width: 36px; padding: 14px 0; display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: rgba(8,8,10,0.85); border: 1px solid rgba(255,255,255,0.08); border-right: none;
  border-radius: 8px 0 0 8px; cursor: pointer; color: rgba(255,255,255,0.7);
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.06), -4px 0 16px rgba(0,0,0,0.35);
}
.tray-handle:hover { color: #89ddff; }
.th-icon { font-size: 14px; }
.th-text { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 2px; }
.th-num { font-family: monospace; font-size: 10px; color: rgba(255,255,255,0.4); }

.tray-panel {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  background: rgba(8,8,10,0.82); border-left: 1px solid rgba(255,255,255,0.08);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}
.tray-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; font-size: 11px; color: rgba(255,255,255,0.5);
  text-transform: uppercase; letter-spacing: 1.2px; border-bottom: 1px solid rgba(255,255,255,0.05);
}
.tray-add { cursor: pointer; color: #89ddff; text-transform: none; letter-spacing: 0; }
.tray-add:hover { filter: brightness(1.2); }
.tray-hint { padding: 8px 12px; font-size: 11px; color: rgba(255,255,255,0.32); line-height: 1.4; }
.tray-newrow { display: flex; gap: 6px; padding: 8px 12px 4px; }
.tn-in {
  flex: 1; min-width: 0; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 4px; color: wheat; font-size: 12px; padding: 6px 8px; outline: none; font-family: inherit;
}
.tn-in:focus { border-color: rgba(137,221,255,0.5); }
.tn-btn {
  flex-shrink: 0; background: rgba(137,221,255,0.2); border: 1px solid rgba(0,0,0,0.4);
  border-radius: 4px; color: #fff; font-size: 12px; padding: 0 12px; cursor: pointer; font-family: inherit;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.12), inset -1px -1px 0 rgba(0,0,0,0.4);
}
.tn-btn:hover { filter: brightness(1.2); }

.tray-list { flex: 1; overflow-y: auto; padding: 4px 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.graph-card {
  border-radius: 5px; padding: 9px 10px; cursor: grab;
  background: rgba(22,22,26,0.9);
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.07), inset -1px -1px 0 rgba(0,0,0,0.4);
  border: 1px solid rgba(0,0,0,0.5);
}
.graph-card:hover { background: rgba(137,221,255,0.08); }
.graph-card:active { cursor: grabbing; }
.graph-card.active { box-shadow: inset 1px 1px 0 rgba(255,255,255,0.08), 0 0 0 1.5px #89ddff; }
.gc-top { display: flex; align-items: center; gap: 7px; }
.gc-dot { width: 9px; height: 9px; border-radius: 2px; background: #89ddff; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); flex-shrink: 0; }
.gc-name { flex: 1; font-size: 13px; color: rgba(255,255,255,0.9); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gc-del { color: rgba(255,255,255,0.3); cursor: pointer; font-size: 14px; }
.gc-del:hover { color: #ff7a7a; }
.gc-meta { font-size: 10px; color: rgba(255,255,255,0.4); font-family: monospace; margin-top: 5px; }
.gc-grip { font-size: 10px; color: rgba(137,221,255,0.5); margin-top: 6px; letter-spacing: 1px; }
</style>
