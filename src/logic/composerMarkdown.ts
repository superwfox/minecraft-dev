/**
 * Safe, dependency-free Markdown codec for the chat composer.
 *
 * This intentionally supports only the structures the composer can edit. Raw
 * HTML is never passed through: Markdown text is escaped before it reaches the
 * DOM, and unsupported DOM elements are unwrapped during serialization.
 */

const ESCAPABLE_MARKDOWN = /[\\`*_{}\[\]()#+\-.!<>&]/;

interface FenceStart {
    length: number;
    language: string;
}

interface OrderedItem {
    number: number;
    content: string;
}

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n?/g, "\n");
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
        switch (character) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "\"": return "&quot;";
            default: return "&#39;";
        }
    });
}

function runLengthAt(value: string, index: number, character: string): number {
    let end = index;
    while (end < value.length && value[end] === character) end++;
    return end - index;
}

function isEscaped(value: string, index: number): boolean {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
    return slashes % 2 === 1;
}

function findClosingBackticks(value: string, from: number, delimiterLength: number): number {
    let cursor = from;
    while (cursor < value.length) {
        const tick = value.indexOf("`", cursor);
        if (tick < 0) return -1;
        const length = runLengthAt(value, tick, "`");
        if (length === delimiterLength) return tick;
        cursor = tick + length;
    }
    return -1;
}

function findClosingStrong(value: string, from: number, delimiter: "**" | "__"): number {
    let cursor = from;
    while (cursor < value.length) {
        const close = value.indexOf(delimiter, cursor);
        if (close < 0) return -1;
        if (!isEscaped(value, close)) return close;
        cursor = close + delimiter.length;
    }
    return -1;
}

function renderInline(markdown: string): string {
    let html = "";
    let index = 0;

    while (index < markdown.length) {
        const character = markdown[index];

        if (character === "\\" && index + 1 < markdown.length
            && ESCAPABLE_MARKDOWN.test(markdown[index + 1])) {
            html += escapeHtml(markdown[index + 1]);
            index += 2;
            continue;
        }

        if (character === "`") {
            const delimiterLength = runLengthAt(markdown, index, "`");
            const contentStart = index + delimiterLength;
            const close = findClosingBackticks(markdown, contentStart, delimiterLength);
            if (close >= 0) {
                html += `<code>${escapeHtml(markdown.slice(contentStart, close))}</code>`;
                index = close + delimiterLength;
                continue;
            }
        }

        const delimiter = markdown.startsWith("**", index)
            ? "**"
            : markdown.startsWith("__", index) ? "__" : null;
        if (delimiter) {
            const contentStart = index + delimiter.length;
            const close = findClosingStrong(markdown, contentStart, delimiter);
            if (close > contentStart) {
                html += `<strong>${renderInline(markdown.slice(contentStart, close))}</strong>`;
                index = close + delimiter.length;
                continue;
            }
        }

        html += escapeHtml(character);
        index++;
    }

    return html;
}

function parseFenceStart(line: string): FenceStart | null {
    const match = line.match(/^ {0,3}(`{3,})(?:[ \t]*([^`]*?))?[ \t]*$/);
    if (!match) return null;
    return {length: match[1].length, language: (match[2] || "").trim()};
}

function isFenceEnd(line: string, minimumLength: number): boolean {
    const match = line.match(/^ {0,3}(`{3,})[ \t]*$/);
    return !!match && match[1].length >= minimumLength;
}

function parseHeading(line: string): { level: number; content: string } | null {
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/);
    if (!match) return null;
    return {level: match[1].length, content: match[2] || ""};
}

function parseUnorderedItem(line: string): string | null {
    const match = line.match(/^ {0,3}[-+*][ \t]+(.*)$/);
    return match ? match[1] : null;
}

function parseOrderedItem(line: string): OrderedItem | null {
    const match = line.match(/^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/);
    if (!match) return null;
    return {number: Number(match[1]), content: match[2]};
}

function startsBlock(line: string): boolean {
    return /^[ \t]*$/.test(line)
        || !!parseFenceStart(line)
        || !!parseHeading(line)
        || parseUnorderedItem(line) !== null
        || !!parseOrderedItem(line);
}

/** Convert the supported Markdown subset into HTML suitable for contenteditable. */
export function markdownToEditorHtml(markdown: string): string {
    const lines = normalizeLineEndings(String(markdown ?? "")).split("\n");
    const html: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];

        if (/^[ \t]*$/.test(line)) {
            html.push("<p><br></p>");
            index++;
            continue;
        }

        const fence = parseFenceStart(line);
        if (fence) {
            let closingIndex = index + 1;
            while (closingIndex < lines.length && !isFenceEnd(lines[closingIndex], fence.length)) {
                closingIndex++;
            }
            if (closingIndex < lines.length) {
                const language = fence.language
                    ? ` data-language="${escapeHtml(fence.language)}"`
                    : "";
                html.push(`<pre${language}><code>${escapeHtml(lines.slice(index + 1, closingIndex).join("\n"))}</code></pre>`);
                index = closingIndex + 1;
                continue;
            }

            html.push(`<p data-code-fence-draft>${escapeHtml(lines.slice(index).join("\n"))}</p>`);
            break;
        }

        const heading = parseHeading(line);
        if (heading) {
            html.push(`<h${heading.level}>${renderInline(heading.content)}</h${heading.level}>`);
            index++;
            continue;
        }

        const unordered = parseUnorderedItem(line);
        if (unordered !== null) {
            const items: string[] = [];
            while (index < lines.length) {
                const item = parseUnorderedItem(lines[index]);
                if (item === null) break;
                items.push(`<li>${renderInline(item)}</li>`);
                index++;
            }
            html.push(`<ul>${items.join("")}</ul>`);
            continue;
        }

        const ordered = parseOrderedItem(line);
        if (ordered) {
            const items: string[] = [];
            const start = ordered.number;
            let expected = start;
            while (index < lines.length) {
                const item = parseOrderedItem(lines[index]);
                if (!item) break;
                const value = item.number === expected ? "" : ` value="${item.number}"`;
                items.push(`<li${value}>${renderInline(item.content)}</li>`);
                expected = item.number + 1;
                index++;
            }
            const startAttribute = start === 1 ? "" : ` start="${start}"`;
            html.push(`<ol${startAttribute}>${items.join("")}</ol>`);
            continue;
        }

        const paragraph: string[] = [line];
        index++;
        while (index < lines.length && !startsBlock(lines[index])) {
            paragraph.push(lines[index]);
            index++;
        }
        html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    }

    return html.join("");
}

function elementName(node: Node): string {
    return node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
}

function escapeMarkdownText(value: string): string {
    return normalizeLineEndings(value)
        .replace(/\u00a0/g, " ")
        .replace(/([\\`*_<>&])/g, "\\$1");
}

function longestBacktickRun(value: string): number {
    let longest = 0;
    for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return longest;
}

function inlineCodeToMarkdown(value: string): string {
    const delimiter = "`".repeat(Math.max(1, longestBacktickRun(value) + 1));
    return `${delimiter}${normalizeLineEndings(value)}${delimiter}`;
}

function inlineNodeToMarkdown(node: Node): string {
    if (node.nodeType === 3) return escapeMarkdownText(node.nodeValue || "");
    if (node.nodeType !== 1) return "";

    const element = node as Element;
    const tag = elementName(element);

    if (tag === "br") return "\n";
    if (tag === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
        return inlineCodeToMarkdown(element.textContent || "");
    }

    const content = Array.from(element.childNodes).map(inlineNodeToMarkdown).join("");
    if (tag === "strong" || tag === "b") return content ? `**${content}**` : "";

    // Spans and every other unsupported element are deliberately unwrapped.
    return content;
}

function plainNodeText(node: Node): string {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    if (elementName(element) === "br") return "\n";
    return Array.from(element.childNodes).map(plainNodeText).join("");
}

function editableElementText(element: Element): string {
    const children = Array.from(element.childNodes);
    const last = children[children.length - 1];
    if (last && elementName(last) === "br") children.pop();
    return children.map(plainNodeText).join("");
}

function isEmptyEditorBlock(element: Element): boolean {
    if ((element.textContent || "").length > 0) return false;
    return Array.from(element.querySelectorAll("*")).every((child) => child.tagName.toLowerCase() === "br");
}

function escapeParagraphStarts(value: string): string {
    return value.split("\n").map((line) => {
        if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)
            || /^ {0,3}[-+][ \t]+/.test(line)
            || /^ {0,3}\d{1,9}[.)][ \t]+/.test(line)) {
            const marker = line.search(/[#\-+\d]/);
            return marker >= 0 ? `${line.slice(0, marker)}\\${line.slice(marker)}` : line;
        }
        return line;
    }).join("\n");
}

function paragraphToMarkdown(element: Element): string {
    if (isEmptyEditorBlock(element)) return "";
    if (element.hasAttribute("data-code-fence-draft")) return normalizeLineEndings(editableElementText(element));
    const content = Array.from(element.childNodes).map(inlineNodeToMarkdown).join("");
    return escapeParagraphStarts(content);
}

function sanitizedFenceLanguage(value: string): string {
    return normalizeLineEndings(value)
        .replace(/[`\u0000-\u001f\u007f]/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function codeBlockLanguage(element: Element, code: Element | null): string {
    const direct = element.getAttribute("data-language") || code?.getAttribute("data-language") || "";
    if (direct) return sanitizedFenceLanguage(direct);
    const languageClass = Array.from(code?.classList || []).find((name) => name.startsWith("language-"));
    return sanitizedFenceLanguage(languageClass?.slice("language-".length) || "");
}

function codeBlockToMarkdown(element: Element): string {
    const first = element.firstElementChild;
    const code = first && elementName(first) === "code" ? first : null;
    const content = normalizeLineEndings(editableElementText(code || element));
    const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    const language = codeBlockLanguage(element, code);
    return `${fence}${language}\n${content}\n${fence}`;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
    if (!value || !/^\d{1,9}$/.test(value)) return fallback;
    const parsed = Number(value);
    return parsed >= 1 ? parsed : fallback;
}

function listItemContent(element: Element): string {
    const content = Array.from(element.childNodes).map(inlineNodeToMarkdown).join("");
    return content.replace(/\n/g, "\n  ");
}

function listToMarkdown(element: Element, ordered: boolean): string {
    let nextNumber = ordered ? parsePositiveInteger(element.getAttribute("start"), 1) : 1;
    const lines: string[] = [];

    for (const child of Array.from(element.children)) {
        if (elementName(child) !== "li") continue;
        if (ordered) {
            const number = parsePositiveInteger(child.getAttribute("value"), nextNumber);
            lines.push(`${number}. ${listItemContent(child)}`);
            nextNumber = number + 1;
        } else {
            lines.push(`- ${listItemContent(child)}`);
        }
    }

    return lines.join("\n");
}

function blockNodeToMarkdown(node: Node): string {
    if (node.nodeType === 3) return escapeParagraphStarts(escapeMarkdownText(node.nodeValue || ""));
    if (node.nodeType !== 1) return "";

    const element = node as Element;
    const tag = elementName(element);

    if (tag === "p" || tag === "div") return paragraphToMarkdown(element);
    if (/^h[1-6]$/.test(tag)) {
        const content = Array.from(element.childNodes).map(inlineNodeToMarkdown).join("");
        return `${"#".repeat(Number(tag[1]))} ${content}`.trimEnd();
    }
    if (tag === "ul") return listToMarkdown(element, false);
    if (tag === "ol") return listToMarkdown(element, true);
    if (tag === "pre") return codeBlockToMarkdown(element);
    if (tag === "br") return "";

    // Unknown root-level elements are unwrapped just like unknown inline nodes.
    return escapeParagraphStarts(inlineNodeToMarkdown(element));
}

/** Serialize a contenteditable root back to the supported Markdown subset. */
export function editorToMarkdown(root: ParentNode | null): string {
    if (!root) return "";
    return Array.from(root.childNodes).map(blockNodeToMarkdown).join("\n");
}
