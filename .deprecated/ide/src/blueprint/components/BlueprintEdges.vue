<template>
  <svg class="bp-edges" :width="1" :height="1">
    <g v-for="e in drawn" :key="e.id">
      <!-- 命中区(粗透明) -->
      <path :d="e.d" class="hit" @click.stop="bp.removeEdge(e.id)"/>
      <path :d="e.d" class="wire underlay" :stroke-width="e.exec ? 7 : 6"/>
      <!-- 可见线 -->
      <path :d="e.d" :stroke="e.color" :stroke-width="e.exec ? 3 : 2" class="wire" :class="{exec: e.exec}"/>
    </g>
    <!-- 拖拽中的临时线 -->
    <path v-if="temp" :d="tempD" :stroke="temp.color" stroke-width="2.5" class="wire temp"/>
  </svg>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { NodePos } from "../model";
import { pinAnchor, edgePath } from "../layout";
import { typeColor, EXEC_COLOR } from "../colors";
import { useBlueprint } from "../useBlueprint";

const props = defineProps<{ temp: { from: NodePos; to: NodePos; color: string } | null }>();
const bp = useBlueprint();

const drawn = computed(() => {
    const g = bp.currentGraph.value;
    if (!g) return [];
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const out: { id: string; d: string; color: string; exec: boolean }[] = [];
    for (const e of g.edges) {
        const fn = byId.get(e.from.node), tn = byId.get(e.to.node);
        if (!fn || !tn) continue;
        const fd = bp.defOf(fn), td = bp.defOf(tn);
        const a = pinAnchor(fn, fd, e.from.pin);
        const b = pinAnchor(tn, td, e.to.pin);
        if (!a || !b) continue;
        const exec = e.pinKind === "exec";
        const outPin = fd.pins.find(p => p.id === e.from.pin);
        out.push({ id: e.id, d: edgePath(a, b), color: exec ? EXEC_COLOR : typeColor(outPin?.dataType), exec });
    }
    return out;
});

const tempD = computed(() => props.temp ? edgePath(props.temp.from, props.temp.to) : "");
</script>

<style scoped>
.bp-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.wire { fill: none; pointer-events: none; stroke-linecap: round; }
.wire.underlay { stroke: #090806; }
.wire.exec { filter: drop-shadow(0 0 2px rgba(255,255,255,0.4)); }
.wire.temp { stroke-dasharray: 6 5; opacity: 0.85; }
.hit { fill: none; stroke: transparent; stroke-width: 12; pointer-events: stroke; cursor: pointer; }
.hit:hover ~ .wire:not(.underlay) { stroke-width: 4; }
</style>
