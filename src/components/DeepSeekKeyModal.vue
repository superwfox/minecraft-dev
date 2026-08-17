<template>
  <Teleport to="body">
    <Transition name="key-modal">
      <div v-if="showDeepSeekKeyModal" class="key-mask" @click.self="close">
        <section class="key-card" role="dialog" aria-modal="true" aria-labelledby="deepseek-key-title">
          <button class="key-close" type="button" title="关闭" aria-label="关闭" @click="close">
            <X :size="18" aria-hidden="true"/>
          </button>

          <div class="key-icon" aria-hidden="true">
            <KeyRound :size="22"/>
          </div>
          <h2 id="deepseek-key-title">配置 DeepSeek API Key</h2>
          <p class="key-apology">抱歉，Deepseek涨价幅度过大，我们取消了免费额度。</p>
          <p class="key-description">
            填写你自己的 DeepSeek API Key 后即可继续使用；已有充值额度仍然保留，也可以不填写 Key 直接使用充值额度。
          </p>

          <div v-if="reasonMessage" class="key-warning" role="alert">{{ reasonMessage }}</div>

          <div v-if="deepSeekKeyConfigured && !editing" class="key-saved">
            <div>
              <span class="key-saved-label">当前 Key</span>
              <strong>•••• {{ deepSeekKeyLastFour }}</strong>
            </div>
            <span class="key-status">已保存在此浏览器</span>
          </div>

          <div v-else class="key-form">
            <label for="deepseek-key-input">DeepSeek API Key</label>
            <div class="key-input-wrap">
              <input
                id="deepseek-key-input"
                ref="keyInput"
                v-model="draft"
                :type="revealed ? 'text' : 'password'"
                placeholder="sk-..."
                autocomplete="new-password"
                autocapitalize="none"
                spellcheck="false"
                @keyup.enter="save"
              >
              <button
                class="key-reveal"
                type="button"
                :title="revealed ? '隐藏 Key' : '显示 Key'"
                :aria-label="revealed ? '隐藏 Key' : '显示 Key'"
                @click="revealed = !revealed"
              >
                <EyeOff v-if="revealed" :size="18" aria-hidden="true"/>
                <Eye v-else :size="18" aria-hidden="true"/>
              </button>
            </div>
            <div v-if="formError" class="key-error" role="alert">{{ formError }}</div>
          </div>

          <div v-if="clearConfirm" class="key-clear-confirm" role="alert">
            <span>清除后，新请求将改用充值额度；使用 BYOK 创建的进行中任务仍需 Key，清除后可能无法继续。</span>
            <div>
              <button type="button" class="key-secondary" @click="clearConfirm = false">取消</button>
              <button type="button" class="key-danger" @click="confirmClear">确认清除</button>
            </div>
          </div>

          <div v-else class="key-actions">
            <template v-if="deepSeekKeyConfigured && !editing">
              <button type="button" class="key-secondary" @click="clearConfirm = true">
                <Trash2 :size="16" aria-hidden="true"/>
                清除
              </button>
              <button type="button" class="key-primary" @click="beginEdit">
                <Pencil :size="16" aria-hidden="true"/>
                编辑 Key
              </button>
            </template>
            <template v-else>
              <button v-if="deepSeekKeyConfigured" type="button" class="key-secondary" @click="cancelEdit">取消</button>
              <button type="button" class="key-primary" :disabled="!draft.trim()" @click="save">保存 Key</button>
            </template>
          </div>

          <a
            class="key-link"
            href="https://platform.deepseek.com/api_keys"
            target="_blank"
            rel="noopener noreferrer"
          >
            前往 DeepSeek 获取 API Key
            <ExternalLink :size="14" aria-hidden="true"/>
          </a>
          <p class="key-privacy">Key 只保存在当前浏览器；请求时用于鉴权，不会写入日志或服务端数据库。</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ExternalLink, Eye, EyeOff, KeyRound, Pencil, Trash2, X } from "lucide-vue-next";
import {
  clearDeepSeekKey,
  closeDeepSeekKeyModal,
  deepSeekKeyConfigured,
  deepSeekKeyLastFour,
  deepSeekKeyModalState,
  saveDeepSeekKey,
  showDeepSeekKeyModal,
} from "../logic/byok";

const draft = ref("");
const editing = ref(false);
const revealed = ref(false);
const formError = ref("");
const clearConfirm = ref(false);
const keyInput = ref<HTMLInputElement | null>(null);

const reasonMessage = computed(() => {
  if (deepSeekKeyModalState.message) return deepSeekKeyModalState.message;
  if (deepSeekKeyModalState.reason === "missing") return "此项操作需要先配置 DeepSeek API Key。";
  return "";
});

function resetView() {
  const shouldEdit = !deepSeekKeyConfigured.value || deepSeekKeyModalState.reason === "invalid";
  draft.value = "";
  editing.value = shouldEdit;
  revealed.value = false;
  formError.value = "";
  clearConfirm.value = false;
  if (shouldEdit) nextTick(() => keyInput.value?.focus());
}

function close() {
  closeDeepSeekKeyModal();
}

function beginEdit() {
  editing.value = true;
  draft.value = "";
  formError.value = "";
  nextTick(() => keyInput.value?.focus());
}

function cancelEdit() {
  editing.value = false;
  draft.value = "";
  formError.value = "";
  revealed.value = false;
}

function save() {
  formError.value = "";
  try {
    saveDeepSeekKey(draft.value);
    closeDeepSeekKeyModal();
  } catch (error) {
    formError.value = error instanceof Error ? error.message : "保存失败，请重试";
  }
}

function confirmClear() {
  formError.value = "";
  try {
    clearDeepSeekKey();
    clearConfirm.value = false;
    editing.value = true;
    draft.value = "";
    nextTick(() => keyInput.value?.focus());
  } catch (error) {
    clearConfirm.value = false;
    formError.value = error instanceof Error ? error.message : "清除失败，请重试";
  }
}

watch(showDeepSeekKeyModal, (visible) => {
  if (visible) resetView();
});
</script>

<style scoped>
.key-mask {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.68);
  backdrop-filter: blur(5px);
}

.key-card {
  position: relative;
  width: min(460px, 100%);
  padding: 30px 30px 24px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 14px;
  background: rgba(17, 17, 15, 0.98);
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.66);
  color: var(--text-primary);
  font-family: "Monaco", "Jiangxizhuokai", system-ui, sans-serif;
}

.key-close {
  position: absolute;
  top: 14px;
  right: 14px;
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.key-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.key-icon {
  display: flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  border: 1px solid rgba(198, 176, 125, 0.34);
  border-radius: 8px;
  background: var(--oak-soft);
  color: var(--oak);
}

h2 {
  padding-right: 34px;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.35;
}

.key-apology {
  margin-top: 12px;
  color: var(--oak-hover);
  font-size: 14px;
  line-height: 1.65;
}

.key-description {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.key-warning,
.key-error {
  margin-top: 14px;
  color: #e8a497;
  font-size: 12px;
  line-height: 1.55;
}

.key-warning {
  padding: 9px 11px;
  border: 1px solid rgba(232, 164, 151, 0.24);
  border-radius: 7px;
  background: rgba(136, 63, 49, 0.12);
}

.key-saved {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 64px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
}

.key-saved > div {
  min-width: 0;
}

.key-saved-label {
  display: block;
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.key-saved strong {
  display: block;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.key-status {
  flex: 0 0 auto;
  color: #90c9a1;
  font-size: 11px;
}

.key-form {
  margin-top: 18px;
}

.key-form label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-secondary);
  font-size: 12px;
}

.key-input-wrap {
  position: relative;
}

.key-input-wrap input {
  width: 100%;
  height: 44px;
  padding: 0 48px 0 13px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  outline: none;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  font: 13px/1 "Monaco", monospace;
}

.key-input-wrap input:focus {
  border-color: var(--oak);
  box-shadow: 0 0 0 3px rgba(198, 176, 125, 0.1);
}

.key-input-wrap input::placeholder {
  color: var(--text-muted);
}

.key-reveal {
  position: absolute;
  top: 5px;
  right: 5px;
  display: inline-flex;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.key-reveal:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.key-actions,
.key-clear-confirm > div {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 18px;
}

.key-actions button,
.key-clear-confirm button {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 15px;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
}

.key-primary {
  border: 1px solid var(--oak);
  background: var(--oak);
  color: var(--surface-1);
}

.key-primary:hover:not(:disabled) {
  background: var(--oak-hover);
}

.key-primary:disabled {
  opacity: 0.42;
  cursor: default;
}

.key-secondary {
  border: 1px solid rgba(255, 255, 255, 0.13);
  background: rgba(255, 255, 255, 0.035);
  color: var(--text-secondary);
}

.key-secondary:hover {
  border-color: rgba(255, 255, 255, 0.26);
  color: var(--text-primary);
}

.key-danger {
  border: 1px solid rgba(213, 112, 96, 0.34);
  background: rgba(144, 56, 43, 0.2);
  color: #e8a497;
}

.key-clear-confirm {
  margin-top: 18px;
  padding: 11px 12px;
  border: 1px solid rgba(213, 112, 96, 0.24);
  border-radius: 8px;
  background: rgba(144, 56, 43, 0.1);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.key-clear-confirm > div {
  margin-top: 10px;
}

.key-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 18px;
  color: var(--oak);
  font-size: 12px;
  text-decoration: none;
}

.key-link:hover {
  color: var(--oak-hover);
}

.key-privacy {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.6;
}

.key-modal-enter-active,
.key-modal-leave-active {
  transition: opacity 0.18s ease;
}

.key-modal-enter-active .key-card,
.key-modal-leave-active .key-card {
  transition: transform 0.18s ease, opacity 0.18s ease;
}

.key-modal-enter-from,
.key-modal-leave-to {
  opacity: 0;
}

.key-modal-enter-from .key-card,
.key-modal-leave-to .key-card {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 520px) {
  .key-mask {
    padding: 14px;
  }

  .key-card {
    padding: 26px 20px 20px;
  }

  .key-saved {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
