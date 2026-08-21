export type PrecheckGuidanceItem = {
    topic: string;
    detail: string;
};

export type PrecheckGuidance = {
    heading: string;
    items: PrecheckGuidanceItem[];
};

export type PrecheckResult = {
    complete: boolean;
    guidance?: PrecheckGuidance;
};

const DEFAULT_GUIDANCE_HEADING = "还需要补充";
const DEFAULT_GUIDANCE_ITEMS: PrecheckGuidanceItem[] = [
    {topic: "核心功能", detail: "插件最主要要实现什么玩法或系统行为？"},
    {topic: "玩家交互", detail: "玩家通过什么操作、命令或事件使用它？"},
    {topic: "触发条件", detail: "功能在什么条件下开始、结束或重置？"},
];

function cleanLine(value: unknown): string {
    return typeof value === "string"
        ? value.replace(/\s+/g, " ").trim()
        : "";
}

function cleanItemText(value: unknown): string {
    return cleanLine(value)
        .replace(/^请补充\s*[:：]?\s*/u, "")
        .replace(/^\d+[.)、]\s*/u, "")
        .replace(/^[-*•]\s*/u, "")
        .trim();
}

function normalizeGuidanceItem(value: unknown): PrecheckGuidanceItem | null {
    if (typeof value === "string") {
        const line = cleanItemText(value);
        if (!line) return null;
        const separated = line.match(/^([^:：]{1,24})[:：]\s*(.+)$/u);
        return separated
            ? {topic: separated[1].trim(), detail: separated[2].trim()}
            : {topic: line, detail: ""};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const topic = cleanItemText(item.topic);
    const detail = cleanLine(item.detail);
    if (!topic && !detail) return null;
    return {topic: topic || "补充说明", detail};
}

function uniqueItems(values: unknown[]): PrecheckGuidanceItem[] {
    const seen = new Set<string>();
    const items: PrecheckGuidanceItem[] = [];
    for (const value of values) {
        const item = normalizeGuidanceItem(value);
        if (!item) continue;
        const key = `${item.topic}\u0000${item.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        if (items.length >= 3) break;
    }
    return items;
}

function legacyHintItems(value: unknown): PrecheckGuidanceItem[] {
    if (typeof value !== "string") return [];
    const normalized = value
        .replace(/^请补充\s*[:：]?\s*/u, "")
        .replace(/(?:^|[；;\n])\s*(?=\d+[.)、])/gu, "\n");
    return uniqueItems(normalized.split(/[；;\n]+/u));
}

export function normalizePrecheckGuidance(value: unknown): PrecheckGuidance {
    const payload = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const structuredItems = Array.isArray(payload.items) ? uniqueItems(payload.items) : [];
    const items = structuredItems.length ? structuredItems : legacyHintItems(payload.hint);
    return {
        heading: cleanLine(payload.heading) || DEFAULT_GUIDANCE_HEADING,
        items: items.length ? items : DEFAULT_GUIDANCE_ITEMS.map(item => ({...item})),
    };
}

export function normalizePrecheckPayload(value: unknown): PrecheckResult | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const payload = value as Record<string, unknown>;
    if (typeof payload.complete !== "boolean") return null;
    if (payload.complete) return { complete: true };

    return {
        complete: false,
        guidance: normalizePrecheckGuidance(payload),
    };
}

export function normalizeFormattedPrompt(raw: string): string {
    const trimmed = String(raw ?? "").trim();
    const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/iu);
    return (fenced ? fenced[1] : trimmed).trim();
}

export function shouldAcceptFormattedPrompt(input: {
    source: string;
    current: string;
    requestRevision: number;
    currentRevision: number;
    formatted: string;
    aborted: boolean;
    composing: boolean;
    disabled: boolean;
}): boolean {
    return !input.aborted
        && !input.composing
        && !input.disabled
        && input.requestRevision === input.currentRevision
        && input.source === input.current
        && !!input.formatted.trim()
        && input.formatted.trim() !== input.source.trim();
}

export type PromptFormatSchedulePhase = "idle" | "debouncing";

export type IdlePromptScheduler = {
    schedule: (text: string, eligible?: boolean) => PromptFormatSchedulePhase;
    cancel: () => void;
    suppressNext: (text: string) => void;
    reset: (options?: {forgetLastRequested?: boolean}) => void;
    lastRequestedText: () => string;
};

export function createIdlePromptScheduler(
    onRequest: (text: string) => void,
    delayMs = 3_000,
): IdlePromptScheduler {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRequested = "";
    let suppressed = "";

    const cancel = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
    };

    return {
        schedule(text, eligible = true) {
            cancel();
            if (suppressed && text === suppressed) {
                suppressed = "";
                return "idle";
            }
            suppressed = "";
            if (!eligible || !text.trim() || text === lastRequested) return "idle";
            timer = setTimeout(() => {
                timer = null;
                if (text === lastRequested) return;
                lastRequested = text;
                onRequest(text);
            }, Math.max(0, delayMs));
            return "debouncing";
        },
        cancel,
        suppressNext(text) {
            cancel();
            suppressed = text;
            lastRequested = text;
        },
        reset(options = {}) {
            cancel();
            suppressed = "";
            if (options.forgetLastRequested) lastRequested = "";
        },
        lastRequestedText() {
            return lastRequested;
        },
    };
}
