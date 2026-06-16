// 极简 Markdown → HTML 渲染（无第三方依赖），用于 Skill 库 README 卡片展示。
// 覆盖：标题 / 段落 / 有序+无序列表 / 围栏代码块 / 行内代码 / 粗体 / 斜体 / 引用 /
// 分隔线 / 表格 / 链接（仅 http(s)）。所有文本节点转义，避免注入。

function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, a, b) =>
        /^https?:\/\//.test(b) ? `<a href="${b}" target="_blank" rel="noreferrer">${a}</a>` : a,
    );
    return t;
}

function splitRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
}

export function renderMarkdown(md: string): string {
    if (!md) return "";
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let i = 0;
    let list: "" | "ul" | "ol" = "";
    const closeList = () => { if (list) { out.push(`</${list}>`); list = ""; } };

    while (i < lines.length) {
        const line = lines[i];
        const t = line.trim();

        // 围栏代码块
        if (/^```/.test(t)) {
            closeList();
            const buf: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
            i++; // 跳过结束 ```
            out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
            continue;
        }

        // 表格：本行含 | 且下一行是 |---|---| 分隔
        if (line.includes("|") && i + 1 < lines.length
            && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
            closeList();
            const header = splitRow(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i++; }
            const th = header.map((c) => `<th>${inline(c)}</th>`).join("");
            const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
            out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
            continue;
        }

        if (t === "") { closeList(); i++; continue; }

        const h = t.match(/^(#{1,6})\s+(.*)$/);
        if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }

        if (/^(-{3,}|\*{3,})$/.test(t)) { closeList(); out.push("<hr/>"); i++; continue; }

        if (/^>\s?/.test(t)) { closeList(); out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }

        const ul = t.match(/^[-*]\s+(.*)$/);
        if (ul) {
            if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
            out.push(`<li>${inline(ul[1])}</li>`); i++; continue;
        }

        // 有序列表：保留原始序号文本，避免浏览器 <ol> 在列表被其它块打断后从 1 重新编号（1.2.3 → 1.1.1）
        const ol = t.match(/^(\d+)\.\s+(.*)$/);
        if (ol) {
            closeList();
            out.push(`<div class="md-oli">${ol[1]}. ${inline(ol[2])}</div>`);
            i++; continue;
        }

        closeList();
        out.push(`<p>${inline(t)}</p>`);
        i++;
    }
    closeList();
    return out.join("\n");
}
