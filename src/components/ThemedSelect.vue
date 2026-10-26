<template>
  <div ref="root" class="themed-select" :class="{ 'is-open': open }" @focusout="leave">
    <button ref="trigger" type="button" class="select-trigger" role="combobox" aria-haspopup="listbox"
      :aria-label="ariaLabel" :aria-expanded="open" :aria-controls="menuId"
      :aria-activedescendant="open && active >= 0 ? optionId(active) : undefined"
      :disabled="disabled" @click="toggle" @keydown="keyDown">
      <span class="select-value"><span v-if="numbered && selected" class="select-number">{{ selectedIndex + 1 }}</span><span class="select-label">{{ selected?.label || placeholder }}</span></span><ChevronDown :size="16" aria-hidden="true"/>
    </button>
    <div v-if="open" :id="menuId" ref="menu" class="select-menu" role="listbox" :aria-label="ariaLabel">
      <div v-for="(option, index) in options" :id="optionId(index)" :key="option.value" role="option"
        class="select-option" :class="{ 'is-active': active === index, 'is-selected': modelValue === option.value }"
        :aria-selected="modelValue === option.value" @pointermove="active = index" @mousedown.prevent @click="choose(index)">
        <span class="select-value"><span v-if="numbered" class="select-number">{{ index + 1 }}</span><span class="select-label">{{ option.label }}</span></span><Check v-if="modelValue === option.value" :size="16" aria-hidden="true"/>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Check, ChevronDown } from 'lucide-vue-next';

const props = withDefaults(defineProps<{
  modelValue?: string; options: { value: string; label: string }[];
  ariaLabel: string; placeholder?: string; disabled?: boolean; numbered?: boolean;
}>(), { modelValue: '', placeholder: '', disabled: false, numbered: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), menu = ref<HTMLElement>();
const open = ref(false), active = ref(-1), menuId = 'themed-select-' + crypto.randomUUID();
const selectedIndex = computed(() => props.options.findIndex(option => option.value === props.modelValue));
const selected = computed(() => props.options[selectedIndex.value]);
const optionId = (index: number) => `${menuId}-${index}`;
function reveal() {
  nextTick(() => {
    const list = menu.value, item = list?.children[active.value] as HTMLElement | undefined;
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  });
}
function expand() {
  if (props.disabled) return;
  active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue));
  open.value = true; reveal();
}
function toggle() { if (open.value) open.value = false; else expand(); }
function choose(index: number) {
  const option = props.options[index];
  if (!option || props.disabled) return;
  emit('update:modelValue', option.value); open.value = false; trigger.value?.focus();
}
function keyDown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'Tab') { open.value = false; return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { open.value = false; return; }
  if (event.key === 'Enter' || event.key === ' ') { if (open.value) choose(active.value); else expand(); return; }
  const wasOpen = open.value;
  if (!wasOpen) expand();
  if (event.key === 'Home') active.value = 0;
  else if (event.key === 'End') active.value = props.options.length - 1;
  else if (wasOpen) active.value = Math.max(0, Math.min(props.options.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)));
  reveal();
}
function leave(event: FocusEvent) { if (!root.value?.contains(event.relatedTarget as Node | null)) open.value = false; }
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) open.value = false; }
watch(() => props.disabled, disabled => { if (disabled) open.value = false; });
watch(() => props.options, () => { if (open.value) { active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue)); reveal(); } });
onMounted(() => document.addEventListener('pointerdown', outside, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true));
</script>
<style scoped>
.themed-select { position: relative; min-width: 0; }
.themed-select.is-open { z-index: 10; }
button.select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 10px 14px; border: 1px solid var(--line-soft); border-radius: 0; color: var(--text-primary); background: var(--surface-0); font: inherit; line-height: 1.5; text-align: left; cursor: pointer; }
.select-value { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.select-label { min-width: 0; }
.select-trigger .select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select-number { display: inline-grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 50%; color: var(--oak); font-family: "DingTalk JinBuTi", sans-serif; font-size: 12px; font-weight: 400; line-height: 1; }
.select-trigger > svg { flex: 0 0 auto; color: var(--text-muted); transition: transform .15s; }
.is-open > .select-trigger { border-color: var(--oak); }
.is-open > .select-trigger > svg { transform: rotate(180deg); }
.select-trigger:focus-visible { outline: 1px solid var(--oak); outline-offset: 3px; }
.select-trigger:disabled { opacity: .45; cursor: not-allowed; }
.select-menu { position: absolute; top: calc(100% + 5px); left: 0; right: 0; box-sizing: border-box; max-height: min(264px, 35vh); padding: 4px; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line-warm); background: var(--surface-2); box-shadow: 0 12px 28px #0008; scrollbar-width: thin; scrollbar-color: var(--line-warm) transparent; }
.select-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 9px 10px; box-sizing: border-box; line-height: 1.6; cursor: pointer; }
.select-option .select-label { overflow-wrap: anywhere; }
.select-option > svg { flex: 0 0 auto; color: var(--oak); }
.select-option.is-selected { color: var(--oak); }
.select-option.is-active { background: var(--oak-soft); }
@media (prefers-reduced-motion: reduce) { .select-trigger > svg { transition: none; } }
</style>
