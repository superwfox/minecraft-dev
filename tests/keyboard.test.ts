import {describe, expect, it} from "vitest";
import {
    isImeComposing,
    onImeCompositionEnd,
    onImeCompositionStart,
} from "../src/logic/keyboard";

function compositionEvent(target: EventTarget): CompositionEvent {
    return {currentTarget: target, target} as unknown as CompositionEvent;
}

function keyboardEvent(
    target: EventTarget,
    overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
    return {
        currentTarget: target,
        target,
        isComposing: false,
        keyCode: 13,
        ...overrides,
    } as unknown as KeyboardEvent;
}

describe("IME Enter guard", () => {
    it("blocks Enter while the target is composing", () => {
        const target = {} as EventTarget;
        onImeCompositionStart(compositionEvent(target));

        expect(isImeComposing(keyboardEvent(target))).toBe(true);
    });

    it("blocks only the first Enter immediately after composition ends", () => {
        const target = {} as EventTarget;
        const event = compositionEvent(target);
        onImeCompositionStart(event);
        onImeCompositionEnd(event);

        expect(isImeComposing(keyboardEvent(target))).toBe(true);
        expect(isImeComposing(keyboardEvent(target))).toBe(false);
    });

    it("keeps the standard and legacy browser checks", () => {
        const target = {} as EventTarget;

        expect(isImeComposing(keyboardEvent(target, {isComposing: true}))).toBe(true);
        expect(isImeComposing(keyboardEvent(target, {keyCode: 229}))).toBe(true);
    });
});
