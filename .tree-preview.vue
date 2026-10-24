<template>
  <main class="preview-page">
    <header class="preview-header"><div><h1 data-font="dynamic">HomePlus</h1><p>Paper 1.21.4 <span>Java 21</span></p></div><ProjectTreeStatusCard :label="demoPath ? '验证动效演示' : mode === 'confirm' ? '等待确认结构' : '生成进度 · 示例'" :detail="demoPath ? '仅演示动画，不代表实际测试结果' : previewPaths.length + ' 条路径 · ' + (steps.length - 1) + ' 个步骤 · ' + boundFileCount + ' 个文件'" :busy="mode === 'progress'"/></header>
    <ToolActivityPreview v-if="toolPreview"/>
    <div class="path-viewport">
    <div ref="pathViewport" class="path-map" tabindex="0" aria-label="纵向行为路径，可横向滚动">
      <div class="path-canvas">
        <PathNode :node="rootStep" caption="HomePlus" root :expanded="openIds.includes(rootStep.id)" :visited="visitedIds.includes(rootStep.id)" :uses="fileUses" :file-focus="fileFocus" @toggle="toggle" @navigate="navigate"/>
        <div class="path-columns">
          <section v-for="path in previewPaths" :key="path.id" class="path-column" :class="{ 'has-open': path.nodes.some(node => openIds.includes(node.id)), 'is-verified': completedPaths.includes(path.id) }" :aria-label="path.title + '路径'">
            <div v-for="(node, index) in path.nodes" :key="node.id" class="path-step"><PathNode :node="node" :caption="path.title + ' · 0' + (index + 1)" :expanded="openIds.includes(node.id)" :visited="visitedIds.includes(node.id)" :uses="fileUses" :file-focus="fileFocus" @toggle="toggle" @navigate="navigate"/></div>
            <PathSparks :verified="path.testStatus === 'passed'" @settled="setCompleted(path.id, $event)"/>
          </section>
        </div>
      </div>
    </div>
    <EdgePortal :viewport="pathViewport"/>
    </div>
    <TreeGate v-if="mode === 'confirm'" @decision="onDecision"/>
    <p v-if="notice" class="preview-notice" role="status">{{ notice }}</p>
  </main>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import PathNode from "./.tree-path-node.vue";
import PathSparks from "./.tree-path-sparks.vue";
import EdgePortal from "./.tree-edge-portal.vue";
import TreeGate from "./src/components/TreeGate.vue";
import ProjectTreeStatusCard from "./src/components/ProjectTreeStatusCard.vue";
import ToolActivityPreview from "./.tool-activity-preview.vue";
import { genTask, treeGateWaiting } from "./src/logic/generateState";
import { previewPaths as pathFixtures, previewTree, rootStep } from "./.tree-preview-model";
const previewPaths = reactive(pathFixtures.map(path => ({ ...path })));
const toolPreview = new URLSearchParams(window.location.search).has("tool-preview");
const demoId = new URLSearchParams(window.location.search).get("verification-preview");
const demoPath = previewPaths.find(path => path.id === demoId);
const completedPaths = ref(previewPaths.filter(path => path.testStatus === "passed").map(path => path.id));
function setCompleted(id: string, verified: boolean) { completedPaths.value = verified ? [...new Set([...completedPaths.value, id])] : completedPaths.value.filter(pathId => pathId !== id); }
const mode = ref<"confirm" | "progress">("confirm"), notice = ref("");
const openIds = ref<string[]>([]), visitedIds = ref<string[]>([]);
const pathViewport = ref<HTMLElement | null>(null);
const fileFocus = ref({ stepId: "", fileId: "", revision: 0 });
const steps = [rootStep, ...previewPaths.flatMap(path => path.nodes)];
const fileUses = Object.fromEntries([...new Set(steps.flatMap(step => step.fileIds))].map(id => [id, steps.filter(step => step.fileIds.includes(id)).length]));
const boundFileCount = Object.keys(fileUses).length;
genTask.tree = { ...previewTree, project: { ...previewTree.project, coreType: "Paper", version: "1.21.4" } };
genTask.coreType = "Paper"; genTask.version = "1.21.4"; genTask.projectName = "HomePlus";
genTask.taskId = "preview-tree-only"; genTask.treeSessionStatus = "ready";
genTask.treeFocusIds = []; genTask.treeCorrection = ""; genTask.treeIssues = [];
genTask.files = []; genTask.nodeChecks = {}; genTask.buildDiagnostics = [];
genTask.phase = "tree_confirming"; treeGateWaiting.value = true;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
function reveal(id: string) { clearTimeout(revealTimer); if (id === rootStep.id) return; revealTimer = setTimeout(() => { if (openIds.value.includes(id)) document.getElementById("step-" + id)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }); }, 300); }
function toggle(id: string) { if (!visitedIds.value.includes(id)) visitedIds.value.push(id); openIds.value = openIds.value.includes(id) ? openIds.value.filter(open => open !== id) : [...openIds.value, id]; reveal(id); }
async function navigate(fileId: string) { const step = steps.find(step => openIds.value.includes(step.id) && step.fileIds.includes(fileId)) ?? steps.find(step => step.fileIds.includes(fileId)); if (!step) return; fileFocus.value = { stepId: step.id, fileId, revision: fileFocus.value.revision + 1 }; if (!visitedIds.value.includes(step.id)) visitedIds.value.push(step.id); if (!openIds.value.includes(step.id)) openIds.value.push(step.id); await nextTick(); document.getElementById("step-" + step.id)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); reveal(step.id); }
onBeforeUnmount(() => clearTimeout(revealTimer));
let demoTimer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => { if (demoPath) demoTimer = setTimeout(() => { demoPath.testStatus = "passed"; }, 1200); });
onBeforeUnmount(() => clearTimeout(demoTimer));
function onDecision(action: "confirm" | "refine") {
  if (action === "confirm") { mode.value = "progress"; genTask.tree!.status = "locked"; notice.value = "确认交互演示完成。当前为行为路径预览，尚未调用模型生成文件。"; }
  else { notice.value = `已收集修正：${genTask.treeCorrection}。当前仅预览，不会调用模型。`; treeGateWaiting.value = true; }
}
</script>

<style>
@layer legacy {
*{box-sizing:border-box}body{margin:0}button{font:inherit}.preview-page{max-width:1440px;padding:0 40px 156px;margin:0 auto;color:var(--text-primary)}.preview-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:26px 0;border-bottom:1px solid var(--line-soft)}.preview-header h1{margin:0 0 8px;font-size:25px;font-weight:400;line-height:1.3}.preview-header p{margin:0;color:var(--text-secondary);font-size:11px}.preview-header p>span{margin-left:14px}.path-viewport{position:relative;min-width:0}.path-map{scrollbar-width:none;-ms-overflow-style:none;overflow-x:auto;overflow-y:hidden;padding:32px 0 20px;outline-offset:3px}.path-map::-webkit-scrollbar{display:none;width:0;height:0}.path-canvas{width:max-content;min-width:100%}.path-columns{display:flex;align-items:flex-start;gap:48px}.path-column{position:relative;display:flex;flex-direction:column;gap:44px;flex:1 0 280px;min-width:280px;width:280px;transition:width .28s,flex-basis .28s}.path-column.has-open{width:500px;flex-basis:500px}.path-step{position:relative;min-width:0}.path-step::before{content:'';position:absolute;left:50%;height:44px;bottom:100%;border-left:2px dashed var(--oak)}.path-column.is-verified .path-step::before{border-left-style:solid}.path-step:first-child{margin-top:60px}.path-step:first-child::before{height:60px}.preview-notice{margin:16px 0;padding:10px 14px;border:1px solid var(--line-warm);color:var(--oak);font-size:11px;line-height:1.8}
@media(prefers-reduced-motion:reduce){.path-column{transition:none}}
}

</style>
