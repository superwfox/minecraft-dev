<template>
  <div class="curve-wrap">
    <svg :width="width" :height="height" class="curve-svg"
         @mousemove="onMove" @mouseleave="tooltip = null">
      <path :d="pathD" class="curve-line"/>
      <line v-if="tooltip" class="curve-guide"
            :x1="tooltip.px" :x2="tooltip.px" :y1="0" :y2="height"/>
      <circle v-if="tooltip" class="curve-dot"
              :cx="tooltip.px" :cy="tooltip.py" r="3"/>
    </svg>
    <div v-if="tooltip" class="curve-tip"
         :style="{ left: tooltip.px + 'px', top: (tooltip.py - 28) + 'px' }">
      x={{ Math.round(tooltip.x) }} → y={{ formatY(tooltip.y) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

type CurveType = "linear" | "power2" | "power0.5" | "log" | "exp";

const props = withDefaults(defineProps<{
    type: CurveType;
    start?: number;
    end?: number;
    width?: number;
    height?: number;
}>(), {
    start: 1,
    end: 1000,
    width: 200,
    height: 80,
});

const SAMPLES = 100;
const PAD_X = 6;
const PAD_Y = 6;

function fn(x: number): number {
    switch (props.type) {
        case "linear": return x;
        case "power2": return x * x;
        case "power0.5": return Math.sqrt(x);
        case "log": return Math.log(x + 1);
        case "exp": return Math.exp(x / 150);
    }
}

const samples = computed(() => {
    const pts: { x: number; y: number }[] = [];
    const step = (props.end - props.start) / (SAMPLES - 1);
    for (let i = 0; i < SAMPLES; i++) {
        const x = props.start + step * i;
        pts.push({ x, y: fn(x) });
    }
    return pts;
});

const yBounds = computed(() => {
    const ys = samples.value.map(p => p.y);
    return { min: Math.min(...ys), max: Math.max(...ys) };
});

function toPx(p: { x: number; y: number }): { px: number; py: number } {
    const w = props.width - PAD_X * 2;
    const h = props.height - PAD_Y * 2;
    const { min, max } = yBounds.value;
    const nx = (p.x - props.start) / (props.end - props.start);
    const ny = max === min ? 0 : (p.y - min) / (max - min);
    return {
        px: PAD_X + nx * w,
        py: PAD_Y + (1 - ny) * h,
    };
}

const pathD = computed(() => {
    return samples.value.map((p, i) => {
        const { px, py } = toPx(p);
        return `${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
    }).join(" ");
});

const tooltip = ref<{ x: number; y: number; px: number; py: number } | null>(null);

function onMove(e: MouseEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const w = props.width - PAD_X * 2;
    const nx = Math.max(0, Math.min(1, (mx - PAD_X) / w));
    const x = props.start + nx * (props.end - props.start);
    const y = fn(x);
    const { px, py } = toPx({ x, y });
    tooltip.value = { x, y, px, py };
}

function formatY(y: number): string {
    if (y >= 1000) return y.toExponential(2);
    if (y >= 10) return y.toFixed(0);
    return y.toFixed(2);
}
</script>

<style scoped>
.curve-wrap {
    position: relative;
    display: inline-block;
    user-select: none;
}
.curve-svg {
    display: block;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 4px;
}
.curve-line {
    fill: none;
    stroke: #ddd;
    stroke-width: 1.5;
}
.curve-guide {
    stroke: rgba(255, 255, 255, 0.25);
    stroke-width: 1;
    stroke-dasharray: 2 2;
}
.curve-dot {
    fill: #fff;
    stroke: #888;
    stroke-width: 1;
}
.curve-tip {
    position: absolute;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.75);
    color: #fff;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    pointer-events: none;
    white-space: nowrap;
}
</style>
