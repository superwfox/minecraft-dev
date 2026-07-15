/**
 * IME confirmation can surface as either a composing event or the legacy
 * keyCode 229, depending on the browser and input method.
 */
export function isImeComposing(event: KeyboardEvent): boolean {
    return event.isComposing || event.keyCode === 229;
}
