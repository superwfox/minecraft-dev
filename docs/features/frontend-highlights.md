# 前端技术亮点

踏海的前端采用现代化技术栈，提供流畅的用户体验和视觉效果。

## 技术栈

- **Vue 3** + Composition API（`<script setup>`）
- **TypeScript**：类型安全
- **Vite**：快速构建和热更新
- **Vue Router**：单页路由
- **原生 Canvas**：粒子背景动画

## 核心亮点

### 1. 响应式状态管理（无 Vuex/Pinia）

Vue 3 的 `reactive()` 和 `ref()` 足够强大，无需引入状态管理库。

**对话状态**（`chatState.ts`）：
```typescript
import { reactive, ref } from "vue";

export interface ChatBlock {
  id: string;
  userInput: string;
  phase: "analyzing" | "fetching" | "done" | "error";
  steps?: Step[];
  streamText?: string;
  error?: string;
}

export const chatBlocks = reactive<ChatBlock[]>([]);
export const streamTick = ref(0);
```

**任何组件直接 import 使用**：
```typescript
import { chatBlocks } from "../logic/chatState";

// 添加新对话块
chatBlocks.push({
  id: Date.now().toString(),
  userInput: "写一个传送插件",
  phase: "analyzing"
});

// 视图自动更新，无需 dispatch/commit
```

**优势**：
- 零模板代码，直接读写
- 多组件共享同一份响应式对象
- 数据变化自动触发视图更新

### 2. provide/inject 跨层级通信

导航栏中间的文字需要被深层组件控制，使用 `provide/inject` 避免 props 逐层传递。

**App.vue 提供**：
```typescript
const centerText = ref("踏海 · MC DevTool");
provide("centerText", centerText);
```

**任意子组件注入**：
```typescript
const centerText = inject<Ref<string>>("centerText")!;

// 修改导航栏文字
centerText.value = "正在生成项目...";
```

**优势**：
- 无需 props drilling
- 深层组件直接访问
- 类型安全（TypeScript）

### 3. Canvas 粒子背景

首页的方块粒子背景使用原生 Canvas 2D 绘制，营造 Minecraft 氛围。

**核心实现**（`HomePage.vue`）：
```typescript
interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  scale: number;  // 0-1，控制出现/消失
  growing: boolean;
}

const particles: Particle[] = [];

function animate() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach(p => {
    // 更新缩放（渐变出现/消失）
    if (p.growing) {
      p.scale = Math.min(1, p.scale + 0.02);
    } else {
      p.scale = Math.max(0, p.scale - 0.02);
    }

    // scale 为 0 时跳过物理计算和绘制
    if (p.scale === 0) return;

    // 更新位置
    p.x += p.speedX;
    p.y += p.speedY;

    // 边界检测
    if (p.x < 0 || p.x > canvas.width) p.speedX *= -1;
    if (p.y < 0 || p.y > canvas.height) p.speedY *= -1;

    // 绘制方块
    ctx.save();
    ctx.globalAlpha = p.scale * 0.6;
    ctx.fillStyle = "#8B4513";
    ctx.fillRect(p.x, p.y, p.size * p.scale, p.size * p.scale);
    ctx.restore();
  });

  requestAnimationFrame(animate);
}
```

**性能优化**：
- `requestAnimationFrame` 自动跟随刷新率（60fps/120fps）
- 页面不可见时浏览器自动暂停 rAF，避免后台空转
- `scale` 为 0 时跳过全部计算，减少 CPU 占用

<!-- 截图：首页粒子背景效果 -->

### 4. 毛玻璃 UI（Glass Morphism）

全局样式 `.glass2` 提供统一的毛玻璃效果。

**CSS 实现**：
```css
.glass2 {
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(8px) brightness(0.75);
  border: 3px solid rgba(255, 255, 255, 0.03);
  border-radius: 22px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
```

**关键属性**：
- `backdrop-filter: blur(8px)`：背景模糊
- `brightness(0.75)`：降低背景亮度 25%，确保深色主题下文字可读
- `rgba(255, 255, 255, 0.02)`：极低透明度白色，营造玻璃质感

**应用场景**：
- 导航栏
- 对话块
- 生成进度面板
- 输入框

<!-- 截图：毛玻璃效果展示 -->

### 5. 打字机效果

`consistentTypingText.vue` 组件逐字符显示文本，增强动态感。

**核心实现**：
```typescript
const props = defineProps<{ text: string }>();
const displayText = ref("");
let currentIndex = 0;

function typeNext() {
  if (currentIndex < props.text.length) {
    displayText.value += props.text[currentIndex];
    currentIndex++;

    // 中文标点后停顿 200ms，其他字符 50ms
    const delay = /[，。！？]/.test(props.text[currentIndex - 1]) ? 200 : 50;
    setTimeout(typeNext, delay);
  }
}

watch(() => props.text, () => {
  displayText.value = "";
  currentIndex = 0;
  typeNext();
}, { immediate: true });
```

**效果**：
- 逐字符显示，模拟打字
- 标点后短暂停顿，更自然
- props 变化时重新开始动画

### 6. 结构化步骤渲染

`StepRender.vue` 将 AI 返回的 JSON 步骤渲染为可视化卡片。

**数据结构**：
```typescript
interface Step {
  description: string;
  tags: Array<{
    type: "event" | "method" | "param";
    text: string;
  }>;
}
```

**渲染逻辑**：
```vue
<template>
  <div v-for="(step, i) in block.steps" :key="i" class="step-card">
    <div class="step-num">步骤 {{ i + 1 }}</div>
    <div class="step-desc">{{ step.description }}</div>
    <div class="step-tags">
      <span v-for="tag in step.tags" :key="tag.text"
            :class="['tag', `tag-${tag.type}`]">
        {{ tag.text }}
      </span>
    </div>
  </div>
</template>
```

**样式**：
```css
.tag-event { background: #4CAF50; }  /* 绿色 */
.tag-method { background: #2196F3; } /* 蓝色 */
.tag-param { background: #FF9800; }  /* 橙色 */
```

**效果**：
- 步骤编号清晰
- 彩色标签区分事件/方法/参数
- 无需手动 DOM 操作，Vue 自动渲染

<!-- 截图：步骤渲染效果 -->

### 7. SSE 流式 AI 输出展示

生成过程中，`GenerateProgress.vue` 实时显示 AI 的流式输出。用户可以看到代码逐字符生成，并在审查、修正、摘要提取等阶段之间平滑切换。

**流式输出卡片**：

```vue
<div class="glass2 gen-card" v-if="genTask.streamingPhase">
  <div class="gen-card-title">{{ streamPhaseLabel }} {{ genTask.streamingFile }}</div>
  <div class="gen-stream-wrap" ref="streamRef">
    <pre class="gen-stream-text" :key="streamKey">{{ genTask.streamingContent }}</pre>
  </div>
</div>
```

**模糊淡入动画**：每次阶段切换时，通过 `:key` 触发重新挂载，执行 blur fade-in 动画：

```css
@keyframes blurFadeIn {
  from { opacity: 0; filter: blur(4px); }
  to   { opacity: 1; filter: blur(0); }
}
.gen-stream-text {
  font-family: "Monaco", monospace;
  font-size: 11px;
  animation: blurFadeIn 0.4s ease-out;
}
```

**阶段标签**：使用白色单色平面符号代替 emoji，保持视觉一致性：

```typescript
const streamPhaseLabels = {
  generating: "▸ 生成中",
  reviewing:  "▸ 审查中",
  reworking:  "▸ 修正中",
  summarizing: "▸ 提取摘要",
  fixing:     "▸ 修复编译错误",
};
```

**自动滚动**：监听 `streamingContent` 变化，自动滚动到底部：

```typescript
watch(() => genTask.streamingContent, async () => {
  await nextTick();
  if (streamRef.value) streamRef.value.scrollTop = streamRef.value.scrollHeight;
});
```

### 8. 实时进度反馈

`GenerateProgress.vue` 使用单色符号标识不同日志状态：

| 符号 | 含义 |
|------|------|
| `●` | 完成/成功 |
| `○` | 待处理 |
| `◌` | 进行中 |
| `▸` | 动作/阶段 |
| `↻` | 重试/修正 |
| `!` | 警告 |
| `×` | 错误 |

日志实时追加、自动滚动到最新，monospace 字体确保对齐。

<!-- 截图：生成进度面板 -->

### 9. 语音输入集成

`voiceInput.ts` 封装讯飞 WebSocket STT，提供简洁的 API。

**核心接口**：
```typescript
export const isRecording = ref(false);
export const voiceText = ref("");

export async function startVoice() {
  // 获取签名 URL
  const { url, appId } = await fetch("/api/voice-auth").then(r => r.json());

  // 连接 WebSocket
  ws = new WebSocket(url);

  // 开始录音
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // ... PCM 编码和发送
}

export function stopVoice() {
  ws.send(JSON.stringify({ data: { status: 2 } }));
  isRecording.value = false;
}
```

**组件使用**：
```vue
<button @click="toggleVoice" :class="{recording: isRecording}">
  ◉
</button>

<script setup>
import { isRecording, voiceText, startVoice, stopVoice } from "../logic/voiceInput";

const toggleVoice = () => {
  if (isRecording.value) {
    stopVoice();
  } else {
    startVoice();
  }
};

watch(voiceText, (text) => {
  inputText.value += text;
});
</script>
```

**效果**：
- 点击按钮开始录音
- 实时转写文字追加到输入框
- 再次点击停止录音

[详细了解语音识别 →](/features/voice-input)

## 为什么不用 Vuex/Pinia？

**传统状态管理**：
```typescript
// store.ts
export const store = createStore({
  state: { chatBlocks: [] },
  mutations: {
    addBlock(state, block) {
      state.chatBlocks.push(block);
    }
  }
});

// 组件中
store.commit("addBlock", { ... });
```

**Vue 3 响应式**：
```typescript
// chatState.ts
export const chatBlocks = reactive<ChatBlock[]>([]);

// 组件中
chatBlocks.push({ ... });
```

**对比**：
- 无需定义 mutations/actions
- 无需 commit/dispatch
- 代码量减少 70%
- 类型推导更准确

**适用场景**：
- 中小型项目（< 50 个组件）
- 状态结构简单
- 无需时间旅行调试

## 性能优化

### 1. 按需加载

路由组件懒加载：
```typescript
const routes = [
  {
    path: "/",
    component: () => import("./pages/HomePage.vue")
  },
  {
    path: "/chat",
    component: () => import("./pages/ChatPage.vue")
  }
];
```

### 2. 虚拟滚动（未实现）

如果对话块超过 100 个，可以使用虚拟滚动：
```typescript
import { useVirtualList } from "@vueuse/core";

const { list, containerProps, wrapperProps } = useVirtualList(
  chatBlocks,
  { itemHeight: 200 }
);
```

### 3. 防抖输入

语音识别结果防抖，避免频繁更新：
```typescript
import { useDebounceFn } from "@vueuse/core";

const updateInput = useDebounceFn((text: string) => {
  inputText.value += text;
}, 300);
```

## 下一步

- [了解语音识别](/features/voice-input)：深入了解讯飞 STT 集成
- [查看架构设计](/technical/architecture)：了解前后端如何协作
- [API 参考](/technical/api-reference)：查看完整的 API 文档
