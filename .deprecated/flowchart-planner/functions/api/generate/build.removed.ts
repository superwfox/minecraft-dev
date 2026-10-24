/**
 * 在 plugin.yml 的 author 字段后追加 TAHAI 水印。幂等：已含 TAHAI 直接返回。
 * 注意：只改上传到 GitHub 的内容，不改任务 state.generatedFiles[*].content，
 * 这样任务中的源码仍保留原始内容。
 */
function injectTahaiAuthor(content: string): string {
    if (content.includes("TAHAI")) return content;

    // 单值 author: <name>
    if (/^author\s*:/m.test(content)) {
        return content.replace(/^author\s*:\s*(.*)$/m, (_, val) => {
            const inner = String(val).trim().replace(/^["']|["']$/g, "");
            return inner ? `author: "${inner} ${TAHAI_TAG}"` : `author: "${TAHAI_TAG}"`;
        });
    }
    // 数组 authors: [a, b]
    if (/^authors\s*:\s*\[/m.test(content)) {
        return content.replace(/^authors\s*:\s*\[(.*?)\]/m, (_, list) => {
            const trimmed = String(list).trim();
            return `authors: [${trimmed}${trimmed ? ", " : ""}"${TAHAI_TAG}"]`;
        });
    }
    // block 风格 authors: 然后下方列表
    if (/^authors\s*:\s*$/m.test(content)) {
        return content.replace(/^authors\s*:\s*$/m, `authors:\n  - "${TAHAI_TAG}"`);
    }
    // 完全没有
    return content.trimEnd() + `\nauthor: "${TAHAI_TAG}"\n`;
}

