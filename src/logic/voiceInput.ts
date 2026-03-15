import { ref } from "vue";

export const isRecording = ref(false);
export const voiceText = ref("");

let ws: WebSocket | null = null;
let mediaStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let frameStatus = 0;
let currentAppId = "";
let hasFired = false;
const resultMap = new Map<number, string>();

function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function float32ToPcm16(input: Float32Array): ArrayBuffer {
    const buf = new ArrayBuffer(input.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < input.length; i++) {
        let s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
}

function parseResult(data: any) {
    if (!data?.result) return;
    const result = data.result;
    const sn = result.sn as number;
    const pgs = result.pgs as string | undefined;
    const rg = result.rg as number[] | undefined;

    let text = "";
    if (result.ws) {
        for (const w of result.ws) {
            for (const cw of w.cw) text += cw.w;
        }
    }

    if (pgs === "rpl" && rg) {
        for (let i = rg[0]; i <= rg[1]; i++) resultMap.delete(i);
    }
    resultMap.set(sn, text);

    let full = "";
    const keys = [...resultMap.keys()].sort((a, b) => a - b);
    for (const k of keys) full += resultMap.get(k);
    voiceText.value = full;
}

function sendFrame(audioData: ArrayBuffer) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const base64Audio = arrayBufferToBase64(audioData);
    const frame: any = { data: { status: frameStatus, format: "audio/L16;rate=16000", encoding: "raw", audio: base64Audio } };

    if (frameStatus === 0) {
        frame.common = { app_id: currentAppId };
        frame.business = { language: "zh_cn", domain: "iat", accent: "mandarin", dwa: "wpgs" };
        frameStatus = 1;
    }

    ws.send(JSON.stringify(frame));
}

function sendEndFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ data: { status: 2 } }));
}

function cleanupAudio() {
    scriptNode?.disconnect();
    scriptNode = null;
    audioCtx?.close();
    audioCtx = null;
    mediaStream?.getTracks().forEach(t => t.stop());
    mediaStream = null;
}

function fireDone(onDone?: (text: string) => void) {
    if (hasFired) return;
    hasFired = true;
    cleanupAudio();
    isRecording.value = false;
    onDone?.(voiceText.value);
}

export async function startVoice(onDone?: (text: string) => void) {
    if (isRecording.value) return;
    isRecording.value = true;
    voiceText.value = "";
    resultMap.clear();
    frameStatus = 0;
    hasFired = false;

    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    } catch {
        isRecording.value = false;
        return;
    }

    let authData: { url: string; appId: string };
    try {
        const resp = await fetch("/api/voice-auth");
        if (!resp.ok) throw new Error(await resp.text());
        authData = await resp.json() as any;
    } catch {
        cleanupAudio();
        isRecording.value = false;
        return;
    }
    currentAppId = authData.appId;

    ws = new WebSocket(authData.url);

    ws.onopen = async () => {
        try {
            audioCtx = new AudioContext({ sampleRate: 16000 });
            await audioCtx.resume();
            const source = audioCtx.createMediaStreamSource(mediaStream!);
            scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);

            scriptNode.onaudioprocess = (e) => {
                if (!isRecording.value) return;
                const pcm = float32ToPcm16(e.inputBuffer.getChannelData(0));
                sendFrame(pcm);
            };

            source.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);
        } catch {
            stopVoice();
        }
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data as string);
            if (msg.code !== 0) { fireDone(onDone); return; }
            parseResult(msg.data);
            if (msg.data?.status === 2) fireDone(onDone);
        } catch { /* ignore */ }
    };

    ws.onerror = () => fireDone(onDone);
    ws.onclose = () => fireDone(onDone);
}

export function stopVoice() {
    if (!isRecording.value) return;
    isRecording.value = false;
    sendEndFrame();
    cleanupAudio();
}
