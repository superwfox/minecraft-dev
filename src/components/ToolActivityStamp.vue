<template>
  <div class="tool-stamp" :class="{ reverse }">
    <svg class="stamp-dots" viewBox="0 0 244 142" aria-hidden="true">
      <rect x="7" y="7" width="230" height="128" rx="9" fill="none" stroke="currentColor"
            stroke-width="2.6" stroke-linecap="round" pathLength="748" stroke-dasharray="0.01 9.99"/>
    </svg>
    <template v-if="!reverse">
      <div class="stamp-heading"><component :is="icon" :size="15" :stroke-width="1.5"/><span>{{ activity.title }}</span></div>
      <p data-font="dynamic" :title="activity.detail">{{ activity.detail || '正在处理工具请求' }}</p>
      <div class="stamp-meta" data-font="dynamic"><span :title="activity.context">{{ activity.context || labels[activity.kind] }}</span><time>{{ elapsed }}s</time></div>
    </template>
    <template v-else><component :is="icon" :size="36" :stroke-width="1"/><span>{{ labels[activity.kind] }}</span></template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { BookOpen, Search, GitBranch, Hammer, RefreshCw } from "lucide-vue-next";
import type { ToolActivity } from "../logic/toolActivity";
const props = defineProps<{ activity: ToolActivity; elapsed: string; reverse?: boolean }>();
const icons = { skill: BookOpen, learning: Search, tree: GitBranch, build: Hammer, refresh: RefreshCw };
const labels = { skill: "SKILL CONTEXT", learning: "LEARNING", tree: "PROJECT TREE", build: "BUILD", refresh: "STATUS SYNC" };
const icon = computed(() => icons[props.activity.kind]);
</script>

<style scoped>
@layer legacy {
.tool-stamp{position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;padding:21px 23px 19px;border:1px solid rgba(209,200,182,.3);border-radius:10px;background:var(--oak);color:var(--surface-1);box-shadow:0 14px 36px #0006;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden}
.stamp-dots{position:absolute;inset:0;width:100%;height:100%;opacity:.42;pointer-events:none}
.stamp-heading{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:1.5}
.stamp-heading span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-stamp p{margin:0;color:inherit;line-height:1.6;font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:38px;overflow-wrap:anywhere}
.stamp-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:9px;line-height:1.5;opacity:.68;margin-top:auto}
.stamp-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stamp-meta time{flex-shrink:0;font-variant-numeric:tabular-nums}
.tool-stamp.reverse{transform:rotateY(180deg);align-items:center;justify-content:center;gap:9px;background:var(--surface-2);color:var(--oak)}
.reverse>span{font-size:9px;letter-spacing:.16em}
}
</style>
