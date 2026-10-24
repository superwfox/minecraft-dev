<template>
  <main class="preview-page"><GenerateProgress v-if="businessPreview"/><ProjectTree v-else :mode="mode" @decision="onDecision"><ToolActivityPreview v-if="toolPreview"/></ProjectTree><p v-if="notice" class="preview-notice" role="status">{{ notice }}</p></main>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ProjectTree from './src/components/ProjectTree.vue';
import GenerateProgress from './src/components/GenerateProgress.vue';
import ToolActivityPreview from './.tool-activity-preview.vue';
import { genTask, treeGateWaiting } from './src/logic/generateState';
import { previewPaths, previewTree } from './.tree-preview-model';
const businessPreview = new URLSearchParams(window.location.search).has('business-preview');
const toolPreview = new URLSearchParams(window.location.search).has('tool-preview');
const demoId = new URLSearchParams(window.location.search).get('verification-preview');
const mode = ref<'confirm'|'progress'>('confirm'), notice = ref('');
genTask.tree = { ...previewTree, paths: structuredClone(previewPaths), project: { ...previewTree.project, coreType: 'Paper', version: '1.21.4' } };
genTask.coreType = 'Paper'; genTask.version = '1.21.4'; genTask.projectName = 'HomePlus';
genTask.taskId = 'preview-tree-only'; genTask.treeSessionStatus = 'ready';
genTask.treeFocusIds = []; genTask.treeCorrection = ''; genTask.treeIssues = [];
genTask.files = []; genTask.nodeChecks = {}; genTask.pathChecks = {}; genTask.buildDiagnostics = [];
genTask.phase = 'tree_confirming'; treeGateWaiting.value = true;
let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => { if (previewPaths.some(path => path.id === demoId)) timer = setTimeout(() => { genTask.pathChecks[demoId!] = { pathId: demoId!, status: 'passed', staticStatus: 'passed', compileStatus: 'passed', summary: '仅演示验证动效，不代表真实检查结果', steps: [] }; notice.value = '仅演示验证动效，不代表实际静态审查或编译结果。'; }, 1200); });
onBeforeUnmount(() => clearTimeout(timer));
function onDecision(action: 'confirm'|'refine') { if (action === 'confirm') { mode.value = 'progress'; genTask.tree!.status = 'locked'; notice.value = '确认交互演示完成。当前为行为路径预览，尚未调用模型生成文件。'; } else { notice.value = '已收集修正：' + genTask.treeCorrection + '。当前仅预览，不会调用模型。'; treeGateWaiting.value = true; } }
</script>
<style>
@layer legacy {
*{box-sizing:border-box}body{margin:0}button{font:inherit}.preview-page{max-width:1440px;padding:0 40px 156px;margin:0 auto;color:var(--text-primary)}.preview-notice{margin:16px 0;padding:10px 14px;border:1px solid var(--line-warm);color:var(--oak);font-size:11px;line-height:1.8}
}
</style>
