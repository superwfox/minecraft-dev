<template>
  <div v-if="node" class="node-details" role="region" :aria-label="node.id + ' 详情'">
    <div class="nd-path"><span>Path</span><code data-font="dynamic">{{ node.path }}</code><button type="button" :aria-label="'复制 ' + node.id + ' 的路径'" @click="copy(node.path)"><Check v-if="copied === 'path'" :size="13"/><Copy v-else :size="13"/></button></div>
    <p class="nd-responsibility" data-font="dynamic">{{ node.responsibility }}</p>
    <div class="nd-dependencies"><span>依赖</span><template v-if="node.depends.length"><button v-for="id in node.depends" :key="id" type="button" data-font="dynamic" @click="$emit('navigate', id)">{{ id }}<ArrowUpRight :size="11"/></button></template><span v-else class="nd-muted">无</span></div>
    <div class="nd-contract-header"><h4>Node contract <span>接口与实现约定</span></h4><span>{{ check ? check.total ? check.passed + '/' + check.total + ' 通过' : '无检查项' : '待生成' }}</span></div>
    <ul v-if="checklist.length" class="nd-contracts"><li v-for="(item, index) in checklist" :key="index" :class="{ passed: item.ok === true, failed: item.ok === false }"><Check v-if="item.ok === true" :size="12"/><CircleAlert v-else-if="item.ok === false" :size="12"/><Circle v-else :size="10"/><span data-font="dynamic">{{ item.label }}</span></li></ul><span v-else class="nd-muted nd-empty">无成员约定</span>
    <div class="nd-source-header"><h4>源码</h4><button v-if="code" type="button" aria-label="复制源码" @click="copy(code, 'code')"><Check v-if="copied === 'code'" :size="12"/><Copy v-else :size="12"/>{{ copied === 'code' ? '已复制' : '复制' }}</button></div>
    <pre v-if="code" class="nd-code" data-font="dynamic"><code>{{ code }}</code></pre><p v-else class="nd-placeholder" :aria-busy="loading">{{ loading ? '正在读取源码…' : codeError || '尚未生成' }}<button v-if="codeError" type="button" @click="loadCode">重试</button></p>
    <p v-if="copyError" class="nd-message" role="status">复制失败，可手动选择文字。</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ArrowUpRight, Check, Circle, CircleAlert, Copy } from "lucide-vue-next";
import { genTask } from "../logic/generateState";
import { contractSignatureLines } from "../logic/projectTree";
const props = defineProps<{ nodeId: string }>();
defineEmits<{ navigate: [id: string] }>();
const node = computed(() => genTask.tree?.nodes.find(node => node.id === props.nodeId));
const file = computed(() => genTask.files.find(file => file.path === node.value?.path));
const check = computed(() => genTask.nodeChecks[props.nodeId]);
const loadedCode = ref(""), loading = ref(false), codeError = ref(""), copyError = ref(false);
const copied = ref<"" | "path" | "code">("");
const code = computed(() => file.value?.content ?? loadedCode.value);
const checklist = computed<{ label: string; ok?: boolean }[]>(() => {
  if (check.value) return check.value.items;
  if (!node.value || node.value.id === "pom.xml") return [];
  return [...(node.value.fqcn ? ["类名 " + node.value.id, "包 " + node.value.packageName] : []), ...contractSignatureLines(node.value)].map(label => ({ label }));
});
let loadSequence = 0;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function loadCode() {
  const current = node.value, sequence = ++loadSequence;
  loadedCode.value = ""; codeError.value = ""; loading.value = false;
  if (!current || file.value?.content !== undefined || file.value?.status !== "done") return;
  loading.value = true;
  try {
    const { loadNodeContent } = await import("../logic/generateHandler");
    const content = await loadNodeContent(current.path);
    if (sequence === loadSequence) loadedCode.value = content;
  } catch { if (sequence === loadSequence) codeError.value = "源码读取失败"; }
  finally { if (sequence === loadSequence) loading.value = false; }
}
watch(() => [props.nodeId, file.value?.status], loadCode, { immediate: true });
async function copy(value: string, target: "path" | "code" = "path") {
  copyError.value = false;
  try { await navigator.clipboard.writeText(value); copied.value = target; }
  catch { copyError.value = true; }
  clearTimeout(copyTimer); copyTimer = setTimeout(() => { copied.value = ""; }, 1800);
}
onBeforeUnmount(() => { loadSequence++; clearTimeout(copyTimer); });
</script>

<style scoped>
@layer legacy {
.node-details{padding:0 16px 14px 44px;color:var(--text-secondary);font-size:11px;min-width:0}.nd-path{display:flex;align-items:flex-start;gap:9px;border-top:1px solid var(--line-soft);padding-top:12px;line-height:1.8}.nd-path>span{color:var(--text-muted);flex:none;font-size:10px}.nd-path code{min-width:0;overflow-wrap:anywhere;font-size:10px;flex:1}.nd-path>button{margin-top:-3px}.node-details button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 7px;min-height:25px;background:transparent;border:1px solid transparent;color:var(--oak);font:inherit;font-size:10px;line-height:1.5;cursor:pointer;flex:none}.node-details button:hover{border-color:var(--line-warm);background:var(--oak-soft)}.node-details button:focus-visible{outline:1px solid var(--oak);outline-offset:2px}.nd-responsibility{margin:8px 0;line-height:1.8;color:var(--text-secondary)}.nd-dependencies{display:flex;align-items:center;flex-wrap:wrap;gap:4px 7px;line-height:1.6}.nd-dependencies>span:first-child{color:var(--text-muted);font-size:10px;margin-right:3px}.nd-dependencies button{border-color:var(--line-soft);padding:4px 7px}.nd-contract-header,.nd-source-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:13px;margin-bottom:8px}.node-details h4{font-size:11px;font-weight:400;line-height:1.7;margin:0;color:var(--text-primary)}.node-details h4>span{font-size:10px;color:var(--text-muted);margin-left:8px}.nd-contract-header>span{font-size:10px;color:var(--text-muted);flex:none}.nd-contracts{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:5px 16px;padding:0;margin:0}.nd-contracts li{display:flex;align-items:flex-start;gap:7px;min-width:0;font-size:10px;line-height:1.8}.nd-contracts li>span{overflow-wrap:anywhere;min-width:0}.nd-contracts svg{flex:none;margin-top:4px;color:var(--text-muted)}.nd-contracts .passed svg{color:var(--oak)}.nd-contracts .failed,.nd-contracts .failed svg{color:var(--cyan)}.nd-muted{color:var(--text-muted);font-size:10px}.nd-empty{display:block;margin-top:4px}.nd-code{max-height:300px;overflow:auto;padding:10px 12px;margin:0;background:var(--surface-0);border:1px solid var(--line-soft);color:var(--text-secondary);font-size:10px;line-height:1.7;tab-size:4}.nd-placeholder{display:flex;align-items:center;gap:12px;margin:0;padding:9px 12px;border:1px dashed var(--line);color:var(--text-muted);font-size:10px;line-height:1.7}.nd-message{color:var(--cyan);font-size:10px;margin:8px 0 0;line-height:1.7}
}
</style>
