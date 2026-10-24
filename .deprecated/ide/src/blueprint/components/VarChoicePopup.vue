<template>
  <div v-if="visible" class="bp-varpop" :style="{left: x + 'px', top: y + 'px'}" @mousedown.stop>
    <div class="vp-name">{{ varName }}</div>
    <div class="vp-btns">
      <button class="vp-btn get" @click="$emit('choose', 'get')">取 Get</button>
      <button class="vp-btn set" @click="$emit('choose', 'set')">设 Set</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean; x: number; y: number; varName: string }>();
defineEmits<{ (e: "choose", mode: "get" | "set"): void; (e: "cancel"): void }>();
</script>

<style scoped>
.bp-varpop {
  position: absolute; z-index: 50;
  background: rgba(18, 18, 22, 0.98);
  border: 1px solid rgba(0,0,0,0.6); border-radius: 5px;
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.08), inset -1px -1px 0 rgba(0,0,0,0.5), 0 14px 40px rgba(0,0,0,0.6);
  padding: 8px; min-width: 150px;
}
.vp-name { font-size: 12px; color: #89ddff; font-weight: 600; padding: 2px 4px 8px; text-align: center; }
.vp-btns { display: flex; gap: 6px; }
.vp-btn {
  flex: 1; padding: 7px 0; font-size: 12px; cursor: pointer; font-family: inherit;
  border-radius: 4px; border: 1px solid rgba(0,0,0,0.5); color: rgba(255,255,255,0.9);
  box-shadow: inset 1px 1px 0 rgba(255,255,255,0.12), inset -1px -1px 0 rgba(0,0,0,0.4);
}
.vp-btn.get { background: rgba(137,221,255,0.18); }
.vp-btn.set { background: rgba(199,146,234,0.18); }
.vp-btn:hover { filter: brightness(1.25); }
</style>
