<template>
  <div v-if="playing" :key="burst" class="path-sparks" aria-hidden="true">
    <i v-for="(spark, index) in sparks" :key="index" class="path-spark" :style="spark" @animationend="index === sparks.length - 1 && finish()"/>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
const props = defineProps<{ verified: boolean }>();
const emit = defineEmits<{ settled: [verified: boolean] }>();
const playing = ref(false), burst = ref(0);
const sparks = Array.from({ length: 36 }, (_, index) => ({
  // Stagger from Main down the entire route; some sparks follow the card edges.
  left: ["9%", "50%", "91%"][index % 3],
  top: (2 + Math.floor(index / 3) * 8.2) + "%",
  "--spark-size": (2 + index % 4) + "px",
  "--spark-drift": ((index * 17 % 47) - 23) + "px",
  "--spark-rise": -(24 + index * 7 % 37) + "px",
  "--spark-delay": (index * 24) + "ms",
}));
let motion: MediaQueryList | undefined;
let finishTimer: ReturnType<typeof setTimeout> | undefined;
function finish() {
  clearTimeout(finishTimer);
  playing.value = false;
  emit("settled", props.verified);
}
watch(() => props.verified, (verified, previous) => {
  clearTimeout(finishTimer);
  playing.value = false;
  if (!verified || previous === undefined || motion?.matches) { emit("settled", verified); return; }
  emit("settled", false);
  burst.value++;
  playing.value = true;
  // Fallback if the browser suppresses animationend in a background tab.
  finishTimer = setTimeout(finish, 1950);
}, { immediate: true });
function motionChanged() { if (motion?.matches && playing.value) finish(); }
onMounted(() => { motion = window.matchMedia("(prefers-reduced-motion: reduce)"); motion.addEventListener("change", motionChanged); });
onBeforeUnmount(() => { clearTimeout(finishTimer); motion?.removeEventListener("change", motionChanged); });
</script>

<style scoped>
@layer legacy {
.path-sparks{position:absolute;inset:0;pointer-events:none;z-index:5;overflow:visible}.path-spark{position:absolute;width:var(--spark-size);height:var(--spark-size);background:var(--oak);box-shadow:0 0 7px var(--oak-soft);opacity:0;animation:path-spark-rise 850ms ease-out var(--spark-delay) both}.path-spark:nth-child(3n){background:var(--wheat)}
@keyframes path-spark-rise{0%{opacity:0;transform:translate(-50%,0) rotate(0deg)}15%{opacity:.95}60%{opacity:.7}100%{opacity:0;transform:translate(calc(-50% + var(--spark-drift)),var(--spark-rise)) rotate(100deg)}}
@media(prefers-reduced-motion:reduce){.path-sparks{display:none}.path-spark{animation:none}}
}
</style>
