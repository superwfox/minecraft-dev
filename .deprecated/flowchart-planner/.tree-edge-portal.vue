<template>
  <div class="edge-portals" aria-hidden="true">
    <div v-for="side in visibleSides" :key="side" class="portal-edge" :class="'portal-' + side">
      <i class="portal-light"/>
      <i v-for="(pixel, index) in pixels" :key="index" class="portal-pixel" :style="pixel"/>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
const props = defineProps<{ viewport: HTMLElement | null }>();
const overflow = reactive({ left: false, right: false });
const visibleSides = computed(() => (["left", "right"] as const).filter(side => overflow[side]));
const pixels = [
  { top: "14%", "--pixel-size": "3px", "--pixel-phase": "-.3s", "--pixel-rise": "-16px" },
  { top: "39%", "--pixel-size": "2px", "--pixel-phase": "-3.8s", "--pixel-rise": "-25px" },
  { top: "66%", "--pixel-size": "4px", "--pixel-phase": "-6.1s", "--pixel-rise": "-19px" },
  { top: "88%", "--pixel-size": "2px", "--pixel-phase": "-1.9s", "--pixel-rise": "-30px" },
];
watch(() => props.viewport, (viewport, _previous, cleanup) => {
  overflow.left = false; overflow.right = false;
  if (!viewport) return;
  let frame = 0;
  function update() {
    frame = 0;
    const limit = Math.max(0, viewport!.scrollWidth - viewport!.clientWidth);
    const position = Math.max(0, Math.min(limit, viewport!.scrollLeft));
    overflow.left = position > 1;
    overflow.right = limit - position > 1;
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  const observer = new ResizeObserver(schedule);
  observer.observe(viewport);
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
  viewport.addEventListener("scroll", schedule, { passive: true });
  schedule();
  cleanup(() => { cancelAnimationFrame(frame); observer.disconnect(); viewport.removeEventListener("scroll", schedule); });
}, { immediate: true, flush: "post" });
</script>

<style scoped>
@layer legacy {
.edge-portals{position:absolute;inset:20px 0 8px;pointer-events:none;z-index:6}.portal-edge{position:absolute;top:0;bottom:0;width:1px;--pixel-drift:30px}.portal-left{left:0}.portal-right{right:0;--pixel-drift:-30px}.portal-light{position:absolute;inset:0;background:linear-gradient(transparent,var(--oak-hover) 5%,var(--wheat) 50%,var(--oak-hover) 95%,transparent);box-shadow:0 0 4px var(--oak),0 0 12px rgba(198,176,125,.4);opacity:.9;animation:portal-glow 5.5s ease-in-out infinite}.portal-light::after{content:'';position:absolute;inset:0 -5px;background:linear-gradient(90deg,transparent,rgba(198,176,125,.17),transparent)}.portal-pixel{position:absolute;left:0;width:var(--pixel-size);height:var(--pixel-size);background:var(--oak-hover);box-shadow:0 0 5px var(--oak-soft);opacity:0;animation:portal-pixel-drift 9s linear var(--pixel-phase) infinite}
@keyframes portal-glow{0%,100%{opacity:.75}50%{opacity:1}}
@keyframes portal-pixel-drift{0%{opacity:0;transform:translate(-50%,0) rotate(0deg)}2%{opacity:.85}8%{opacity:.5}13%,100%{opacity:0;transform:translate(var(--pixel-drift),var(--pixel-rise)) rotate(75deg)}}
@media(prefers-reduced-motion:reduce){.portal-light{animation:none}.portal-pixel{display:none;animation:none}}
}
</style>
