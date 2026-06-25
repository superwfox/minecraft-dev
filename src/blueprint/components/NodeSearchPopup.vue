<template>
  <div v-if="visible" class="bp-search" :style="{left: x + 'px', top: y + 'px'}" @mousedown.stop @wheel.stop @contextmenu.prevent>
    <div class="bps-head">{{ title }}</div>
    <input ref="inp" v-model="q" class="bps-input" placeholder="搜索节点…"
           @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)"
           @keydown.enter.prevent="pick(filtered[active])" @keydown.esc.prevent="$emit('cancel')"/>
    <div class="bps-list">
      <div v-for="(d, i) in filtered" :key="d.type" class="bps-item" :class="{active: i === active}"
           @mouseenter="active = i" @click="pick(d)">
        <span class="bps-dot" :style="{background: color(d)}"></span>
        <span class="bps-label">{{ d.label }}</span>
        <span class="bps-cat">{{ d.category }}</span>
      </div>
      <div v-if="!filtered.length" class="bps-empty">无匹配节点</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import type { NodeDef } from "../model";
import { categoryColor, typeColor } from "../colors";

const props = defineProps<{ visible: boolean; x: number; y: number; candidates: NodeDef[]; title: string }>();
const emit = defineEmits<{ (e: "select", d: NodeDef): void; (e: "cancel"): void }>();

const q = ref("");
const active = ref(0);
const inp = ref<HTMLInputElement | null>(null);

const filtered = computed(() => {
    const s = q.value.trim().toLowerCase();
    const list = s
        ? props.candidates.filter(d => d.label.toLowerCase().includes(s) || d.type.toLowerCase().includes(s) || d.category.includes(s))
        : props.candidates;
    return list.slice(0, 80);
});

watch(() => props.visible, async (v) => {
    if (v) { q.value = ""; active.value = 0; await nextTick(); inp.value?.focus(); }
});
watch(filtered, () => { active.value = 0; });

function move(d: number) {
    const n = filtered.value.length;
    if (!n) return;
    active.value = (active.value + d + n) % n;
}
function pick(d?: NodeDef) { if (d) emit("select", d); }
// 成员节点(jar 派生真实方法)按其所属类型着色;策展节点按类别色
function color(d: NodeDef) { return d.special === "member" ? typeColor(d.category) : categoryColor(d.category); }
</script>

<style scoped>
.bp-search {
  position: absolute; z-index: 50; width: 260px;
  background: rgba(18, 18, 22, 0.98);
  border: 1px solid rgba(0,0,0,0.6);
  border-radius: 5px;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.08), inset -1px -1px 0 rgba(0,0,0,0.5), 0 14px 40px rgba(0,0,0,0.6);
  overflow: hidden;
}
.bps-head { padding: 7px 10px; font-size: 11px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.bps-input {
  width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.4);
  border: none; border-bottom: 1px solid rgba(255,255,255,0.08);
  color: wheat; font-size: 13px; padding: 8px 10px; outline: none; font-family: inherit;
}
.bps-list { max-height: 280px; overflow-y: auto; padding: 4px 0; }
.bps-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
.bps-item.active { background: rgba(245,222,179,0.12); }
.bps-dot { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.4); }
.bps-label { flex: 1; color: rgba(255,255,255,0.88); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bps-cat { font-size: 10px; color: rgba(255,255,255,0.35); }
.bps-empty { padding: 12px; text-align: center; font-size: 12px; color: rgba(255,255,255,0.3); font-style: italic; }
</style>
