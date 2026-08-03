const RECENT_COMPOSITION_WINDOW_MS = 100;
const composingTargets = new WeakSet<EventTarget>();
const compositionEndedAt = new WeakMap<EventTarget, number>();

function targetOf(event: Event): EventTarget | null {
    return event.currentTarget ?? event.target;
}

export function onImeCompositionStart(event: CompositionEvent): void {
    const target = targetOf(event);
    if (!target) return;
    composingTargets.add(target);
    compositionEndedAt.delete(target);
}

export function onImeCompositionEnd(event: CompositionEvent): void {
    const target = targetOf(event);
    if (!target) return;
    composingTargets.delete(target);
    compositionEndedAt.set(target, Date.now());
}

/**
 * 部分浏览器会先触发 compositionend，再派发用于确认候选词的 Enter。
 * 除标准字段和旧式 keyCode 229 外，再按输入元素吞掉紧随组合结束的第一个 Enter。
 */
export function isImeComposing(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return true;

    const target = targetOf(event);
    if (!target) return false;
    if (composingTargets.has(target)) return true;

    const endedAt = compositionEndedAt.get(target);
    if (endedAt === undefined) return false;
    compositionEndedAt.delete(target);
    return Date.now() - endedAt <= RECENT_COMPOSITION_WINDOW_MS;
}
