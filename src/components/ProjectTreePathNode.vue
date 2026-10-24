<template>
  <article :id="'step-' + node.id" class="path-node" :class="{ 'is-open': expanded, 'is-root': root }">
    <div v-lattice:card class="path-card" :aria-busy="progress && stateLabel === '生成中'">
      <button type="button" class="path-node-open" :aria-label="node.title + '，展开节点'" :aria-expanded="expanded" :aria-controls="'step-details-' + node.id" @click="$emit('toggle', node.id)">
        <span class="path-eyebrow"><span data-font="dynamic">{{ caption }}</span><span>{{ node.kind }}<template v-if="progress"> · {{ stateLabel }}</template></span></span>
        <strong data-font="dynamic">{{ node.title }}</strong>
        <span class="path-summary" data-font="dynamic">{{ node.summary }}</span>
        <span class="path-bindings"><FileCode2 :size="13" aria-hidden="true"/><span data-font="dynamic">{{ fileNames.join(' · ') }}</span><ChevronDown :size="13" class="path-chevron" aria-hidden="true"/></span>
      </button>
      <div :id="'step-details-' + node.id" class="path-expansion" :inert="!expanded" :aria-hidden="!expanded"><div class="path-expansion-inner">
        <div v-if="visited" class="path-details">
          <p v-if="review" class="path-summary" data-font="dynamic">静态审查：{{ review.staticStatus === 'passed' ? '通过' : review.staticStatus === 'failed' ? '未通过' : '待检查' }} · 编译：{{ review.compileStatus === 'passed' ? '通过' : review.compileStatus === 'failed' ? '失败' : '待完成' }}<br>{{ review.summary }}</p>
          <ul v-if="review?.steps.length" class="path-summary"><li v-for="step in review.steps" :key="step.id" data-font="dynamic">{{ step.passed ? '✓' : '·' }} {{ step.detail }}</li></ul>
          <div class="path-files-label">绑定实现文件 <span>{{ node.fileIds.length }}</span></div>
          <div class="path-file-tabs" aria-label="实现文件"><button v-for="id in node.fileIds" :key="id" type="button" :aria-pressed="activeFile === id" :aria-label="'查看 ' + fileName(id) + '，' + node.title" data-font="dynamic" @click="activeFile = id">{{ fileName(id) }}<span v-if="(uses[id] || 0) > 1" class="path-shared">{{ uses[id] }} 处复用</span></button></div>
          <ProjectTreeNodeDetails v-if="activeFile" :node-id="activeFile" @navigate="navigate"/>
        </div>
      </div></div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, FileCode2 } from "lucide-vue-next";
import ProjectTreeNodeDetails from "./ProjectTreeNodeDetails.vue";
import { genTask } from "../logic/generateState";
import type { TreeStep, PathCheck } from "../logic/projectTree";
const props = defineProps<{ node: TreeStep; caption: string; expanded: boolean; visited: boolean; uses: Record<string, number>; root?: boolean; progress?: boolean; review?: PathCheck; fileFocus?: { stepId: string; fileId: string; revision: number } }>();
const emit = defineEmits<{ toggle: [id: string]; navigate: [id: string] }>();
const activeFile = ref(props.node.fileIds[0]);
function fileName(id: string) { return genTask.tree?.nodes.find(node => node.id === id)?.path.split("/").at(-1) ?? id; }
const fileNames = computed(() => props.node.fileIds.map(fileName));
const stateLabel = computed(() => {
  const files = props.node.fileIds.map(id => genTask.files.find(file => file.nodeId === id || file.path === genTask.tree?.nodes.find(node => node.id === id)?.path));
  if (files.some(file => file?.status === 'error')) return '待修复';
  if (files.some(file => file?.status === 'generating')) return '生成中';
  return files.length && files.every(file => file?.status === 'done') ? '已生成' : '待生成';
});
watch(() => props.node.fileIds, ids => { if (!ids.includes(activeFile.value)) activeFile.value = ids[0]; });
watch(() => props.fileFocus, focus => { if (focus?.stepId === props.node.id && props.node.fileIds.includes(focus.fileId)) activeFile.value = focus.fileId; });
function navigate(id: string) { if (props.node.fileIds.includes(id)) activeFile.value = id; else emit("navigate", id); }
</script>

<style scoped>
@layer legacy {
.path-node{position:relative;min-width:0;width:100%}.path-card{transform:translateZ(0);width:100%;min-width:0;transition:background .2s}.path-node-open{display:flex;flex-direction:column;align-items:stretch;gap:9px;width:100%;min-height:190px;padding:23px 25px 24px;text-align:left;font:inherit;color:var(--text-primary);background:transparent;border:0;cursor:pointer}.path-eyebrow{display:flex;align-items:center;gap:10px;font-size:10px;line-height:1.6;color:var(--text-muted)}.path-eyebrow>span:last-child{color:var(--oak)}.path-node-open>strong{font-size:15px;font-weight:400;line-height:1.6;overflow-wrap:anywhere}.path-summary{font-size:11px;line-height:1.8;color:var(--text-secondary);overflow-wrap:anywhere}.path-bindings{display:flex;align-items:flex-start;gap:7px;font-size:10px;line-height:1.8;color:var(--text-muted);margin-top:auto}.path-bindings>span{min-width:0;overflow-wrap:anywhere}.path-bindings>svg{flex:none;margin-top:3px;color:var(--oak)}.path-bindings .path-chevron{margin-left:auto;transition:transform .28s}.is-open .path-chevron{transform:rotate(180deg)}.path-node button:focus-visible{outline:1px solid var(--oak);outline-offset:3px}.path-expansion{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .28s ease,opacity .2s}.is-open .path-expansion{grid-template-rows:1fr;opacity:1}.path-expansion-inner{overflow:hidden;min-height:0}.path-details{padding:0 22px 14px}.path-files-label{border-top:1px solid var(--line-soft);padding-top:13px;font-size:11px;color:var(--text-secondary)}.path-files-label>span{margin-left:8px;color:var(--text-muted);font-size:10px}.path-file-tabs{display:flex;flex-wrap:wrap;gap:4px 14px;margin:7px 0 3px}.path-file-tabs>button{display:flex;align-items:center;gap:7px;padding:7px 0;border:0;border-bottom:1px solid transparent;background:transparent;font-size:11px;line-height:1.8;color:var(--text-muted);text-align:left;cursor:pointer;overflow-wrap:anywhere;min-width:0;max-width:100%;flex-wrap:wrap}.path-file-tabs>button[aria-pressed=true]{color:var(--oak);border-bottom-color:var(--oak)}.path-shared{font-size:9px;color:var(--text-muted);white-space:nowrap}.path-details :deep(.node-details){padding:3px 0 10px}.is-root .path-node-open{display:grid;grid-template-columns:160px minmax(0,1fr);align-items:center;column-gap:24px;row-gap:7px;min-height:128px;padding:24px 30px}.is-root .path-eyebrow{grid-column:1;grid-row:1;padding:0}.is-root .path-node-open>strong{grid-column:1;grid-row:2;font-size:25px}.is-root .path-summary{grid-column:2;grid-row:1;padding-right:30px}.is-root .path-bindings{grid-column:2;grid-row:2;margin:0}.is-root .path-details{padding-inline:30px}
@media(prefers-reduced-motion:reduce){.path-expansion,.path-chevron,.path-card{transition:none}}
}
@layer lattice {
/* The motif joins the card's own perimeter. No inset frame or surrounding card. */
.path-card{--lattice-corner-inset:-1px;--lattice-edge:var(--line-warm)}.path-card:hover,.is-open>.path-card{--lattice-edge:var(--oak)}.path-card :deep(.lattice-corner rect:not(.lattice-side)){y:1px}.path-card :deep(.lattice-corner rect.lattice-side){x:1px}.path-card :deep(.lattice-corner){width:64px;height:64px}
}
</style>
