<template>
  <section class="activity-demo" aria-label="工具动画模拟预览">
    <div class="activity-demo-heading"><strong>工具动画预览</strong><span>模拟事件 · 不会调用模型或工具</span></div>
    <div class="activity-demo-actions">
      <button v-for="kind in kinds" :key="kind" v-lattice @click="start(kind)">{{ samples[kind].title }}</button>
    </div>
    <div class="activity-demo-actions">
      <span>{{ active ? '按开始顺序提交单个任务结果' : '选择一种调用，查看持续加载与收拢效果' }}</span>
      <button v-lattice :disabled="!active" title="按开始顺序完成一项模拟调用" @click="finish('success')">完成</button>
      <button v-lattice :disabled="!active" @click="finish('error')">失败</button>
      <button v-lattice :disabled="!active" @click="finish('cancelled')">取消</button>
      <button v-lattice @click="burst">连续刷新 × 5</button>
      <button v-lattice @click="reset">重置演示</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { beginToolActivity, cancelToolActivities, type ToolActivityHandle, type ToolActivityKind } from "./src/logic/toolActivity";
const kinds: ToolActivityKind[] = ["skill", "learning", "tree", "build", "refresh"];
const samples = {
  skill: { title: "装载 Skill 上下文", detail: "载入区域保护与交互选地能力", context: "2 个 Skill", summary: "已装载 2/2 个 Skill" },
  learning: { title: "Learning 公共 API 查证", detail: "查证 Paper 1.21.4 的方块交互事件与取消规则", context: "2/3 项查证 · 4 条证据", summary: "查证完成 · 6 条公共 API 证据" },
  tree: { title: "修正结构树", detail: "调整选地入口，复用框选逻辑并更新实现文件绑定", context: "3 个节点 · 2 条行为路径", summary: "已更新 3 个节点 · 复用框选逻辑" },
  build: { title: "启动编译", detail: "提交 HomePlus 构建请求，等待服务端确认", context: "Paper 1.21.4 · Java 21", summary: "构建请求已确认 · 等待构建结果" },
  refresh: { title: "刷新任务状态", detail: "同步服务端最新进度与结构版本", context: "HomePlus · 状态同步", summary: "状态已同步 · 构建仍在进行" },
};
const active = ref(false);
let handles: { handle: ToolActivityHandle; kind: ToolActivityKind }[] = [];
function start(kind: ToolActivityKind) { handles.push({ handle: beginToolActivity({ kind, ...samples[kind], refreshKey: "preview" }), kind }); active.value = true; }
function finish(status: "success" | "error" | "cancelled") {
  const current = handles.shift();
  if (!current) return;
  const { handle, kind } = current;
  handle.finish(status, status === "success" ? samples[kind].summary
    : status === "cancelled" ? "调用已取消，保留已有结果" : "工具暂时不可用，请稍后重试（模拟失败）");
  active.value = handles.length > 0;
}
function burst() { for (let i = 0; i < 5; i++) { const handle = beginToolActivity({ kind: "refresh", ...samples.refresh, refreshKey: "preview" }); handle.finish("success", "状态已同步 · 频繁刷新已合并"); } }
function reset() { cancelToolActivities(true); handles = []; active.value = false; }
onBeforeUnmount(reset);
</script>

<style scoped>
@layer legacy {
.activity-demo{padding:20px 0 22px;border-bottom:1px solid var(--line-soft);display:flex;flex-direction:column;gap:17px}
.activity-demo-heading{display:flex;align-items:center;gap:16px;font-size:12px}.activity-demo-heading strong{font-weight:400}
.activity-demo-heading>span,.activity-demo-actions>span{font-size:10px;color:var(--text-muted);line-height:1.7}
.activity-demo-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.activity-demo-actions button{font-size:11px;min-height:44px;padding:12px 17px}
.activity-demo-actions>span{flex:1 1 180px}.activity-demo-actions button:disabled{opacity:.35;cursor:default}
}
</style>
