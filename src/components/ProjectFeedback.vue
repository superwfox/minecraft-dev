<template>
  <details v-if="visible" ref="panel" v-lattice:one class="glass2 gen-card project-feedback" :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary class="feedback-heading">
      <span class="feedback-heading-main"><MessageSquare :size="17"/><span>问题反馈</span><span class="feedback-kind">{{ implementation ? '游戏实测' : '执行失败' }}</span></span>
      <ChevronDown :size="15" class="feedback-chevron"/>
    </summary>
    <div v-if="open" class="feedback-body" :class="{ 'is-failure': !implementation }">
      <div v-if="draft.issueUrl" class="feedback-published">
        <Check :size="22"/><div><strong>反馈已发布</strong><p>可在 GitHub 查看回复与修复进展，通知遵循你的 GitHub 设置。</p></div>
        <a v-lattice class="feedback-btn" :href="draft.issueUrl" target="_blank" rel="noopener noreferrer">查看 Issue<ExternalLink :size="15"/></a>
        <button v-lattice type="button" class="feedback-btn feedback-secondary" @click="startNew">再写一条反馈</button>
      </div>
      <form v-else @submit.prevent="openReview">
        <div class="feedback-intro">
          <component :is="implementation ? Check : AlertTriangle" :size="20"/>
          <div><h3>{{ implementation ? '实现与预期不符' : '这次执行没有完成' }}</h3>
            <p>{{ implementation ? '告诉我们游戏中的实际表现；可以定位到具体路径和节点。' : '失败信息和已有执行记录会自动附上，无需重新填写报错。' }}</p>
          </div>
        </div>
        <p v-if="!implementation && genTask.error" class="feedback-failure" data-font="dynamic">{{ genTask.error }}</p>
        <div v-if="implementation && paths.length" class="feedback-location">
          <div class="feedback-location-field"><span>相关路径 <small>可选</small></span><ThemedSelect :model-value="draft.pathId" :options="pathOptions" :disabled="locked || busy" numbered aria-label="相关路径" @update:model-value="draft.pathId = $event; draft.stepId = ''"/></div>
          <div v-if="selectedPath" class="feedback-location-field"><span>相关节点 <small>可选</small></span><ThemedSelect v-model="draft.stepId" :options="stepOptions" :disabled="locked || busy" numbered aria-label="相关节点"/></div>
        </div>
        <div class="feedback-editor">
          <MarkdownComposer v-model="draft.description" class="feedback-text" :disabled="locked || busy" :accept-images="true" :images="imageViews" :submit-on-enter="false"
            :placeholder="implementation ? '例如：我希望背包满时把奖励掉在脚下，但实际没有收到。\n也可以直接粘贴或拖入截图。' : '补充说明（可选）\n有额外情况或截图，可以直接写在这里。'"
            aria-label="反馈内容" @images="addImages" @remove-image="removeImage">
            <template #footer><div class="feedback-editor-note"><span>{{ imagePending ? '正在处理图片…' : 'Markdown · 粘贴或拖入图片' }}</span><span>{{ draft.description.length }} / 10000</span></div></template>
          </MarkdownComposer>
        </div>
        <div class="feedback-bottom">
          <span class="feedback-auto"><Paperclip :size="14"/>自动附源码 ZIP 与诊断包</span>
          <button v-lattice type="submit" class="feedback-btn" :disabled="busy || imagePending > 0 || draft.description.length > 10000 || implementation && !draft.description.trim() && !imageViews.length">
            <LoaderCircle v-if="preparing" :size="16" class="feedback-spin"/><ArrowUpRight v-else :size="16"/>{{ preparing ? '正在整理资料…' : locked ? '查询并重试发布' : '发布反馈' }}
          </button>
        </div>
        <p v-if="locked" class="feedback-note">上次提交结果仍需确认，重试会复用原资料，避免重复创建 Issue。</p>
      </form>
      <p v-if="error" class="feedback-error" role="alert" data-font="dynamic">{{ error }}</p>
    </div>
  </details>
  <Teleport to="body">
    <dialog ref="dialog" class="feedback-dialog" :aria-labelledby="dialogTitle" @cancel.prevent="closeReview" @click="backdropClick">
      <section v-if="review" v-lattice:two class="feedback-confirm">
        <header class="feedback-confirm-head"><div><ShieldCheck :size="20"/><h3 :id="dialogTitle">确认公开发布</h3></div><button type="button" class="feedback-close" aria-label="关闭公开确认" :disabled="publishing" @click="closeReview"><X :size="18"/></button></header>
        <div class="feedback-confirm-content">
          <p class="feedback-destination">将发布到 <strong>superwfox/minecraft-dev</strong> 的公开 Issue。</p>
          <p class="feedback-public-notice">反馈正文、图片、源码 ZIP 和诊断包（含需求与模型调用记录）将对所有人公开，并长期保留。删除 Issue 不会清除 Git 历史中的附件。</p>
          <div class="feedback-bundles" v-if="!review.legacy"><span><Archive :size="16"/><strong>源码 ZIP</strong><small>{{ formatBytes(review.sourceBytes) }}</small></span><span><Archive :size="16"/><strong>诊断包</strong><small>{{ formatBytes(review.diagnosticBytes) }}</small></span><span v-if="review.imageCount"><Image :size="16"/>{{ review.imageCount }} 张图片</span></div>
          <p v-else class="feedback-note">本次重试保留已确认的旧版资料及原提交。</p>
          <p v-if="!review.sourceCount" class="feedback-note">本轮尚未生成源码；源码 ZIP 内会说明这一情况。</p>
          <p v-if="review.incomplete" class="feedback-missing"><AlertTriangle :size="15"/>部分诊断记录缺失，资料包会如实标记，不影响提交已有问题。</p>
          <p class="feedback-mention" data-font="dynamic">反馈用户：<strong>{{ githubMention }}</strong><span>用于在 GitHub 跟进回复与修复。</span></p>
          <div class="feedback-readback"><span class="feedback-readback-label">即将公开的内容</span><MarkdownComposer :model-value="review.description" :disabled="true" :accept-images="true" :images="reviewImages" aria-label="即将公开的反馈内容"/></div>
          <p v-if="error" class="feedback-error" role="alert" data-font="dynamic">{{ error }}</p>
        </div>
        <footer class="feedback-confirm-actions"><button v-lattice type="button" class="feedback-btn feedback-secondary" :disabled="publishing" @click="closeReview">{{ locked ? '返回' : '返回修改' }}</button><button v-lattice type="button" class="feedback-btn" :disabled="publishing" @click="publish"><LoaderCircle v-if="publishing" :size="16" class="feedback-spin"/><ArrowUpRight v-else :size="16"/>{{ publishing ? '正在发布…' : '确认公开并发布' }}</button></footer>
      </section>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { MessageSquare, ChevronDown, Check, AlertTriangle, Paperclip, ArrowUpRight, ExternalLink, LoaderCircle, ShieldCheck, X, Archive, Image } from 'lucide-vue-next';
import MarkdownComposer from './MarkdownComposer.vue';
import ThemedSelect from './ThemedSelect.vue';
import { genTask } from '../logic/generateState';
import { authState } from '../logic/auth';
import { activeProjectKey } from '../logic/projectSession';
import { newFeedback, feedbackDraft, saveFeedbackDraft, feedbackImage, prepareFeedback, submitFeedback, type FeedbackReview, type FeedbackFile } from '../logic/projectFeedback';
const visible = ref(false), open = ref(false), preparing = ref(false), publishing = ref(false), error = ref('');
const panel = ref<HTMLDetailsElement>(), dialog = ref<HTMLDialogElement>(), review = ref<FeedbackReview | null>(null), draft = ref(newFeedback());
const dialogTitle = 'feedback-public-' + crypto.randomUUID();
const busy = computed(() => preparing.value || publishing.value), locked = computed(() => !!draft.value.submittedPayload);
const implementation = computed(() => draft.value.kind === 'implementation');
const paths = computed(() => genTask.tree?.paths || []);
const selectedPath = computed(() => paths.value.find(path => path.id === draft.value.pathId));
const pathOptions = computed(() => [{ value: '', label: '整个工程 / 尚未确定' }, ...paths.value.map(path => ({ value: path.id, label: path.title }))]);
const stepOptions = computed(() => [{ value: '', label: '这条路径的全部节点' }, ...(selectedPath.value?.nodes || []).map(step => ({ value: step.id, label: step.title }))]);
const toImages = (files: FeedbackFile[]) => files.filter(file => file.path.startsWith('images/') && file.encoding === 'base64').map(file => ({ id: file.path, url: 'data:image/' + (file.path.endsWith('.png') ? 'png' : file.path.endsWith('.jpg') ? 'jpeg' : 'webp') + ';base64,' + file.content, name: '反馈截图' }));
const imageViews = computed(() => toImages(draft.value.files));
const reviewImages = computed(() => review.value ? toImages(JSON.parse(review.value.payload).files) : []);
const githubMention = computed(() => authState.user?.login ? '@' + authState.user.login : '当前登录用户');
let ticket = 0, timer: ReturnType<typeof setTimeout> | undefined, imageQueue = Promise.resolve();
const imagePending = ref(0);
async function show(locate = true) {
  const sequence = ++ticket, key = activeProjectKey(); error.value = '';
  try {
    const value = await feedbackDraft();
    if (sequence !== ticket || key !== activeProjectKey()) return;
    draft.value = value; visible.value = true; open.value = true;
    if (locate) { await nextTick(); panel.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  } catch (e) { error.value = String(e); visible.value = true; open.value = true; }
}
defineExpose({ show });
watch(() => genTask.phase, (phase, previous) => { if (phase === 'error' && !['idle', 'done', 'error', 'interrupted'].includes(previous)) show(false); });
watch(draft, () => {
  clearTimeout(timer); const key = activeProjectKey(), value = JSON.parse(JSON.stringify(draft.value));
  timer = setTimeout(() => saveFeedbackDraft(value, key).catch(e => error.value = String(e)), 400);
}, { deep: true });
watch(() => [genTask.taskId, genTask.tree?.revision, activeProjectKey()], () => {
  ticket++; clearTimeout(timer); visible.value = false; open.value = false; dialog.value?.close(); review.value = null;
});
function addImages(files: File[]) {
  if (locked.value || busy.value) return;
  const target = draft.value, key = activeProjectKey(); imagePending.value++;
  imageQueue = imageQueue.then(async () => {
    for (const file of files) {
      if (target !== draft.value || key !== activeProjectKey()) return;
      if (toImages(target.files).length >= 5) throw new Error('最多添加 5 张图片，每张不超过 5 MiB');
      const encoded = await feedbackImage(file);
      if (target === draft.value && key === activeProjectKey()) target.files.push(encoded);
    }
  }).catch(e => { if (target === draft.value) error.value = String(e); }).finally(() => imagePending.value--);
}
function removeImage(id: string) { if (!locked.value && !busy.value) draft.value.files = draft.value.files.filter(file => file.path !== id); }
function startNew() { draft.value = newFeedback(); error.value = ''; review.value = null; }
function formatBytes(size: number) { return size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MiB' : Math.max(1, Math.round(size / 1024)) + ' KiB'; }
async function openReview() {
  if (busy.value || imagePending.value) return;
  const sequence = ticket; preparing.value = true; error.value = '';
  try {
    const value = await prepareFeedback(draft.value);
    if (sequence !== ticket) return;
    await saveFeedbackDraft(draft.value); review.value = value;
    await nextTick(); dialog.value?.showModal();
  } catch (e) { error.value = String(e); } finally { preparing.value = false; }
}
function closeReview() { if (!publishing.value) { dialog.value?.close(); review.value = null; } }
function backdropClick(event: MouseEvent) { if (event.target === dialog.value) closeReview(); }
async function publish() {
  if (!review.value || publishing.value) return;
  publishing.value = true; error.value = '';
  try { await submitFeedback(draft.value, review.value, true); dialog.value?.close(); review.value = null; }
  catch (e) { error.value = String(e); } finally { publishing.value = false; }
}
onBeforeUnmount(() => { ticket++; clearTimeout(timer); dialog.value?.close(); });
</script>
<style scoped>
.project-feedback { margin-top: 20px; padding: 22px 24px; }
.feedback-heading, .feedback-heading-main, .feedback-intro, .feedback-bottom, .feedback-auto, .feedback-btn, .feedback-confirm-head, .feedback-confirm-head > div, .feedback-bundles > span, .feedback-confirm-actions { display: flex; align-items: center; gap: 10px; }
.feedback-heading { justify-content: space-between; cursor: pointer; list-style: none; font-size: 14px; }
.feedback-heading::-webkit-details-marker { display: none; }
.feedback-heading-main { gap: 9px; }
.feedback-kind { margin-left: 4px; padding: 3px 8px; border: 1px solid var(--line-soft); color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.feedback-chevron { color: var(--text-muted); transition: transform .18s; }
details[open] > .feedback-heading .feedback-chevron { transform: rotate(180deg); }
.feedback-body { margin-top: 20px; }
form { display: grid; gap: 16px; }
.feedback-intro { align-items: flex-start; color: var(--oak); }
.feedback-intro > svg { flex: 0 0 auto; margin-top: 3px; }
h3 { margin: 0; font-size: 16px; line-height: 1.5; }
.feedback-intro p, .feedback-published p { margin: 5px 0 0; font-size: 12px; line-height: 1.8; color: var(--text-muted); }
.feedback-failure { margin: 0; padding: 10px 14px; border-left: 2px solid var(--oak); color: var(--text-muted); background: var(--surface-0); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; max-height: 88px; overflow: auto; }
.feedback-location { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.feedback-location-field { display: grid; gap: 7px; min-width: 0; font-size: 12px; }
.feedback-location small { margin-left: 5px; color: var(--text-muted); font-size: 10px; }
.feedback-editor :deep(.feedback-text) { min-height: 128px; max-height: 280px; font-size: 14px; line-height: 1.8; }
.is-failure .feedback-editor :deep(.feedback-text) { min-height: 80px; }
.feedback-editor-note { display: flex; justify-content: space-between; gap: 12px; font-size: 10px; color: var(--text-muted); }
.feedback-bottom { justify-content: space-between; flex-wrap: wrap; gap: 14px; }
.feedback-auto { color: var(--text-muted); font-size: 11px; }
button.feedback-btn, a.feedback-btn { display: inline-flex; justify-content: center; flex: 0 0 auto; box-sizing: border-box; min-height: 44px; padding: 12px 18px; gap: 9px; font: inherit; font-size: 12px; line-height: 1.5; text-decoration: none; cursor: pointer; white-space: nowrap; }
.feedback-secondary { opacity: .8; }
.feedback-btn:disabled { opacity: .45; cursor: not-allowed; }
.feedback-note { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.8; }
.feedback-error { margin: 12px 0 0; color: var(--cyan, #78bbc7); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.feedback-published { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; }
.feedback-published > svg { color: var(--oak); }
.feedback-published > div { flex: 1; min-width: 180px; }
.feedback-dialog { width: min(760px, calc(100vw - 100px)); max-height: calc(100vh - 100px); padding: 0; border: 0; background: transparent; color: var(--text-primary); overflow: visible; }
.feedback-dialog::backdrop { background: #000c; backdrop-filter: blur(5px); }
.feedback-confirm { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; max-height: calc(100vh - 100px); background: var(--surface-1, #191916); border: 1px solid var(--line-soft); }
.feedback-confirm-head { justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--line-soft); }
.feedback-confirm-head > div { gap: 10px; color: var(--oak); }
.feedback-confirm-content { overflow-y: auto; min-height: 0; padding: 20px 24px; display: grid; gap: 16px; }
.feedback-close { display: grid; place-items: center; padding: 6px; width: 32px; height: 32px; background: transparent; color: var(--text-muted); border: 1px solid transparent; cursor: pointer; }
.feedback-close:hover { border-color: var(--line-soft); }
.feedback-destination { margin: 0; font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.feedback-destination strong { color: var(--oak); }
.feedback-public-notice { margin: 0; padding: 12px 15px; border-left: 2px solid var(--oak); background: var(--surface-0); font-size: 12px; line-height: 1.9; color: var(--text-primary); }
.feedback-bundles { display: flex; flex-wrap: wrap; gap: 10px; }
.feedback-bundles > span { gap: 8px; padding: 9px 12px; border: 1px solid var(--line-soft); font-size: 11px; }
.feedback-bundles small { color: var(--text-muted); }
.feedback-missing { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 11px; line-height: 1.8; color: var(--text-muted); }
.feedback-missing > svg { flex: 0 0 auto; margin-top: 2px; }
.feedback-mention { display: flex; flex-wrap: wrap; gap: 7px; margin: 0; font-size: 12px; line-height: 1.8; }
.feedback-mention strong { color: var(--oak); }
.feedback-mention span { color: var(--text-muted); font-size: 11px; }
.feedback-readback { display: grid; gap: 8px; }
.feedback-readback-label { font-size: 11px; color: var(--text-muted); }
.feedback-readback :deep(.markdown-composer) { min-height: 0; max-height: 260px; font-size: 12px; line-height: 1.8; }
.feedback-confirm-actions { justify-content: flex-end; gap: 14px; padding: 16px 24px; border-top: 1px solid var(--line-soft); }
.feedback-spin { animation: feedback-spin .8s linear infinite; }
@keyframes feedback-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .feedback-spin { animation: none; } .feedback-chevron { transition: none; } }
</style>
