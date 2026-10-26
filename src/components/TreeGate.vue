<template>
  <Teleport to="body">
    <section v-if="treeGateWaiting || terminal" ref="dock" class="tree-gate" :class="{ expanded }" aria-label="结构修正与确认">
      <div v-lattice:one class="tg-shell">
        <div class="tg-expansion" :inert="!expanded" :aria-hidden="!expanded"><div class="tg-expansion-inner"><div class="tg-details">
          <div class="tg-details-head"><span>调整结构</span><button type="button" class="tg-collapse" aria-label="收起修正详情" @click="expanded = false"><ChevronDown :size="14"/></button></div>
          <p v-if="error" class="tg-hint" role="alert">{{ error }}</p><p class="tg-hint">直接描述要调整的步骤或路径，模型会定位修改范围。</p>
          <div v-if="!terminal && genTask.treeChanges" class="tg-hint" data-font="dynamic"><p>新增：{{ genTask.treeChanges.added.join('、') || '无' }}</p><p>修改及影响：{{ genTask.treeChanges.affected.join('、') || '无' }}</p><p>删除：{{ genTask.treeChanges.removed.join('、') || '无' }}</p></div>
          <div v-if="genTask.treeSessionStatus === 'failed' || genTask.treeIssues.length" class="tg-issues"><span>请先修正以下问题</span><ul><li v-for="(issue, index) in genTask.treeIssues" :key="index" data-font="dynamic">{{ issue.message }}</li></ul></div>
          <div class="tg-modify-row"><span>修正意见 <small>{{ genTask.treeCorrection.length }}/1000</small></span><button v-lattice:two type="button" class="tg-modify" :disabled="!genTask.treeCorrection.trim()" @click="refine"><ArrowUp :size="13"/>开始修改</button></div>
        </div></div></div>
        <div class="tg-input-row"><label for="tree-correction" class="tg-sr-only">修正意见</label><textarea id="tree-correction" v-model="genTask.treeCorrection" maxlength="1000" rows="1" placeholder="描述要调整的地方…" :aria-expanded="expanded" @focus="expanded = true" @click="expanded = true"/><button v-lattice type="button" class="tg-confirm" :disabled="terminal ? busy || !genTask.treeCorrection.trim() : !canConfirm" @click="confirm"><Check :size="14" aria-hidden="true"/><span>{{ terminal ? "提交修改需求" : "确认结构并开始生成" }}</span></button></div>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowUp, Check, ChevronDown } from "lucide-vue-next";
import { genTask, submitTreeConfirm, submitTreeRefine, treeGateWaiting } from "../logic/generateState";
import { reviseProject } from "../logic/generateHandler";
const terminal = computed(() => ["done", "error"].includes(genTask.phase));
const busy = ref(false), error = ref("");
const emit = defineEmits<{ decision: [action: "confirm" | "refine"] }>();
const expanded = ref(false), dock = ref<HTMLElement | null>(null);
const canConfirm = computed(() => genTask.tree?.status === "ready" && genTask.treeSessionStatus === "ready" && !genTask.treeIssues.length);
async function refine() { if (!genTask.treeCorrection.trim() || busy.value) return; if (terminal.value) { busy.value = true; error.value = ""; try { await reviseProject(genTask.treeCorrection.trim()); } catch (e) { error.value = String(e); } finally { busy.value = false; } return; } expanded.value = false; submitTreeRefine(genTask.treeCorrection.trim(), []); emit("decision", "refine"); }
function confirm() { if (terminal.value) { refine(); return; } if (!canConfirm.value) return; expanded.value = false; submitTreeConfirm(); emit("decision", "confirm"); }
function outside(event: PointerEvent) { if (dock.value && event.target instanceof Node && !dock.value.contains(event.target)) expanded.value = false; }
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
</script>

<style scoped>
@layer legacy {
.tree-gate{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);width:min(1060px,calc(100% - 64px));z-index:1100;color:var(--text-primary)}.tg-shell{--lattice-corner-inset:10px;padding:10px;box-shadow:0 0 0 10px var(--surface-0),0 -14px 35px 12px rgba(0,0,0,.8)}.tg-input-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:stretch}.tree-gate textarea{display:block;width:100%;box-sizing:border-box;resize:none;min-height:48px;height:48px;max-height:150px;padding:13px 15px;line-height:20px;font-size:12px;background:var(--surface-0);border:1px solid var(--line);border-radius:0;color:var(--text-primary);transition:height .24s ease}.tree-gate.expanded textarea{height:90px}.tree-gate textarea::placeholder{color:var(--text-muted)}.tree-gate textarea:focus-visible{outline:1px solid var(--oak);outline-offset:2px}.tg-confirm{align-self:end;min-height:48px;gap:9px;padding:12px 18px;white-space:nowrap;font-size:12px}.tg-expansion{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .24s ease,opacity .16s}.tree-gate.expanded .tg-expansion{grid-template-rows:1fr;opacity:1}.tg-expansion-inner{overflow:hidden;min-height:0}.tg-details{padding:4px 5px 12px}.tg-details-head{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11px}.tg-details small{font-size:10px;color:var(--text-muted);margin-left:9px}.tg-collapse{display:inline-flex;align-items:center;justify-content:center;padding:5px 7px;min-height:26px;gap:6px;font:inherit;font-size:10px;color:var(--text-muted);background:transparent;border:1px solid transparent;cursor:pointer}.tg-collapse:hover{border-color:var(--line);color:var(--text-primary)}.tg-hint{margin:5px 0 8px;font-size:10px;color:var(--text-muted);line-height:1.8}.tg-modify-row{padding-right:10px;display:flex;justify-content:space-between;align-items:center;gap:14px;font-size:11px;margin-top:9px}.tg-modify{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:64px;padding:14px 20px;--lattice-corner-inset:-1px;color:var(--text-primary);font:inherit;font-size:11px;line-height:1.5;cursor:pointer}.tg-modify:disabled{opacity:.35;cursor:not-allowed}.tg-issues{margin:9px 0;padding:9px 12px;border:1px solid var(--cyan);font-size:10px;color:var(--cyan);line-height:1.8;max-height:120px;overflow:auto}.tg-issues ul{padding-left:16px;margin:5px 0 0}.tg-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.tree-gate button:focus-visible{outline:1px solid var(--oak);outline-offset:3px}
@media(prefers-reduced-motion:reduce){.tg-expansion,.tree-gate textarea{transition:none}}
}
@layer lattice {
.tg-shell > :deep(.lattice-corner:not(.lattice-end)){top:-1px;left:-1px}
}
</style>
