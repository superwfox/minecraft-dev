<template>
  <div ref="island" class="tool-island" :data-phase="phase" :data-outcome="activity.status" role="status" aria-live="polite" :aria-busy="activity.status === 'running'">
    <div ref="shell" v-lattice:two class="island-shell" :aria-busy="activity.status === 'running'" aria-hidden="true"/>
    <div ref="content" class="island-content">
    <div class="island-stage" aria-hidden="true">
      <div ref="card" class="island-card"><ToolActivityStamp :activity="activity" :elapsed="elapsed"/><ToolActivityStamp :activity="activity" :elapsed="elapsed" reverse/></div>
    </div>
    <div v-if="pending" class="island-pending" :title="pending + ' 项调用等待展示'">+{{ pending }}</div>
    <div ref="outcome" class="island-outcome" aria-hidden="true">
      <span v-if="activity.status === 'running'" class="island-spinner" aria-hidden="true"/>
      <svg v-else-if="activity.status === 'success'" :key="activity.id" class="island-check" width="17" height="17" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="m4 12 5 5L20 6" pathLength="1"/>
      </svg>
      <X v-else-if="activity.status === 'error'" :size="17" aria-hidden="true"/>
      <Minus v-else :size="17" aria-hidden="true"/>
      <span>{{ outcomeLabel }}</span>
    </div>
    <div ref="summary" class="island-summary" aria-hidden="true"><strong>{{ activity.title }} · {{ outcomeLabel }}</strong><span data-font="dynamic" :title="activity.summary">{{ activity.summary }}</span></div>
    </div>
    <span class="island-announcement">{{ activity.title }}，{{ activity.status === 'running' ? activity.detail : activity.summary }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X, Minus } from "lucide-vue-next";
import ToolActivityStamp from "./ToolActivityStamp.vue";
import type { ToolActivity } from "../logic/toolActivity";
const props = defineProps<{ activity: ToolActivity; pending: number; returnTarget?: HTMLElement | null }>();
const emit = defineEmits<{ settled: [id: number]; returning: [id: number]; advance: [id: number] }>();
const island = ref<HTMLElement>(), content = ref<HTMLElement>();
const shell = ref<HTMLElement>(), card = ref<HTMLElement>(), outcome = ref<HTMLElement>(), summary = ref<HTMLElement>();
const phase = ref("opening"), now = ref(Date.now());
const elapsed = computed(() => ((Math.max(props.activity.startedAt, props.activity.endedAt || now.value) - props.activity.startedAt) / 1000).toFixed(1));
const outcomeLabel = computed(() => ({ running: "执行中", success: "已完成", error: "未完成", cancelled: "已取消", notice: "需留意" }[props.activity.status]));
const animations = new Set<Animation>();
const delays = new Map<ReturnType<typeof setTimeout>, () => void>();
let revision = 0, clock: ReturnType<typeof setInterval> | undefined;
let reduced = false, advancing = false, handoffPhase = "";
function startClock() { now.value = Date.now(); clock = setInterval(() => { now.value = Date.now(); }, 250); }
function cleanup() {
  revision++;
  animations.forEach(animation => animation.cancel()); animations.clear();
  delays.forEach((resolve, timer) => { clearTimeout(timer); resolve(); }); delays.clear();
  clearInterval(clock);
}
function hold(ms: number) { return new Promise<void>(resolve => { const timer = setTimeout(() => { delays.delete(timer); resolve(); }, ms); delays.set(timer, resolve); }); }
async function animate(element: HTMLElement | undefined, frames: Keyframe[], duration: number, easing = "cubic-bezier(.22,.8,.25,1)") {
  if (!element) return;
  const animation = element.animate(frames, { duration: reduced ? 1 : duration, fill: "forwards", easing });
  animations.add(animation);
  try { await animation.finished; } catch { /* replacement or unmount */ }
  animations.delete(animation);
}
async function open() {
  cleanup(); const run = revision;
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  advancing = false; handoffPhase = ""; phase.value = "opening"; startClock();
  await nextTick(); if (run !== revision) return;
  await Promise.all([
    animate(shell.value, [{ height: "92px", opacity: 0 }, { height: "248px", opacity: 1, offset: .75 }, { height: "240px", opacity: 1 }], 560),
    animate(card.value, [{ transform: "translateY(-14px) rotateY(-65deg) scale(.64)" }, { transform: "translateY(4px) rotateY(5deg) scale(1.025)", offset: .75 }, { transform: "none" }], 680),
    animate(outcome.value, [{ opacity: 0 }, { opacity: 1 }], 650),
  ]);
  if (run !== revision) return;
  phase.value = "running";
  if (props.activity.status !== "running") void finish();
}
function advance() {
  if (advancing || !props.pending) return false;
  advancing = true;
  const run = ++revision, id = props.activity.id;
  handoffPhase = phase.value;
  phase.value = "switching-out";
  clearInterval(clock);
  void fadeToNext(run, id);
  return true;
}
async function fadeToNext(run: number, id: number) {
  const opacity = content.value ? getComputedStyle(content.value).opacity : "1";
  await animate(content.value, [{ opacity }, { opacity: 0 }], 180, "ease-in-out");
  if (run === revision && props.activity.id === id) emit("advance", id);
}
async function continueActivity() {
  const previousPhase = handoffPhase || phase.value;
  const expanded = ["running", "result"].includes(previousPhase);
  const frame = island.value?.getBoundingClientRect();
  const shellStyle = shell.value && getComputedStyle(shell.value);
  const contentStyle = content.value && getComputedStyle(content.value);
  const cardTransform = previousPhase === "restoring" ? "translate(-128px,-49px) rotateY(180deg) scale(.001)"
    : card.value && getComputedStyle(card.value).transform;
  // Capture before cancellation so a late arrival can reverse an in-progress close.
  const previous = { height: shellStyle?.height || "92px", opacity: shellStyle?.opacity || "1",
    contentTransform: contentStyle?.transform || "none", contentOpacity: contentStyle?.opacity || "1",
    outcomeOpacity: outcome.value ? getComputedStyle(outcome.value).opacity : "1",
    summaryOpacity: summary.value ? getComputedStyle(summary.value).opacity : "0" };
  cleanup(); const run = revision;
  advancing = false; handoffPhase = ""; reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  phase.value = expanded ? "switching-in" : "resuming"; startClock();
  await nextTick(); if (run !== revision) return;
  if (expanded) await animate(content.value, [{ opacity: previous.contentOpacity }, { opacity: 1 }], 180, "ease-in-out");
  else await Promise.all([
    animate(island.value, [{ width: `${frame?.width || 330}px`, height: `${frame?.height || 92}px` }, { width: "330px", height: "92px" }], 420),
    animate(shell.value, [{ height: previous.height, opacity: previous.opacity }, { height: "240px", opacity: 1 }], 420),
    animate(content.value, [{ transform: previous.contentTransform }, { transform: "none" }], 420),
    animate(content.value, [{ opacity: previous.contentOpacity }, { opacity: 1 }], 180, "ease-in-out"),
    animate(card.value, [{ transform: cardTransform || "none" }, { transform: "none" }], 420),
    animate(outcome.value, [{ opacity: previous.outcomeOpacity }, { opacity: 1 }], 420),
    animate(summary.value, [{ opacity: previous.summaryOpacity }, { opacity: 0 }], 420),
  ]);
  if (run !== revision) return;
  phase.value = "running";
  if (props.activity.status !== "running") void finish();
}
async function finish() {
  if (phase.value !== "running") return;
  const run = revision, id = props.activity.id;
  phase.value = "result"; clearInterval(clock);
  await hold(reduced ? 80 : 540); if (run !== revision) return;
  if (advance()) return;
  phase.value = "folding";
  await Promise.all([
    animate(card.value, [
      { transform: "translate(0,0) rotateY(0deg) scale(1)" },
      { transform: "translate(-12px,-5px) rotateY(175deg) scale(.88)", offset: .45 },
      { transform: "translate(-128px,-49px) rotateY(180deg) scale(.23)" },
    ], 900),
    animate(shell.value, [{ height: "240px" }, { height: "250px", offset: .18 }, { height: "92px" }], 900),
    animate(outcome.value, [{ opacity: 1 }, { opacity: 0, offset: .3 }, { opacity: 0 }], 600),
    animate(summary.value, [{ opacity: 0, transform: "translateX(12px)", offset: 0 }, { opacity: 0, transform: "translateX(12px)", offset: .6 }, { opacity: 1, transform: "none" }], 900),
  ]);
  if (run !== revision) return;
  phase.value = "compact";
  if (advance()) return;
  await hold(reduced ? 800 : props.activity.status === "error" ? 2300 : 1400); if (run !== revision) return;
  if (advance()) return;
  phase.value = "closing";
  const target = props.returnTarget?.getBoundingClientRect();
  const width = target?.width || 220, height = target?.height || 92;
  const scale = Math.min(1, width / 330, height / 92);
  const textTransform = `translate(${(width - 330 * scale) / 2}px, ${(height - 92 * scale) / 2}px) scale(${scale})`;
  await Promise.all([
    animate(island.value, [{ width: "330px", height: "92px" }, { width: `${width}px`, height: `${height}px` }], 420),
    animate(shell.value, [{ height: "92px" }, { height: `${height}px` }], 420),
    animate(content.value, [{ transform: "none" }, { transform: textTransform }], 420),
    animate(card.value, [{ transform: "translate(-128px,-49px) rotateY(180deg) scale(.23)" }, { transform: "translate(-128px,-49px) rotateY(180deg) scale(0)" }], 420),
  ]);
  if (run !== revision) return;
  // The frame has returned before the old and new text crossfade.
  phase.value = "restoring";
  emit("returning", id);
  await nextTick(); if (run !== revision) return;
  await animate(content.value, [{ opacity: 1 }, { opacity: 0 }], 240, "ease-in-out");
  if (run === revision) emit("settled", id);
}
watch(() => props.activity.id, (_id, previous) => { void (previous === undefined ? open() : continueActivity()); }, { immediate: true, flush: "post" });
watch(() => props.activity.status, status => { if (status !== "running") void finish(); });
watch(() => props.pending, pending => { if (pending && ["folding", "compact", "closing", "restoring"].includes(phase.value)) advance(); });
onBeforeUnmount(cleanup);
</script>

<style scoped>
@layer legacy {
.tool-island{position:absolute;right:0;top:0;width:330px;height:92px;z-index:40;color:var(--oak);pointer-events:none;isolation:isolate}
.island-content{position:absolute;left:0;top:0;width:330px;height:92px;transform-origin:0 0}
.island-shell{position:absolute;inset:0 0 auto;height:92px;--lattice-corner-inset:-1px;background:var(--surface-1);box-shadow:0 18px 48px #0009;backdrop-filter:blur(14px)}
.tool-island[data-phase=restoring] .island-shell{visibility:hidden}
.island-stage{position:absolute;inset:0;perspective:850px}
.island-card{position:absolute;left:43px;top:24px;width:244px;height:142px;transform-style:preserve-3d}
.island-outcome{position:absolute;top:197px;left:0;width:100%;display:flex;align-items:center;justify-content:center;gap:9px;font-size:11px;line-height:22px;opacity:0}
.tool-island[data-outcome=error]{color:var(--cyan)}
.island-spinner{width:15px;height:15px;border:1.5px solid var(--line-warm);border-top-color:var(--oak);border-radius:50%;animation:island-spin 1s linear infinite}
.island-check{flex-shrink:0}
.island-check path{stroke-dasharray:1;stroke-dashoffset:0}
.tool-island:is([data-phase=opening],[data-phase=resuming],[data-phase=switching-in]) .island-check path{stroke-dashoffset:1}
.tool-island[data-phase=result] .island-check path{animation:island-check-draw .36s cubic-bezier(.4,0,.2,1) both}
.island-summary{position:absolute;left:76px;right:23px;top:23px;opacity:0;display:flex;flex-direction:column;gap:7px}
.island-summary strong{font-size:11px;font-weight:400;line-height:1.6}
.island-summary>span{font-size:10px;line-height:1.55;color:var(--text-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.island-pending{position:absolute;right:13px;top:10px;font-size:9px;line-height:1.5;color:var(--text-muted)}
.island-announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@keyframes island-spin{to{transform:rotate(360deg)}}
@keyframes island-check-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media(prefers-reduced-motion:reduce){
.island-spinner{animation:none;border-style:dotted}
.tool-island[data-phase=result] .island-check path{animation:none}
.tool-island:is([data-phase=opening],[data-phase=resuming],[data-phase=switching-in]) .island-check path{stroke-dashoffset:0}
}
}
</style>
