<template>
  <article class="pt-node" :class="[status.status, { expanded, selected: genTask.treeFocusIds.includes(node.id) }]">
    <div v-lattice:card class="pt-node-frame" :aria-busy="mode === 'progress' && status.status === 'generating'">
      <div class="pt-node-row">
        <button type="button" class="pt-node-open" :aria-expanded="expanded" :aria-controls="'node-details-' + node.id" @click="$emit('toggle', node.id)">
          <span class="pt-file-type"><FileCode2 v-if="node.fqcn" :size="16" aria-hidden="true"/><FileText v-else :size="16" aria-hidden="true"/>{{ generatorLabels[node.kind] }}</span>
          <strong data-font="dynamic">{{ node.id }}</strong><span class="pt-node-title" data-font="dynamic">{{ node.title }}</span>
          <span class="pt-node-meta"><span v-if="node.tag === 'gui'" class="pt-badge">GUI</span><span v-if="node.origin === 'review'" class="pt-badge">审查追加</span><span v-if="status.buildError" class="pt-badge pt-error-badge">编译错误</span><span v-if="mode === 'progress'" class="pt-state-label"><i/>{{ stateLabels[status.status] }}</span><span class="pt-contract-count">{{ contractLabel }}</span><ChevronDown :size="13" class="pt-chevron" aria-hidden="true"/></span>
        </button>
        <button v-if="mode === 'confirm'" type="button" class="pt-select" :aria-label="(genTask.treeFocusIds.includes(node.id) ? '取消选择 ' : '选择 ') + node.id" :aria-pressed="genTask.treeFocusIds.includes(node.id)" @click="$emit('select', node.id)"><Check v-if="genTask.treeFocusIds.includes(node.id)" :size="13"/><Square v-else :size="13"/></button>
      </div>
      <div :id="'node-details-' + node.id" class="pt-node-expansion" :inert="!expanded" :aria-hidden="!expanded"><div class="pt-node-expansion-inner"><ProjectTreeNodeDetails v-if="visited" :node-id="node.id" @navigate="$emit('navigate', $event)"/></div></div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Check, ChevronDown, FileCode2, FileText, Square } from "lucide-vue-next";
import { genTask } from "../logic/generateState";
import { generatorLabels, nodeStatusOf, type TreeNodeView } from "../logic/projectTree";
import ProjectTreeNodeDetails from "./ProjectTreeNodeDetails.vue";
const props = defineProps<{ node: TreeNodeView; mode: "draft" | "confirm" | "progress"; expanded: boolean; visited: boolean }>();
defineEmits<{ toggle: [id: string]; select: [id: string]; navigate: [id: string] }>();
const status = computed(() => nodeStatusOf(props.node, genTask.files, genTask.nodeChecks, genTask.buildDiagnostics));
const stateLabels = { pending: "待生成", generating: "生成中", done: "已完成", error: "待修复" };
const contractLabel = computed(() => { const check = genTask.nodeChecks[props.node.id]; return check ? check.total ? check.passed + "/" + check.total : "无契约" : props.node.id === "pom.xml" ? "无契约" : "待核对"; });
</script>

<style scoped>
@layer legacy {
.pt-node{position:relative;min-width:0;width:100%;--lattice-corner-inset:14px}.pt-node-frame{min-width:0;transition:border-color .2s,background .2s}.pt-node-frame:hover{border-color:var(--oak-hover)}.pt-node.expanded .pt-node-frame,.pt-node.selected .pt-node-frame{border-color:var(--oak)}.pt-node.generating .pt-node-frame{border-color:var(--cyan)}.pt-node-row{position:relative;min-width:0;min-height:152px}.pt-node-open{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;width:100%;min-width:0;min-height:152px;text-align:left;padding:24px 28px;background:transparent;border:0;color:var(--text-primary);font:inherit;cursor:pointer}.pt-file-type{display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:10px;line-height:1.6;padding-right:10px}.pt-file-type svg{color:var(--oak);flex:none}.pt-node-open>strong{width:100%;font-size:12px;font-weight:500;line-height:1.6;overflow-wrap:anywhere}.pt-node-title{font-size:11px;color:var(--text-secondary);line-height:1.6;overflow-wrap:anywhere}.pt-node-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;font-size:10px;color:var(--text-muted);line-height:1.6}.pt-contract-count{margin-left:auto;white-space:nowrap}.pt-chevron{flex:none;transition:transform .25s}.pt-node.expanded .pt-chevron{transform:rotate(180deg)}.pt-select{position:absolute;top:16px;right:16px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;flex:none;padding:6px;background:transparent;border:1px solid var(--line-soft);color:var(--text-muted);cursor:pointer;z-index:3}.pt-select[aria-pressed=true]{color:var(--oak);border-color:var(--line-warm);background:var(--oak-soft)}.pt-node-open:focus-visible,.pt-select:focus-visible{outline:1px solid var(--oak);outline-offset:3px}.pt-state-label{display:flex;align-items:center;gap:5px}.pt-state-label i{height:5px;width:5px;border-radius:50%;background:var(--line-strong);flex:none}.done .pt-state-label i{background:var(--oak)}.generating .pt-state-label i,.error .pt-state-label i{background:var(--cyan)}.generating .pt-state-label i{animation:pt-pulse 1.5s infinite}.pt-badge{font-size:9px;line-height:1.4;padding:3px 6px;border:1px solid var(--line-warm);color:var(--oak)}.pt-error-badge{border-color:var(--cyan);color:var(--cyan)}.pt-node-expansion{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s ease,opacity .2s;opacity:0}.pt-node.expanded .pt-node-expansion{grid-template-rows:1fr;opacity:1}.pt-node-expansion-inner{min-height:0;overflow:hidden}
@keyframes pt-pulse{50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.pt-node-expansion,.pt-chevron,.pt-node-frame{transition:none}.pt-state-label i{animation:none!important}}
}
</style>
