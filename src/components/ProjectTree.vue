<template>
  <section class="project-tree" aria-label="项目行为路径结构树">
    <header class="pt-header"><div><h1 data-font="dynamic">{{ tree?.project.projectName || '正在规划项目' }}</h1><p>{{ genTask.coreType }} {{ genTask.version }} <span>Java {{ tree?.project.javaVersion || genTask.javaVersion }}</span></p></div><ProjectTreeStatusCard :label="statusLabel" :detail="statusDetail" :busy="busy"/></header>
    <slot/>
    <details v-if="genTask.importReport" class="pt-operations" :open="!!genTask.importReport.blockers?.length"><summary>JAR 还原记录 · 基线编译{{ genTask.importReport.baseline?.status === 'passed' ? '通过' : '未通过' }}</summary><p v-for="(blocker, index) in genTask.importReport.blockers || []" :key="index" data-font="dynamic">{{ blocker }}</p><p v-if="genTask.importReport.missingClasses?.length" data-font="dynamic">未还原的类：{{ genTask.importReport.missingClasses.join('、') }}</p></details>
    <div v-if="tree" class="path-viewport">
      <div ref="pathViewport" class="path-map" tabindex="0" aria-label="纵向行为路径，可横向滚动">
        <div class="path-canvas">
          <PathNode :node="rootStep" :caption="tree.project.projectName" root :progress="mode === 'progress'" :expanded="openIds.includes(rootStep.id)" :visited="visitedIds.includes(rootStep.id)" :uses="fileUses" :file-focus="fileFocus" @toggle="toggle" @navigate="navigate"/>
          <div class="path-columns">
            <section v-for="path in paths" :key="path.id" class="path-column" :class="{ 'has-open': path.nodes.some(node => openIds.includes(node.id)), 'is-verified': completedPaths.includes(path.id) }" :aria-label="path.title + '路径'">
              <div v-for="(node, index) in path.nodes" :key="node.id" class="path-step"><PathNode :node="node" :caption="path.title + ' · ' + String(index + 1).padStart(2, '0')" :progress="mode === 'progress'" :review="index === path.nodes.length - 1 ? genTask.pathChecks[path.id] : undefined" :expanded="openIds.includes(node.id)" :visited="visitedIds.includes(node.id)" :uses="fileUses" :file-focus="fileFocus" @toggle="toggle" @navigate="navigate"/></div>
              <PathSparks :verified="genTask.pathChecks[path.id]?.status === 'passed'" @settled="setCompleted(path.id, $event)"/>
            </section>
          </div>
        </div>
      </div>
      <EdgePortal :viewport="pathViewport"/>
    </div>
    <details v-if="mode === 'draft' || genTask.treeOpsLog.length" class="pt-operations"><summary>规划记录 · 第 {{ genTask.treeRound || 1 }} 轮 · {{ genTask.treeToolCallCount }} 项工具调用</summary><p v-for="(operation, index) in genTask.treeOpsLog.slice(-20)" :key="index" data-font="dynamic">{{ operation }}</p></details>
    <div v-if="genTask.preflightActive || mode === 'draft' && (genTask.preflightThinking || genTask.preflightOutput)" class="pt-thinking" :aria-busy="genTask.preflightActive"><details :open="genTask.preflightActive"><summary>结构规划过程</summary><pre data-font="dynamic">{{ genTask.preflightThinking }}{{ genTask.preflightOutput }}</pre></details></div>
    <TreeGate v-if="mode === 'confirm' || ['done', 'error'].includes(genTask.phase)" @decision="$emit('decision', $event)"/>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { genTask } from '../logic/generateState';
import { treeTotals, type TreeStep } from '../logic/projectTree';
import PathNode from './ProjectTreePathNode.vue';
import PathSparks from './ProjectTreePathSparks.vue';
import EdgePortal from './ProjectTreeEdgePortal.vue';
import ProjectTreeStatusCard from './ProjectTreeStatusCard.vue';
import TreeGate from './TreeGate.vue';
const props = defineProps<{ mode: 'draft' | 'confirm' | 'progress' }>();
defineEmits<{ decision: [action: 'confirm' | 'refine'] }>();
const tree = computed(() => genTask.tree);
const paths = computed(() => tree.value?.paths ?? []);
const rootStep = computed<TreeStep>(() => {
  const bound = new Set(paths.value.flatMap(path => path.nodes.flatMap(step => step.fileIds)));
  return { id: 'main-entry', title: 'Main', kind: '插件入口', summary: tree.value?.nodes.find(node => node.id === 'Main')?.responsibility ?? '组织项目入口与需求行为路径', fileIds: (tree.value?.nodes ?? []).filter(node => node.id === 'Main' || !bound.has(node.id)).map(node => node.id) };
});
const steps = computed(() => [rootStep.value, ...paths.value.flatMap(path => path.nodes)]);
const fileUses = computed(() => Object.fromEntries([...new Set(steps.value.flatMap(step => step.fileIds))].map(id => [id, steps.value.filter(step => step.fileIds.includes(id)).length])));
const totals = computed(() => tree.value ? treeTotals(tree.value, genTask.files, genTask.nodeChecks) : { done: 0, total: 0 });
const busy = computed(() => !['idle','done','error','interrupted','tree_confirming','awaiting_input'].includes(genTask.phase));
const statusLabel = computed(() => ({ idle: '等待开始', creating: '创建任务', clarifying: '确认需求', awaiting_input: '等待补充需求', tree_planning: '规划行为路径', tree_confirming: genTask.treeSessionStatus === 'failed' ? '等待修正结构' : '等待确认结构', generating: '生成实现文件', verifying: '按路径检查代码', uploading: '提交构建', building: '等待编译结果', fixing: '修复编译问题', interrupted: '任务已中断', done: '构建完成', error: '任务未完成' }[genTask.phase]));
const statusDetail = computed(() => paths.value.length + ' 条路径 · ' + (steps.value.length - 1) + ' 个步骤 · ' + (props.mode === 'progress' ? totals.value.done + '/' + totals.value.total : totals.value.total) + ' 个文件');
const completedPaths = ref<string[]>([]), openIds = ref<string[]>([]), visitedIds = ref<string[]>([]);
const pathViewport = ref<HTMLElement | null>(null);
const fileFocus = ref({ stepId: '', fileId: '', revision: 0 });
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function setCompleted(id: string, verified: boolean) { completedPaths.value = verified ? [...new Set([...completedPaths.value, id])] : completedPaths.value.filter(pathId => pathId !== id); }
function reveal(id: string) { clearTimeout(revealTimer); if (id === rootStep.value.id) return; revealTimer = setTimeout(() => { if (openIds.value.includes(id)) document.getElementById('step-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); }, 300); }
function toggle(id: string) { if (!visitedIds.value.includes(id)) visitedIds.value.push(id); openIds.value = openIds.value.includes(id) ? openIds.value.filter(open => open !== id) : [...openIds.value, id]; reveal(id); }
async function navigate(fileId: string) { const step = steps.value.find(step => openIds.value.includes(step.id) && step.fileIds.includes(fileId)) ?? steps.value.find(step => step.fileIds.includes(fileId)); if (!step) return; fileFocus.value = { stepId: step.id, fileId, revision: fileFocus.value.revision + 1 }; if (!visitedIds.value.includes(step.id)) visitedIds.value.push(step.id); if (!openIds.value.includes(step.id)) openIds.value.push(step.id); await nextTick(); document.getElementById('step-' + step.id)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); reveal(step.id); }
onBeforeUnmount(() => clearTimeout(revealTimer));
</script>

<style scoped>
@layer legacy {
.project-tree{min-width:0;color:var(--text-primary)}.pt-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:26px 0;border-bottom:1px solid var(--line-soft)}.pt-header h1{margin:0 0 8px;font-size:25px;font-weight:400;line-height:1.3}.pt-header p{margin:0;color:var(--text-secondary);font-size:11px}.pt-header p>span{margin-left:14px}.pt-operations,.pt-thinking{margin:12px 0;padding:12px 16px;border:1px solid var(--line-soft);font-size:11px;color:var(--text-secondary);line-height:1.8}.pt-operations summary,.pt-thinking summary{cursor:pointer}.pt-operations p{margin:4px 0}.pt-thinking pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.path-viewport{position:relative;min-width:0}.path-map{scrollbar-width:none;-ms-overflow-style:none;overflow-x:auto;overflow-y:hidden;padding:32px 0 20px;outline-offset:3px}.path-map::-webkit-scrollbar{display:none;width:0;height:0}.path-canvas{width:max-content;min-width:100%}.path-columns{display:flex;align-items:flex-start;gap:48px}.path-column{position:relative;display:flex;flex-direction:column;gap:44px;flex:1 0 280px;min-width:280px;width:280px;transition:width .28s,flex-basis .28s}.path-column.has-open{width:500px;flex-basis:500px}.path-step{position:relative;min-width:0}.path-step::before{content:'';position:absolute;left:50%;height:44px;bottom:100%;border-left:2px dashed var(--oak)}.path-column.is-verified .path-step::before{border-left-style:solid}.path-step:first-child{margin-top:60px}.path-step:first-child::before{height:60px}
@media(prefers-reduced-motion:reduce){.path-column{transition:none}}
}

</style>
