# 追加需求界面归档

原位置：src/components/GenerateProgress.vue。以下保留停用前的界面、事件与样式片段。

```vue
    <!-- 继续完善：生成完成后直接追加需求（增量补充现有项目）-->
    <div class="glass2 gen-card" v-if="genTask.phase === 'done'">
      <div class="gen-card-title">▪ 继续完善</div>
      <div class="gen-append">
        <textarea v-model="appendText" class="gen-append-input" rows="3"
                  placeholder="描述要追加 / 修改的功能，AI 将在当前项目上增量实现并重新编译（如：再加一条 /heal 命令）"
                  @compositionstart="onImeCompositionStart"
                  @compositionend="onImeCompositionEnd"
                  @keydown.enter.exact="onAppendEnter"></textarea>
        <div class="gen-append-foot">
          <span class="gen-append-hint">增量基于当前生成版本 · Enter 提交</span>
          <button class="gen-append-btn" :disabled="!appendText.trim()" @click="submitAppend">追加并重建</button>
        </div>
      </div>
    </div>

```

```ts
// 继续完善：追加需求 → 增量补充
const appendText = ref("");
function submitAppend() {
    const t = appendText.value.trim();
    if (!t) return;
    appendText.value = "";
    appendFeature(t);
}

function onAppendEnter(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    event.preventDefault();
    submitAppend();
}

```

```css
.gen-append {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gen-append-input {
  width: 100%;
  resize: none;
  background: #090907;
  border: 1px solid rgba(209, 200, 182, 0.18);
  border-radius: 4px;
  padding: 10px 12px;
  color: #f4f1ec;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  font-family: inherit;
  transition: border-color 0.2s;
}
.gen-append-input:focus { border-color: var(--oak-highlight, #AF9876); }
.gen-append-input::placeholder { color: rgba(255, 255, 255, 0.3); }
.gen-append-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.gen-append-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
}
.gen-append-btn {
  flex-shrink: 0;
  padding: 8px 20px;
  border-radius: 4px;
  border: 1px solid #e1d8c4;
  background: #d5c9ac;
  color: #040402;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}
.gen-append-btn:hover:not(:disabled) { opacity: 0.85; }
.gen-append-btn:disabled { opacity: 0.35; cursor: not-allowed; }

```
