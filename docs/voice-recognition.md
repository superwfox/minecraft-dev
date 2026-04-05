# 语音识别处理

## 整体架构

语音输入采用**前端录音 + 讯飞 WebSocket 流式识别**的方案，鉴权在服务端完成以保护密钥。

```
用户点击 ◉ → getUserMedia 获取麦克风
              → 请求 /api/voice-auth 获取签名 URL
              → 建立 WSS 连接
              → PCM 音频流式发送
              → 引擎返回识别结果
              → 实时更新输入框
              → 用户点停 或 引擎结束 → 断开
```

## WSS 连接鉴权

鉴权在 Cloudflare Pages Function (`functions/api/voice-auth.ts`) 中完成，API 密钥存储为环境变量 Secret。

### 签名计算步骤

```
1. date = RFC1123 格式的 UTC 时间
   例：Sun, 15 Mar 2026 02:35:53 GMT

2. signature_origin 拼接（LF = 0x0A 换行符）：
   "host: iat-api.xfyun.cn" + LF
   "date: " + date + LF
   "GET /v2/iat HTTP/1.1"

3. signature = base64(hmac-sha256(API_SECRET, signature_origin))

4. authorization_origin 拼接：
   api_key="<API_KEY>", algorithm="hmac-sha256",
   headers="host date request-line", signature="<signature>"

5. authorization = base64(authorization_origin)

6. 最终 URL：
   wss://iat-api.xfyun.cn/v2/iat
     ?authorization=<encodeURIComponent(authorization)>
     &date=<encodeURIComponent(date)>
     &host=<encodeURIComponent("iat-api.xfyun.cn")>
```

### 关键实现细节

| 要点 | 说明 |
|------|------|
| 换行符 | 使用 `String.fromCharCode(10)` 而非 `"\n"` 避免转译歧义 |
| 环境变量 | 读取后 `.trim()` 防止隐藏空白导致签名不匹配 |
| 时钟偏移 | 服务端允许 ±300s 偏差 |
| 缓存 | 响应 `Cache-Control: no-store` 防止复用过期签名 |

## 前端录音采集

```typescript
// 获取麦克风（必须在用户点击的同步调用链中）
mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1 }
});

// AudioContext 采集 PCM
audioCtx = new AudioContext({ sampleRate: 16000 });
await audioCtx.resume();  // 异步回调中可能 suspended
const source = audioCtx.createMediaStreamSource(mediaStream);

// bufferSize 必须是 2 的幂
scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
scriptNode.onaudioprocess = (e) => {
    const pcm = float32ToPcm16(e.inputBuffer.getChannelData(0));
    sendFrame(pcm);
};
```

**踩坑点**：
- `getUserMedia` 必须在用户手势的直接调用链中，放到 `ws.onopen` 回调里浏览器会静默拒绝
- `createScriptProcessor` 的 bufferSize 只接受 2 的幂（256/512/1024/2048/4096），传入 1280 会直接抛异常
- `AudioContext` 在非手势上下文中默认 suspended，需显式 `resume()`

## 数据帧格式

### 首帧（status: 0）

```json
{
  "common": { "app_id": "<APPID>" },
  "business": {
    "language": "zh_cn",
    "domain": "iat",
    "accent": "mandarin",
    "dwa": "wpgs"
  },
  "data": {
    "status": 0,
    "format": "audio/L16;rate=16000",
    "encoding": "raw",
    "audio": "<base64 PCM>"
  }
}
```

### 后续帧（status: 1）

只需 `data` 字段，不再重复 `common` 和 `business`。

### 结束帧（status: 2）

```json
{ "data": { "status": 2 } }
```

用户手动点停时发送，或等待引擎返回 `data.status === 2` 表示识别结束。

## 流式结果解析

开启 `dwa: "wpgs"` 动态修正后，返回结果中包含 `pgs` 字段：

| pgs 值 | 含义 | 处理方式 |
|--------|------|----------|
| `apd` | 追加 | 直接追加到结果 |
| `rpl` | 替换 | 删除 `rg[0]` 到 `rg[1]` 范围的句子，替换为当前结果 |

```typescript
// 用 Map<sn, text> 维护每个句子的最新内容
if (pgs === "rpl" && rg) {
    for (let i = rg[0]; i <= rg[1]; i++) resultMap.delete(i);
}
resultMap.set(sn, text);

// 按 sn 排序拼接完整文本
const keys = [...resultMap.keys()].sort((a, b) => a - b);
let full = "";
for (const k of keys) full += resultMap.get(k);
```

### 输入框实时更新

```typescript
// 录音开始时记录基础文本
voiceBaseText = inputText.value;

// watch 驱动实时拼接
watch(voiceText, (t) => {
    if (isRecording.value) inputText.value = voiceBaseText + t;
});
```

## 连接终止

| 场景 | 触发方式 | 行为 |
|------|----------|------|
| 用户手动暂停 | 再次点击 ◉ | 发送 status:2 帧，停止录音 |
| 引擎识别结束 | 返回 data.status === 2 | 自动清理，回调最终文本 |
| 超时 | 60s 无数据或 10s 静默 | 服务端主动断开 |
| 网络错误 | WebSocket error | onerror 触发清理 |

通过 `hasFired` 标记确保 `onDone` 回调只执行一次（`onmessage`/`onclose`/`onerror` 都可能触发）。
