import { safeProjectPath } from "./projectArchive";
export const JAR_MAX_BYTES = 20 * 1024 * 1024;
export const JAR_MAX_EXPANDED = 100 * 1024 * 1024;
/** Inspect central directory before any decompression. ZIP64/encryption are intentionally unsupported. */
export function inspectJar(bytes: Uint8Array) {
    if (bytes.byteLength > JAR_MAX_BYTES || bytes.byteLength < 22) throw new Error("JAR 大小须在 22 字节到 20 MiB 之间");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("不支持此 JAR 的分卷格式");
    const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), length = view.getUint32(end + 12, true);
    if (count > 2000 || offset + length !== end || count === 0 || offset > end) throw new Error("JAR 条目数量超限或目录无效");
    const seen = new Set<string>(), entries: { path: string; bytes: number }[] = []; let at = offset, expanded = 0;
    for (let index = 0; index < count; index++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error("JAR 目录损坏");
        const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
        if (at + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff) throw new Error("不支持加密或 ZIP64 JAR");
        const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength));
        const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
        if (!safeProjectPath(normalized) || seen.has(normalized.toLowerCase())) throw new Error("JAR 包含危险或重复路径");
        seen.add(normalized.toLowerCase()); expanded += size;
        if (expanded > JAR_MAX_EXPANDED) throw new Error("JAR 展开内容超过 100 MiB");
        entries.push({ path, bytes: size }); at += 46 + nameLength + extra + comment;
    }
    if (at !== end) throw new Error("JAR 目录长度不一致");
    if (!entries.some(e => ["plugin.yml", "paper-plugin.yml"].includes(e.path))) throw new Error("未发现 Paper/Spigot 插件描述文件");
    return { entries, expanded };
}
