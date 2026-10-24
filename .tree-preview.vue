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
const planningErrorPreview = new URLSearchParams(window.location.search).has('planning-error-preview');
const mode = ref<'confirm'|'progress'>('confirm'), notice = ref('');
genTask.tree = { ...previewTree, paths: structuredClone(previewPaths), project: { ...previewTree.project, coreType: 'Paper', version: '1.21.4' } };
genTask.coreType = 'Paper'; genTask.version = '1.21.4'; genTask.projectName = 'HomePlus';
genTask.taskId = 'preview-tree-only'; genTask.treeSessionStatus = 'ready';
genTask.treeFocusIds = []; genTask.treeCorrection = ''; genTask.treeIssues = [];
genTask.files = []; genTask.nodeChecks = {}; genTask.pathChecks = {}; genTask.buildDiagnostics = [];
genTask.phase = 'tree_confirming'; treeGateWaiting.value = true;
if (planningErrorPreview) {
  genTask.tree.status = 'drafting'; genTask.tree.paths = [];
  genTask.tree.nodes = genTask.tree.nodes.filter(node => node.origin === 'system');
  genTask.treeSessionStatus = 'failed'; genTask.treeRound = 3; genTask.treeToolCallCount = 2;
  genTask.treeIssues = [
    { code: 'NO_BUSINESS_NODE', message: '请添加业务文件节点' },
    { code: 'NO_BEHAVIOR_PATH', message: '请按需求添加行为路径与步骤，并绑定实现文件' },
    { code: 'TREE_TOOL_ARGUMENT_INVALID', message: 'upsert_node：contract.events：填写事件类名，如 AsyncChatEvent 或 io.papermc.paper.event.player.AsyncChatEvent，不要填写处理方法名或签名' },
    { code: 'TREE_NO_PROGRESS', message: '连续两轮未产生有效结构变更，已停止继续调用；请查看工具错误后重试修正' },
  ];
  notice.value = '仅演示规划失败与修正入口，不会发起模型或构建请求。';
}
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
