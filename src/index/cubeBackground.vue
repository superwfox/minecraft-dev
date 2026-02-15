<template>
  <canvas ref="cv" class="bg-cubes" />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";

type V2 = { x: number; y: number };

const cv = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;

let raf = 0;
let dpr = 1;
let w = 0;
let h = 0;

const cursor: V2 = { x: 0, y: 0 };
let hasPointer = false;
let lastMoveAt = 0;

const CONFIG = {
  count: 120,

  // 跟随
  follow: 0.005,
  damping: 0.65,

  // 方块在 cursor 周围分布
  orbitRadius: 40,
  orbitVar: 600,
  swirl: 0.0001, // 不要绕行就设为 0
  outerBias: 1.5, // 1=接近均匀；>1 外圈更密；2~5 通常就很明显

  // 出现/消失（用“缩放”实现）
  appearSpeed: 0.02,     // scale 变大速度
  disappearSpeed: 0.005,  // scale 变小速度
  idleHideMs: 2560,

  // 大小随距离变化
  minSize: 3,
  maxSize: 25,
  sizeDistMax: 380, // 超过这个距离就接近 minSize
  sizeJitter: 3,    // 你要的 ±5 波动
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

class Cube {
  p: V2 = { x: -9999, y: -9999 };
  v: V2 = { x: 0, y: 0 };

  off: V2 = { x: 0, y: 0 };

  // scale 用来做“变大出现/变小消失”
  scale = 0;

  // 用于大小波动
  phase = Math.random() * Math.PI * 2;

  // 旋转
  rot = Math.random() * Math.PI * 2;
  rotV = (Math.random() - 0.5) * 0.02;

  constructor() {
    this.resetOffset();
  }

  resetOffset() {
    const ang = Math.random() * Math.PI * 2;

    const rMin = CONFIG.orbitRadius;
    const rMax = CONFIG.orbitRadius + CONFIG.orbitVar;

    // u -> x：x 越接近 1 越偏外圈
    // outerBias 越大，x 越偏向 1（外圈更密）
    const u = Math.random();
    const x = Math.pow(u, 1 / CONFIG.outerBias);

    const r = rMin + (rMax - rMin) * x;

    this.off.x = Math.cos(ang) * r;
    this.off.y = Math.sin(ang) * r;
  }

  step(t: number, visible: boolean) {
    // 出现/消失：只改 scale
    if (visible) this.scale = clamp(this.scale + CONFIG.appearSpeed, 0, 1);
    else this.scale = clamp(this.scale - CONFIG.disappearSpeed, 0, 1);

    // 缩到 0 就彻底隐藏，省计算
    if (this.scale <= 0.0001) {
      this.p.x = -9999;
      this.p.y = -9999;
      return;
    }

    // 目标位置：cursor + 偏移（可轻微绕行）
    let ox = this.off.x;
    let oy = this.off.y;

    if (CONFIG.swirl !== 0) {
      const a = t * CONFIG.swirl;
      const c = Math.cos(a), s = Math.sin(a);
      const rx = ox * c - oy * s;
      const ry = ox * s + oy * c;
      ox = rx; oy = ry;
    }

    const tx = cursor.x + ox;
    const ty = cursor.y + oy;

    // 第一次出现：直接放到目标附近，避免从屏外飞进来
    if (this.p.x < -1000) {
      this.p.x = tx + (Math.random() - 0.5) * 30;
      this.p.y = ty + (Math.random() - 0.5) * 30;
    }

    // 跟随（弹簧 + 阻尼）
    const dx = tx - this.p.x;
    const dy = ty - this.p.y;

    this.v.x = (this.v.x + dx * CONFIG.follow) * CONFIG.damping;
    this.v.y = (this.v.y + dy * CONFIG.follow) * CONFIG.damping;

    this.p.x += this.v.x;
    this.p.y += this.v.y;

    // 旋转（轻微）
    this.rotV *= 0.92;
    this.rotV += (Math.random() - 0.5) * 0.003;
    this.rot += this.rotV;
  }

  // 关键：根据距离 cursor 计算 baseSize，并叠加 ±5 的波动
  calcSize(t: number) {
    const dx = this.p.x - cursor.x;
    const dy = this.p.y - cursor.y;
    const dist = Math.hypot(dx, dy);

    const k = 1 - clamp(dist / CONFIG.sizeDistMax, 0, 1); // 近=1 远=0
    const base = lerp(CONFIG.minSize, CONFIG.maxSize, k);

    // ±5 的轻微 size 波动（平滑）
    const jitter = Math.sin(t * 0.006 + this.phase) * CONFIG.sizeJitter;

    // 出现/消失通过 scale 乘进去（逐渐变大/变小）
    return Math.max(0.5, (base + jitter) * this.scale);
  }

  draw(ctx: CanvasRenderingContext2D, t: number) {
    const s = this.calcSize(t);
    if (s <= 0.5) return;

    const x = this.p.x;
    const y = this.p.y;
    const r = this.rot;

    const c = Math.cos(r);
    const sn = Math.sin(r);

    // 正方面（菱形）4点
    const p1 = { x: x + (0 * c - (-s) * sn), y: y + (0 * sn + (-s) * c) };
    const p2 = { x: x + (s * c - 0 * sn), y: y + (s * sn + 0 * c) };
    const p3 = { x: x + (0 * c - (s) * sn), y: y + (0 * sn + (s) * c) };
    const p4 = { x: x + ((-s) * c - 0 * sn), y: y + ((-s) * sn + 0 * c) };

    // “高度”偏移
    const depth = s * 0.75;
    const ox = depth * 0.7;
    const oy = -depth * 0.7;

    const q1 = { x: p1.x + ox, y: p1.y + oy };
    const q2 = { x: p2.x + ox, y: p2.y + oy };
    const q3 = { x: p3.x + ox, y: p3.y + oy };
    const q4 = { x: p4.x + ox, y: p4.y + oy };

    // 纯白实心（用不同明度模拟 3D）
    // 顶面（最亮）
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(q1.x, q1.y);
    ctx.lineTo(q2.x, q2.y);
    ctx.lineTo(q3.x, q3.y);
    ctx.lineTo(q4.x, q4.y);
    ctx.closePath();
    ctx.fill();

    // 右侧面
    ctx.fillStyle = "rgba(255,255,255,0.70)";
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(q2.x, q2.y);
    ctx.lineTo(q3.x, q3.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fill();

    // 前/左面
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(q1.x, q1.y);
    ctx.lineTo(q2.x, q2.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.closePath();
    ctx.fill();
  }
}

let cubes: Cube[] = [];

function resize() {
  if (!cv.value) return;
  const rect = cv.value.getBoundingClientRect();
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  w = Math.floor(rect.width);
  h = Math.floor(rect.height);

  cv.value.width = Math.floor(w * dpr);
  cv.value.height = Math.floor(h * dpr);

  ctx = cv.value.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function onPointerMove(e: PointerEvent) {
  hasPointer = true;
  lastMoveAt = performance.now();
  cursor.x = e.clientX;
  cursor.y = e.clientY;
}

function onPointerLeave() {
  hasPointer = false;
}

function loop(t: number) {
  if (!ctx) return;

  // 背景纯黑
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const now = performance.now();
  const visible = hasPointer && (now - lastMoveAt) <= CONFIG.idleHideMs;

  for (const c of cubes) c.step(t, visible);
  for (const c of cubes) c.draw(ctx, t);

  raf = requestAnimationFrame(loop);
}

onMounted(() => {
  if (!cv.value) return;

  const el = cv.value;
  el.style.width = "100vw";
  el.style.height = "100vh";

  resize();

  cubes = Array.from({ length: CONFIG.count }, () => new Cube());

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave, { passive: true });

  raf = requestAnimationFrame(loop);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener("resize", resize);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerleave", onPointerLeave);
});
</script>

<style scoped>
.bg-cubes {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: #000;
}
</style>
