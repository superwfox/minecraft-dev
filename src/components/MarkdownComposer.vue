<template>
  <div
    ref="editorEl"
    class="markdown-composer"
    :class="{ 'is-empty': visuallyEmpty, 'is-disabled': disabled }"
    :contenteditable="disabled ? 'false' : 'true'"
    :data-placeholder="placeholder"
    :aria-placeholder="placeholder"
    :aria-disabled="disabled"
    role="textbox"
    aria-multiline="true"
    spellcheck="true"
    @beforeinput="onBeforeInput"
    @input="onInput"
    @keydown="onKeydown"
    @compositionstart="onCompositionStart"
    @compositionend="onCompositionEnd"
    @paste="onPaste"
    @dragover.prevent
    @drop="onDrop"
  ></div>
</template>

<script setup lang="ts">
import {nextTick, onMounted, ref, watch} from "vue";
import {editorToMarkdown, markdownToEditorHtml} from "../logic/composerMarkdown";

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
}>(), {
  placeholder: "",
  disabled: false,
});

const emit = defineEmits<{
  (event: "update:modelValue", value: string): void;
  (event: "submit"): void;
}>();

const editorEl = ref<HTMLElement | null>(null);
const visuallyEmpty = ref(true);
const composing = ref(false);
let lastEditorMarkdown = "";

const BLOCK_SELECTOR = "p, div, h1, h2, h3, h4, h5, h6, li, pre";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

function isImeEvent(event?: KeyboardEvent) {
  return composing.value || !!event?.isComposing || event?.keyCode === 229;
}

function currentSelection() {
  const root = editorEl.value;
  const selection = window.getSelection();
  if (!root || !selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return {root, selection, range};
}

function setCaret(target: Node, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(target, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setCaretAtStart(element: HTMLElement) {
  const first = element.firstChild;
  if (first?.nodeType === Node.TEXT_NODE) setCaret(first, 0);
  else setCaret(element, 0);
}

function meaningfulChildren(root: HTMLElement) {
  return Array.from(root.childNodes).filter((node) =>
    node.nodeType !== Node.COMMENT_NODE
    && (node.nodeType !== Node.TEXT_NODE || !!node.textContent?.trim()),
  );
}

function currentBlock() {
  const state = currentSelection();
  if (!state) return null;
  let node: Node | null = state.range.startContainer;
  if (node === state.root) {
    const childIndex = Math.max(0, state.range.startOffset - 1);
    node = state.root.childNodes[childIndex] || state.root.firstChild;
  }
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== state.root) {
    if (node instanceof HTMLElement && node.matches(BLOCK_SELECTOR)) return node;
    node = node.parentNode;
  }
  return null;
}

function closestWithinRoot(selector: string) {
  const state = currentSelection();
  if (!state) return null;
  let node: Node | null = state.range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== state.root) {
    if (node instanceof HTMLElement && node.matches(selector)) return node;
    node = node.parentNode;
  }
  return null;
}

function ensureEmptyBlock() {
  const root = editorEl.value;
  if (!root) return;
  const hasBlockContent = Array.from(root.childNodes).some((node) => {
    if (node.nodeType === Node.TEXT_NODE) return !!node.textContent?.trim();
    return node instanceof HTMLElement && node.tagName.toLowerCase() !== "br";
  });
  if (hasBlockContent) return;

  const preserved = Array.from(root.childNodes).filter((node) => node.nodeType !== Node.COMMENT_NODE);
  const paragraph = document.createElement("p");
  root.replaceChildren();
  preserved.forEach((node) => paragraph.appendChild(node));
  if (!paragraph.childNodes.length) paragraph.appendChild(document.createElement("br"));
  root.appendChild(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderMarkdown(markdown: string) {
  const root = editorEl.value;
  if (!root) return;
  root.innerHTML = markdownToEditorHtml(markdown) || "<p><br></p>";
  visuallyEmpty.value = !markdown.trim();
  lastEditorMarkdown = markdown;
}

function scrollCaretIntoView() {
  requestAnimationFrame(() => {
    const root = editorEl.value;
    const state = currentSelection();
    if (!root || !state) return;

    const caretRect = state.range.getClientRects().item(0);
    const startElement = state.range.startContainer instanceof Element
      ? state.range.startContainer
      : state.range.startContainer.parentElement;
    const targetRect = caretRect || startElement?.getBoundingClientRect();
    if (!targetRect) return;

    const rootRect = root.getBoundingClientRect();
    const margin = 6;
    if (targetRect.bottom > rootRect.bottom - margin) {
      root.scrollTop += targetRect.bottom - rootRect.bottom + margin;
    } else if (targetRect.top < rootRect.top + margin) {
      root.scrollTop -= rootRect.top - targetRect.top + margin;
    }
  });
}

function syncModelFromEditor() {
  const markdown = editorToMarkdown(editorEl.value);
  lastEditorMarkdown = markdown;
  visuallyEmpty.value = !markdown.trim();
  emit("update:modelValue", markdown);
  scrollCaretIntoView();
  return markdown;
}

function focusEnd() {
  const root = editorEl.value;
  if (!root || props.disabled) return;
  root.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

defineExpose({focusEnd});

function replaceBlock(block: HTMLElement, replacement: HTMLElement, caretTarget: HTMLElement = replacement) {
  block.replaceWith(replacement);
  setCaretAtStart(caretTarget);
}

function maybeApplyBlockShortcut() {
  const state = currentSelection();
  const block = currentBlock();
  if (!state || !block || !state.range.collapsed || block.matches("li, pre")) return false;
  if (!block.matches("p, div")) return false;

  const text = block.textContent || "";
  const caretProbe = document.createRange();
  caretProbe.selectNodeContents(block);
  caretProbe.setEnd(state.range.startContainer, state.range.startOffset);
  if (caretProbe.toString() !== text) return false;

  const heading = text.match(/^(#{1,6}) $/);
  if (heading) {
    const nextHeading = document.createElement(`h${heading[1].length}`);
    nextHeading.appendChild(document.createElement("br"));
    replaceBlock(block, nextHeading);
    return true;
  }

  if (text === "1. " || text === "- " || text === "* ") {
    const list = document.createElement(text === "1. " ? "ol" : "ul");
    const item = document.createElement("li");
    item.appendChild(document.createElement("br"));
    list.appendChild(item);
    replaceBlock(block, list, item);
    return true;
  }

  return false;
}

function activeTextNode() {
  const state = currentSelection();
  if (!state || !state.range.collapsed) return null;
  let node = state.range.startContainer;
  let offset = state.range.startOffset;
  if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
    const previous = node.childNodes[offset - 1];
    if (previous?.nodeType === Node.TEXT_NODE) {
      node = previous;
      offset = previous.textContent?.length || 0;
    }
  }
  if (!(node instanceof Text)) return null;
  return {node, offset};
}

function replaceTextMarker(node: Text, start: number, end: number, tag: "strong" | "code", content: string) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  range.deleteContents();
  const formatted = document.createElement(tag);
  formatted.textContent = content;
  range.insertNode(formatted);

  const tail = formatted.nextSibling instanceof Text
    ? formatted.nextSibling
    : formatted.parentNode?.insertBefore(document.createTextNode(""), formatted.nextSibling) || null;
  if (tail) setCaret(tail, 0);
  else setCaret(formatted.parentNode || formatted, formatted.parentNode ? Array.from(formatted.parentNode.childNodes).indexOf(formatted) + 1 : 1);
}

function findOpenBacktickDelimiter(value: string) {
  let openLength = 0;
  let openStart = -1;
  for (let index = 0; index < value.length;) {
    if (value[index] !== "`") {
      index++;
      continue;
    }

    let end = index + 1;
    while (value[end] === "`") end++;
    const runLength = end - index;
    if (!openLength) {
      openLength = runLength;
      openStart = index;
    } else if (runLength === openLength) {
      openLength = 0;
      openStart = -1;
    }
    index = end;
  }
  return openLength ? {length: openLength, start: openStart} : null;
}

function maybeApplyInlineShortcut() {
  const block = currentBlock();
  if (!block || block.matches("pre")) return false;
  block.normalize();

  if (closestWithinRoot("pre, code")) return false;
  const active = activeTextNode();
  if (!active) return false;
  const before = active.node.data.slice(0, active.offset);
  if (findOpenBacktickDelimiter(before)) return false;

  const bold = before.match(/\*\*([^*\r\n]+)\*\*$/);
  if (bold) {
    replaceTextMarker(active.node, active.offset - bold[0].length, active.offset, "strong", bold[1]);
    return true;
  }

  const doubleCode = before.match(/(^|[^`])``((?:(?!``)[^\r\n])+)``$/);
  if (doubleCode) {
    const markerLength = doubleCode[0].length - doubleCode[1].length;
    replaceTextMarker(active.node, active.offset - markerLength, active.offset, "code", doubleCode[2]);
    return true;
  }

  const inlineCode = before.match(/(^|[^`])`([^`\r\n]+)`$/);
  if (inlineCode) {
    const markerLength = inlineCode[0].length - inlineCode[1].length;
    replaceTextMarker(active.node, active.offset - markerLength, active.offset, "code", inlineCode[2]);
    return true;
  }

  return false;
}

function finalizeOpenInlineCode() {
  if (closestWithinRoot("pre, code, [data-code-fence-draft]")) return false;
  const block = currentBlock();
  if (!block) return false;
  block.normalize();

  const active = activeTextNode();
  if (!active) return false;
  const before = active.node.data.slice(0, active.offset);
  const delimiter = findOpenBacktickDelimiter(before);
  if (!delimiter || delimiter.length >= 3) return false;

  const content = before.slice(delimiter.start + delimiter.length);
  if (content) {
    replaceTextMarker(active.node, delimiter.start, active.offset, "code", content);
  } else {
    active.node.deleteData(delimiter.start, active.offset - delimiter.start);
    setCaret(active.node, delimiter.start);
  }
  return true;
}

function applyTypingShortcuts() {
  if (maybeApplyClosedCodeFence()) return true;
  if (closestWithinRoot("[data-code-fence-draft]")) return false;
  if (maybeApplyBlockShortcut()) return true;
  return maybeApplyInlineShortcut();
}

function onInput() {
  if (!composing.value) applyTypingShortcuts();
  ensureEmptyBlock();
  syncModelFromEditor();
}

function onCompositionStart() {
  composing.value = true;
}

function onCompositionEnd() {
  composing.value = false;
  nextTick(() => {
    applyTypingShortcuts();
    ensureEmptyBlock();
    syncModelFromEditor();
  });
}

function isPlainSingleParagraph() {
  const root = editorEl.value;
  if (!root) return true;
  const children = meaningfulChildren(root);
  if (!children.length) return true;
  if (children.length !== 1) return false;
  const only = children[0];
  if (only.nodeType === Node.TEXT_NODE) return !(only.textContent || "").includes("\n");
  if (!(only instanceof HTMLElement) || !only.matches("p, div")) return false;
  return !only.querySelector("br, strong, b, code, pre, ol, ul, h1, h2, h3, h4, h5, h6");
}

function requestSubmit() {
  const markdown = syncModelFromEditor();
  if (markdown.trim()) emit("submit");
}

function codeFenceAtCaret() {
  const state = currentSelection();
  const block = currentBlock();
  if (!state || !block || !state.range.collapsed || !block.matches("p, div")) return null;
  const match = (block.textContent || "").match(/^ {0,3}(`{3,})(?:[ \t]*([^`\r\n]*?))?[ \t]*$/);
  if (!match) return null;
  const probe = document.createRange();
  probe.selectNodeContents(block);
  probe.setEnd(state.range.startContainer, state.range.startOffset);
  return probe.toString() === block.textContent
    ? {block, fenceLength: match[1].length, language: (match[2] || "").trim()}
    : null;
}

function startCodeFenceDraft(block: HTMLElement) {
  if (block.lastChild instanceof HTMLBRElement) block.lastChild.remove();
  block.dataset.codeFenceDraft = "";
  insertLiteralNewline();
  syncModelFromEditor();
}

function parseClosedCodeFence(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n");
  const firstBreak = normalized.indexOf("\n");
  const lastBreak = normalized.lastIndexOf("\n");
  if (firstBreak < 0 || lastBreak < firstBreak) return null;

  const opening = normalized.slice(0, firstBreak).match(/^ {0,3}(`{3,})(?:[ \t]*([^`\r\n]*?))?[ \t]*$/);
  const closing = normalized.slice(lastBreak + 1).match(/^ {0,3}(`{3,})[ \t]*$/);
  if (!opening || !closing || closing[1].length < opening[1].length) return null;

  return {
    content: normalized.slice(firstBreak + 1, lastBreak),
    language: (opening[2] || "").trim(),
  };
}

function maybeApplyClosedCodeFence() {
  const state = currentSelection();
  const block = currentBlock();
  if (!state || !block || !state.range.collapsed || !block.hasAttribute("data-code-fence-draft")) return false;
  block.normalize();

  const value = block.textContent || "";
  const parsed = parseClosedCodeFence(value);
  if (!parsed) return false;

  const probe = document.createRange();
  probe.selectNodeContents(block);
  probe.setEnd(state.range.startContainer, state.range.startOffset);
  if (probe.toString() !== value) return false;

  const pre = document.createElement("pre");
  if (parsed.language) pre.dataset.language = parsed.language;
  const code = document.createElement("code");
  code.appendChild(parsed.content ? document.createTextNode(parsed.content) : document.createElement("br"));
  pre.appendChild(code);

  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  block.replaceWith(pre, paragraph);
  setCaretAtStart(paragraph);
  return true;
}

function caretOffsetWithin(element: HTMLElement) {
  const state = currentSelection();
  if (!state || !element.contains(state.range.startContainer)) return -1;
  const probe = document.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(state.range.startContainer, state.range.startOffset);
  return probe.toString().length;
}

function exitCodeBlock(pre: HTMLElement, code: HTMLElement) {
  const value = (code.textContent || "").replace(/\n$/, "");
  code.replaceChildren(value ? document.createTextNode(value) : document.createElement("br"));
  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  pre.insertAdjacentElement("afterend", paragraph);
  setCaret(paragraph, 0);
}

function insertLiteralNewline() {
  const state = currentSelection();
  if (!state) return;
  state.range.deleteContents();
  const newline = document.createTextNode("\n");
  state.range.insertNode(newline);
  setCaret(newline, 1);
}

function handleCodeBlockEnter(pre: HTMLElement) {
  const code = pre.querySelector(":scope > code") as HTMLElement | null || pre;
  const value = code.textContent || "";
  const atEnd = caretOffsetWithin(code) === value.length;
  if (atEnd && value.endsWith("\n")) exitCodeBlock(pre, code);
  else insertLiteralNewline();
  syncModelFromEditor();
}

function splitHeading(heading: HTMLElement) {
  const state = currentSelection();
  if (!state) return;
  const tailRange = document.createRange();
  tailRange.setStart(state.range.startContainer, state.range.startOffset);
  tailRange.setEnd(heading, heading.childNodes.length);
  const tail = tailRange.extractContents();

  if (!heading.textContent && !heading.querySelector("br")) heading.appendChild(document.createElement("br"));
  const paragraph = document.createElement("p");
  if (tail.childNodes.length) paragraph.appendChild(tail);
  else paragraph.appendChild(document.createElement("br"));
  heading.insertAdjacentElement("afterend", paragraph);
  setCaretAtStart(paragraph);
  syncModelFromEditor();
}

function splitParagraph(block: HTMLElement) {
  const state = currentSelection();
  if (!state || !block.contains(state.range.startContainer)) return;
  state.range.deleteContents();

  const tailRange = document.createRange();
  tailRange.setStart(state.range.startContainer, state.range.startOffset);
  tailRange.setEnd(block, block.childNodes.length);
  const tail = tailRange.extractContents();

  ensureEditableBlockContent(block);
  const paragraph = document.createElement("p");
  if (tail.childNodes.length) paragraph.appendChild(tail);
  ensureEditableBlockContent(paragraph);
  block.insertAdjacentElement("afterend", paragraph);
  setCaretAtStart(paragraph);
  syncModelFromEditor();
}

function ensureEditableBlockContent(element: HTMLElement) {
  if (!element.textContent && !element.querySelector("br")) {
    element.appendChild(document.createElement("br"));
  }
}

function exitListItem(item: HTMLElement) {
  const list = item.parentElement;
  if (!list || !list.matches("ol, ul")) return;

  const items = Array.from(list.children);
  const itemIndex = items.indexOf(item);
  const trailing = items.slice(itemIndex + 1);
  const trailingList = trailing.length ? list.cloneNode(false) as HTMLElement : null;
  if (trailingList) {
    if (list.matches("ol")) {
      const start = Number(list.getAttribute("start") || "1");
      trailingList.setAttribute("start", String(start + itemIndex + 1));
    }
    for (const sibling of trailing) trailingList.appendChild(sibling);
  }

  item.remove();
  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  if (list.children.length) list.insertAdjacentElement("afterend", paragraph);
  else list.replaceWith(paragraph);
  if (trailingList) paragraph.insertAdjacentElement("afterend", trailingList);
  setCaretAtStart(paragraph);
}

function splitListItem(item: HTMLElement) {
  const state = currentSelection();
  if (!state || !item.contains(state.range.startContainer)) return;
  state.range.deleteContents();

  const tailRange = document.createRange();
  tailRange.setStart(state.range.startContainer, state.range.startOffset);
  tailRange.setEnd(item, item.childNodes.length);
  const tail = tailRange.extractContents();

  ensureEditableBlockContent(item);
  const nextItem = document.createElement("li");
  if (tail.childNodes.length) nextItem.appendChild(tail);
  ensureEditableBlockContent(nextItem);
  item.insertAdjacentElement("afterend", nextItem);
  setCaretAtStart(nextItem);
}

function handleListItemEnter(item: HTMLElement) {
  if (!(item.textContent || "").trim()) exitListItem(item);
  else splitListItem(item);
  syncModelFromEditor();
}

function insertSoftBreak() {
  const state = currentSelection();
  if (!state) return;
  state.range.deleteContents();
  const lineBreak = document.createElement("br");
  state.range.insertNode(lineBreak);
  setCaret(lineBreak.parentNode || state.root, Array.from((lineBreak.parentNode || state.root).childNodes).indexOf(lineBreak) + 1);
  syncModelFromEditor();
}

function handleSoftBreak() {
  if (closestWithinRoot("[data-code-fence-draft]")) {
    insertLiteralNewline();
    syncModelFromEditor();
    return;
  }
  finalizeOpenInlineCode();
  insertSoftBreak();
}

function handleUnmodifiedEnter(event: Event) {
  const pre = closestWithinRoot("pre");
  if (pre) {
    event.preventDefault();
    handleCodeBlockEnter(pre);
    return true;
  }

  if (closestWithinRoot("[data-code-fence-draft]")) {
    event.preventDefault();
    insertLiteralNewline();
    syncModelFromEditor();
    return true;
  }

  const inlineFinalized = finalizeOpenInlineCode();
  const listItem = closestWithinRoot("li");
  if (listItem) {
    event.preventDefault();
    handleListItemEnter(listItem);
    return true;
  }

  const fence = codeFenceAtCaret();
  if (fence) {
    event.preventDefault();
    startCodeFenceDraft(fence.block);
    return true;
  }

  const heading = closestWithinRoot(HEADING_SELECTOR);
  if (heading) {
    event.preventDefault();
    splitHeading(heading);
    return true;
  }

  if (inlineFinalized) {
    event.preventDefault();
    insertSoftBreak();
    return true;
  }

  if (isPlainSingleParagraph()) {
    event.preventDefault();
    requestSubmit();
    return true;
  }

  const paragraph = currentBlock();
  if (paragraph?.matches("p, div")) {
    event.preventDefault();
    splitParagraph(paragraph);
    return true;
  }
  return false;
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled || event.key !== "Enter" || isImeEvent(event)) return;
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    requestSubmit();
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    handleSoftBreak();
    return;
  }
  handleUnmodifiedEnter(event);
}

function onBeforeInput(event: InputEvent) {
  if (props.disabled || composing.value || !event.cancelable) return;
  if (event.inputType === "insertParagraph") handleUnmodifiedEnter(event);
  if (event.inputType === "insertLineBreak") {
    event.preventDefault();
    handleSoftBreak();
  }
}

function insertGeneratedHtml(html: string) {
  const root = editorEl.value;
  if (!root) return;
  root.focus();
  const state = currentSelection();
  if (!state || visuallyEmpty.value) {
    root.innerHTML = html || "<p><br></p>";
    focusEnd();
    return;
  }

  if (document.execCommand("insertHTML", false, html)) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  const last = fragment.lastChild;
  state.range.deleteContents();
  state.range.insertNode(fragment);
  if (last) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(last);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

function insertPlainText(value: string) {
  const state = currentSelection();
  if (!state) return;
  state.range.deleteContents();
  const text = document.createTextNode(value.replace(/\r\n?/g, "\n"));
  state.range.insertNode(text);
  setCaret(text, text.data.length);
}

function onPaste(event: ClipboardEvent) {
  if (props.disabled) return;
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!text) return;
  if (closestWithinRoot("[data-code-fence-draft]")) {
    insertPlainText(text);
    applyTypingShortcuts();
    ensureEmptyBlock();
    syncModelFromEditor();
    return;
  }
  insertGeneratedHtml(markdownToEditorHtml(text));
  ensureEmptyBlock();
  syncModelFromEditor();
}

function onDrop(event: DragEvent) {
  // Dropped fragments may carry arbitrary HTML and files; the composer only accepts typed or pasted text.
  event.preventDefault();
}

watch(() => props.modelValue, (value) => {
  if (value === lastEditorMarkdown) return;
  renderMarkdown(value);
});

watch(() => props.disabled, (disabled) => {
  if (disabled && document.activeElement === editorEl.value) editorEl.value?.blur();
});

onMounted(() => renderMarkdown(props.modelValue));
</script>

<style scoped>
.markdown-composer {
  position: relative;
  flex: 1;
  width: 100%;
  min-height: 92px;
  padding: 0;
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  background: transparent;
  border: 0;
  outline: 0;
  color: #f4f1ec;
  caret-color: var(--warm-light, #d5c9ac);
  font: 400 16px/1.52 system-ui, "Noto Sans SC", "PingFang SC", sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.markdown-composer.is-empty::before {
  position: absolute;
  inset: 0 auto auto 0;
  color: rgba(232, 227, 217, 0.48);
  content: attr(data-placeholder);
  pointer-events: none;
}

.markdown-composer.is-disabled {
  cursor: not-allowed;
}

.markdown-composer::selection,
.markdown-composer :deep(*)::selection {
  color: #fff;
  background: rgba(167, 147, 105, 0.45);
}

.markdown-composer :deep(p) {
  min-height: 1.52em;
  margin: 0;
}

.markdown-composer :deep(p + p) {
  margin-top: 0.25em;
}

.markdown-composer :deep(h1),
.markdown-composer :deep(h2),
.markdown-composer :deep(h3),
.markdown-composer :deep(h4),
.markdown-composer :deep(h5),
.markdown-composer :deep(h6) {
  margin: 0;
  color: #fffdfa;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1.3;
}

.markdown-composer :deep(h1) { font-size: 1.45em; }
.markdown-composer :deep(h2) { font-size: 1.32em; }
.markdown-composer :deep(h3) { font-size: 1.2em; }
.markdown-composer :deep(h4) { font-size: 1.1em; }
.markdown-composer :deep(h5) { font-size: 1em; }
.markdown-composer :deep(h6) { font-size: 0.92em; color: rgba(244, 241, 236, 0.82); }

.markdown-composer :deep(ol),
.markdown-composer :deep(ul) {
  margin: 0;
  padding-left: 1.55em;
}

.markdown-composer :deep(li) {
  min-height: 1.52em;
  padding-left: 0.12em;
}

.markdown-composer :deep(li::marker) {
  color: rgba(213, 201, 172, 0.78);
}

.markdown-composer :deep(strong),
.markdown-composer :deep(b) {
  color: #fffdfa;
  font-weight: 720;
}

.markdown-composer :deep(code) {
  padding: 0.08em 0.3em;
  border: 1px solid rgba(213, 201, 172, 0.14);
  border-radius: 4px;
  background: rgba(10, 10, 9, 0.52);
  color: #e7d7b2;
  font: 0.9em/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.markdown-composer :deep(pre) {
  position: relative;
  min-height: 2.9em;
  margin: 0.35em 0;
  padding: 10px 12px;
  overflow-x: auto;
  border: 1px solid rgba(213, 201, 172, 0.14);
  border-radius: 6px;
  background: rgba(10, 10, 9, 0.58);
  color: #e7d7b2;
  white-space: pre-wrap;
  tab-size: 2;
}

.markdown-composer :deep(pre[data-language]::before) {
  display: block;
  margin-bottom: 4px;
  color: rgba(213, 201, 172, 0.45);
  content: attr(data-language);
  font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-transform: lowercase;
  pointer-events: none;
}

.markdown-composer :deep(pre > code) {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (max-width: 520px) {
  .markdown-composer {
    font-size: 14px;
  }
}
</style>
