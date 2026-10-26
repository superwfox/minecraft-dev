<template>
  <button type="button" class="jar-add" :disabled="disabled" aria-label="导入 JAR" title="导入 JAR；也可直接拖入" @click="picker?.click()">+</button>
  <input ref="picker" type="file" accept=".jar" hidden @change="pick"/>
  <Teleport to="body">
    <div v-if="file" class="jar-overlay" @click.self="close">
      <section v-lattice:card class="jar-confirm" role="dialog" aria-modal="true" aria-label="导入 JAR">
        <strong data-font="dynamic">{{ file.name }}</strong>
        <p>提取已有实现并进入结构树，保留原始 JAR。游戏行为需自行实测。</p>
        <label>服务端类型<select v-model="core"><option>PAPER</option><option>SPIGOT</option></select></label>
        <label>Minecraft 目标版本<input v-model="version" placeholder="例如 1.21.8" required/></label>
        <p v-if="repository" data-font="dynamic">执行仓库：{{ repository.repository }} · {{ repository.private ? '私有' : '公开' }}</p>
        <label v-if="repository && !repository.private"><input type="checkbox" v-model="consent"/>同意将原始 JAR 和解析源码上传到此公开仓库</label>
        <p v-if="error" role="alert" data-font="dynamic">{{ error }}</p>
        <div class="jar-actions"><button v-lattice type="button" @click="close">取消</button><button v-lattice type="button" :disabled="busy || !valid || !repository || !version.trim() || !repository.private && !consent" @click="start">开始解析</button></div>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { inspectJar } from '../../shared/jarArchive';
import { startJarProject } from '../logic/generateHandler';
import { genTask } from '../logic/generateState';
const props = defineProps<{ disabled?: boolean }>();
const picker = ref<HTMLInputElement>(), file = ref<File>(), repository = ref<{ repository: string; private: boolean }>();
const core = ref('PAPER'), version = ref(genTask.version || ''), consent = ref(false), busy = ref(false), valid = ref(false), error = ref('');
async function choose(value: File) {
  if (props.disabled) return;
  file.value = value; consent.value = false; error.value = ''; valid.value = false; repository.value = undefined;
  try {
    inspectJar(new Uint8Array(await value.arrayBuffer())); valid.value = true;
    const response = await fetch('/api/generate/jar'), data: any = await response.json();
    if (!response.ok || typeof data.private !== 'boolean') throw new Error(data.error || '无法确定执行仓库可见性，尚未上传');
    repository.value = data;
  } catch (e) { error.value = String(e); }
}
function pick(event: Event) { const input = event.target as HTMLInputElement; if (input.files?.[0]) choose(input.files[0]); input.value = ''; }
function isJar(event: DragEvent) { return Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file'); }
function dragover(event: DragEvent) { if (isJar(event)) event.preventDefault(); }
function drop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files || []).filter(file => file.name.toLowerCase().endsWith('.jar'));
  if (!files.length) return; event.preventDefault();
  if (files.length !== 1) { error.value = '每次仅支持一个 JAR'; return; }
  choose(files[0]);
}
defineExpose({ dragover, drop });
function close() { if (!busy.value) file.value = undefined; }
async function start() {
  if (!file.value || busy.value) return; busy.value = true;
  const selected = file.value;
  try { file.value = undefined; await startJarProject(selected, core.value, version.value.trim(), consent.value); }
  catch(e) { file.value = selected; error.value = String(e); } finally { busy.value = false; }
}
onMounted(() => { document.addEventListener('dragover', dragover); document.addEventListener('drop', drop); });
onBeforeUnmount(() => { document.removeEventListener('dragover', dragover); document.removeEventListener('drop', drop); });
</script>
<style scoped>
.jar-add { padding: 6px 10px; color: inherit; opacity: .45; border: 0; background: transparent; font: inherit; font-size: 20px; cursor: pointer; }
.jar-add:hover { opacity: 1; }
.jar-overlay { position: fixed; inset: 0; z-index: 3000; display: grid; place-items: center; background: #0009; }
.jar-confirm { width: min(520px, calc(100vw - 96px)); padding: 28px; color: var(--text-primary); background: var(--surface-0, #080805); display: grid; gap: 16px; }
label { display: flex; gap: 12px; align-items: center; }
select, input:not([type=checkbox]) { padding: 10px 14px; font: inherit; color: inherit; background: var(--surface-0, #080805); border: 1px solid var(--line-soft, #706346); min-width: 0; }
.jar-actions { display: flex; justify-content: flex-end; gap: 16px; }
.jar-actions button { padding: 12px 20px; }
p { margin: 0; line-height: 1.7; overflow-wrap: anywhere; }
</style>
