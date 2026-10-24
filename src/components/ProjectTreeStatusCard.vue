<template>
  <div class="tree-status-slot" :class="{ 'is-active': shown }">
  <div ref="statusCard" v-lattice:two class="tree-status-card" :class="{ 'has-activity': shown && !restoring }" role="status" :aria-busy="!!busy">
    <div ref="statusCopy" class="tree-status-copy">
    <strong><i aria-hidden="true"/>{{ label }}</strong>
    <span>{{ detail }}</span>
    </div>
  </div>
  <ToolActivityIsland v-if="shown" :activity="shown" :pending="pending" :return-target="statusCard" @advance="settled" @returning="restoreText" @settled="settled"/>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import ToolActivityIsland from "./ToolActivityIsland.vue";
import { consumeToolActivity, toolActivities, type ToolActivity } from "../logic/toolActivity";
defineProps<{ label: string; detail: string; busy?: boolean }>();
const shown = ref<ToolActivity | null>(null);
const statusCard = ref<HTMLElement | null>(null), statusCopy = ref<HTMLElement | null>(null);
const restoring = ref(false);
let textAnimation: Animation | undefined;
const available = computed(() => toolActivities.filter(item => !item.quiet));
const pending = computed(() => Math.max(0, available.value.length - 1));
watch(() => available.value.map(item => `${item.id}:${item.status}`).join(), () => {
  if (shown.value && !available.value.some(item => item.id === shown.value!.id)) shown.value = null;
  if (!shown.value) shown.value = available.value[0] || null;
}, { immediate: true });
function settled(id: number) { if (shown.value?.id === id) consumeToolActivity(id); }
watch(() => shown.value?.id, () => { restoring.value = false; textAnimation?.cancel(); });
async function restoreText(id: number) {
  if (shown.value?.id !== id) return;
  restoring.value = true;
  await nextTick();
  if (shown.value?.id !== id || !statusCopy.value) return;
  textAnimation?.cancel();
  textAnimation = statusCopy.value.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 240,
    fill: "forwards", easing: "ease-in-out",
  });
}
onBeforeUnmount(() => textAnimation?.cancel());
</script>

<style scoped>
@layer legacy {
.tree-status-slot{position:relative;flex-shrink:0;isolation:isolate}
.tree-status-slot.is-active{z-index:40}
.tree-status-card{display:flex;flex-direction:column;justify-content:center;gap:9px;padding:22px 25px;min-height:92px;min-width:220px;--lattice-corner-inset:-1px}
.tree-status-card.has-activity{visibility:hidden}
.tree-status-copy{display:flex;flex-direction:column;gap:9px}
.tree-status-card strong{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:400}
.tree-status-card i{width:5px;height:5px;border-radius:50%;background:var(--oak)}
.tree-status-copy>span{font-size:10px;color:var(--text-muted)}
}
</style>
