// 直接解析 Java .class 字节码（无第三方依赖），从 Maven JAR 提取符号表用于 Monaco 补全。
//
// .class 二进制结构（JVM Spec）：
//   u4 magic 0xCAFEBABE
//   u2 minor / u2 major
//   u2 cp_count, cp_info[cp_count - 1]
//   u2 access_flags
//   u2 this_class / u2 super_class
//   u2 interfaces_count, u2[interfaces]
//   u2 fields_count, field_info[fields]
//   u2 methods_count, method_info[methods]
//   u2 attrs_count, attribute_info[attrs]
//
// 我们只关心：this_class（拿类名）+ fields/methods 的 name & descriptor & access。
// attributes 全部跳过（按 u4 length 整段跳）。

import {openDB, type IDBPDatabase} from "idb";
import JSZip from "jszip";
import {filterDepsForCompletion, parsePom, type PomDep} from "./usePomParser";

// ─── Symbol 输出结构 ─────────────────────────────────────────

export type SymKind = "class" | "interface" | "annotation" | "enum";
export type MemberKind = "method" | "field" | "constant";

export type Member = {
    name: string;
    kind: MemberKind;
    signature: string;
    insertText?: string;
    desc?: string;
};

export type DictClass = {
    name: string;          // 简单名 (Player)
    fqn: string;           // org.bukkit.entity.Player
    package: string;
    kind: SymKind;
    members: Member[];
    parent?: string;       // super_class FQN
    interfaces?: string[]; // 实现的接口 FQN 列表
};

// ─── Class 字节码解析 ────────────────────────────────────────

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;

type CP = (string | { class_index: number } | { name_index: number; descriptor_index: number } | null)[];

class ClassReader {
    private dv: DataView;
    private p = 0;
    constructor(buf: ArrayBuffer) { this.dv = new DataView(buf); }
    u1() { return this.dv.getUint8(this.p++); }
    u2() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
    u4() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
    bytes(n: number) { const a = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.p, n); this.p += n; return a; }
    skip(n: number) { this.p += n; }
}

function decodeMUTF8(bytes: Uint8Array): string {
    // Modified UTF-8 → string. 99% 情况和标准 UTF-8 一致，简化处理。
    try { return new TextDecoder("utf-8").decode(bytes); }
    catch { return ""; }
}

function parseDescriptor(desc: string): { params: string[]; ret: string } | null {
    // 方法描述符: "(Ljava/lang/String;I)V"
    // 字段描述符: "Ljava/lang/String;" 或 "I"
    if (desc[0] !== "(") {
        return {params: [], ret: parseType(desc).type};
    }
    const close = desc.indexOf(")");
    if (close < 0) return null;
    const paramsStr = desc.slice(1, close);
    const retStr = desc.slice(close + 1);
    const params: string[] = [];
    let i = 0;
    while (i < paramsStr.length) {
        const t = parseType(paramsStr.slice(i));
        if (!t.type) break;
        params.push(t.type);
        i += t.consumed;
    }
    return {params, ret: parseType(retStr).type};
}

function parseType(s: string): { type: string; consumed: number } {
    let arr = 0;
    let i = 0;
    while (s[i] === "[") { arr++; i++; }
    let base = "";
    let consumed = i;
    switch (s[i]) {
        case "B": base = "byte"; consumed += 1; break;
        case "C": base = "char"; consumed += 1; break;
        case "D": base = "double"; consumed += 1; break;
        case "F": base = "float"; consumed += 1; break;
        case "I": base = "int"; consumed += 1; break;
        case "J": base = "long"; consumed += 1; break;
        case "S": base = "short"; consumed += 1; break;
        case "Z": base = "boolean"; consumed += 1; break;
        case "V": base = "void"; consumed += 1; break;
        case "L": {
            const end = s.indexOf(";", i);
            if (end < 0) return {type: "", consumed: 0};
            const fqn = s.slice(i + 1, end).replace(/\//g, ".");
            base = simpleName(fqn);
            consumed = end + 1;
            break;
        }
        default: return {type: "", consumed: 0};
    }
    return {type: base + "[]".repeat(arr), consumed};
}

function simpleName(fqn: string): string {
    const idx = fqn.lastIndexOf(".");
    return idx >= 0 ? fqn.slice(idx + 1) : fqn;
}

export function parseClassFile(buf: ArrayBuffer): DictClass | null {
    const r = new ClassReader(buf);
    if (r.u4() !== 0xcafebabe) return null;
    r.u2(); r.u2(); // minor, major

    const cpCount = r.u2();
    const cp: CP = new Array(cpCount).fill(null);
    for (let i = 1; i < cpCount; i++) {
        const tag = r.u1();
        switch (tag) {
            case 1: { // UTF8
                const len = r.u2();
                cp[i] = decodeMUTF8(r.bytes(len));
                break;
            }
            case 3: case 4: r.skip(4); break;          // Integer / Float
            case 5: case 6: r.skip(8); cp[++i] = null; break; // Long / Double - 占 2 slot
            case 7: cp[i] = {class_index: r.u2()}; break;     // Class
            case 8: r.skip(2); break;                  // String
            case 9: case 10: case 11: r.skip(4); break; // Fieldref / Methodref / InterfaceMethodref
            case 12: cp[i] = {name_index: r.u2(), descriptor_index: r.u2()}; break; // NameAndType
            case 15: r.skip(3); break;                 // MethodHandle
            case 16: r.skip(2); break;                 // MethodType
            case 17: case 18: r.skip(4); break;        // Dynamic / InvokeDynamic
            case 19: case 20: r.skip(2); break;        // Module / Package
            default: return null;
        }
    }

    const resolveUtf8 = (idx: number): string => {
        const e = cp[idx];
        return typeof e === "string" ? e : "";
    };
    const resolveClassName = (idx: number): string => {
        const e = cp[idx];
        if (e && typeof e === "object" && "class_index" in e) {
            const name = resolveUtf8(e.class_index);
            return name.replace(/\//g, ".");
        }
        return "";
    };

    const accessFlags = r.u2();
    const thisClassIdx = r.u2();
    const fqn = resolveClassName(thisClassIdx);
    if (!fqn) return null;
    const isInterface = !!(accessFlags & ACC_INTERFACE);
    const isAnnotation = !!(accessFlags & ACC_ANNOTATION);
    const isEnum = !!(accessFlags & ACC_ENUM);
    const isPublic = !!(accessFlags & ACC_PUBLIC);
    const isSynthetic = !!(accessFlags & ACC_SYNTHETIC);

    // 非 public 或 synthetic 类不要
    if (!isPublic || isSynthetic) return null;
    // 跳过内部类 / 匿名类（含 $）
    if (fqn.includes("$")) return null;

    const superClassIdx = r.u2();
    const parent = superClassIdx > 0 ? resolveClassName(superClassIdx) : "";
    const ifaceCount = r.u2();
    const interfaces: string[] = [];
    for (let i = 0; i < ifaceCount; i++) {
        const n = resolveClassName(r.u2());
        if (n) interfaces.push(n);
    }

    const members: Member[] = [];
    const seenSig = new Set<string>();

    const readMembers = (kind: "field" | "method") => {
        const count = r.u2();
        for (let i = 0; i < count; i++) {
            const mAccess = r.u2();
            const nameIdx = r.u2();
            const descIdx = r.u2();
            const attrCount = r.u2();
            for (let j = 0; j < attrCount; j++) {
                r.u2();                 // attribute_name_index
                const len = r.u4();
                r.skip(len);
            }
            const isPub = !!(mAccess & ACC_PUBLIC);
            const isSyn = !!(mAccess & ACC_SYNTHETIC);
            if (!isPub || isSyn) continue;
            const name = resolveUtf8(nameIdx);
            const desc = resolveUtf8(descIdx);
            if (!name || !desc) continue;
            if (name === "<init>" || name === "<clinit>") continue;
            if (name.startsWith("lambda$")) continue;

            const sigKey = `${name}|${desc}`;
            if (seenSig.has(sigKey)) continue;
            seenSig.add(sigKey);

            if (kind === "method") {
                const parsed = parseDescriptor(desc);
                if (!parsed) continue;
                const params = parsed.params.map((t, i) => `${t} ${chooseParamName(t, i)}`).join(", ");
                const sig = `${parsed.ret} ${name}(${params})`;
                const insertText = parsed.params.length === 0
                    ? `${name}()`
                    : `${name}(${parsed.params.map((_, i) => `\${${i + 1}:${chooseParamName(parsed.params[i], i)}}`).join(", ")})`;
                members.push({
                    name,
                    kind: "method",
                    signature: sig,
                    insertText,
                });
            } else {
                const parsed = parseDescriptor(desc);
                if (!parsed) continue;
                members.push({
                    name,
                    kind: (mAccess & ACC_STATIC) ? "constant" : "field",
                    signature: `${parsed.ret} ${name}`,
                });
            }
        }
    };
    readMembers("field");
    readMembers("method");

    const pkg = fqn.includes(".") ? fqn.slice(0, fqn.lastIndexOf(".")) : "";
    return {
        name: simpleName(fqn),
        fqn,
        package: pkg,
        kind: isAnnotation ? "annotation" : isEnum ? "enum" : isInterface ? "interface" : "class",
        members,
        parent: parent || undefined,
        interfaces: interfaces.length ? interfaces : undefined,
    };
}

// 把每个类的 members 扩展为"自己 + 父类 + 接口"的完整方法集
export function expandInheritance(classes: DictClass[]): DictClass[] {
    const byFqn = new Map<string, DictClass>();
    for (const c of classes) byFqn.set(c.fqn, c);

    const cache = new Map<string, Member[]>();

    function collect(fqn: string, depth: number, stack: Set<string>): Member[] {
        if (depth > 12) return [];
        const cached = cache.get(fqn);
        if (cached) return cached;
        if (stack.has(fqn)) return [];
        stack.add(fqn);

        const cls = byFqn.get(fqn);
        if (!cls) { stack.delete(fqn); return []; }

        const inherited: Member[] = [];
        if (cls.parent) inherited.push(...collect(cls.parent, depth + 1, stack));
        if (cls.interfaces) for (const i of cls.interfaces) inherited.push(...collect(i, depth + 1, stack));

        // 自己声明的方法覆盖继承的（按 name+signature 去重，自己优先）
        const seen = new Set<string>();
        const merged: Member[] = [];
        for (const m of cls.members) {
            const k = m.name + "|" + m.signature;
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(m);
        }
        for (const m of inherited) {
            const k = m.name + "|" + m.signature;
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(m);
        }

        cache.set(fqn, merged);
        stack.delete(fqn);
        return merged;
    }

    return classes.map(c => ({
        ...c,
        members: collect(c.fqn, 0, new Set()),
    }));
}

function chooseParamName(type: string, idx: number): string {
    const base = type.replace(/\[\]/g, "");
    const map: Record<string, string> = {
        String: "s", int: "i", long: "l", boolean: "b", double: "d", float: "f",
        Player: "player", World: "world", Block: "block", Location: "loc",
        ItemStack: "item", Event: "event", Plugin: "plugin",
        CommandSender: "sender", Material: "material", Entity: "entity",
    };
    return map[base] || base.charAt(0).toLowerCase() + base.slice(1) || `arg${idx}`;
}

// ─── JAR 拉取 + 解压 + 索引 ─────────────────────────────────

const DB_NAME = "tahai-jar-cache";
const STORE = "jars";
let dbPromise: Promise<IDBPDatabase<any>> | null = null;

function getDB() {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, {keyPath: "coords"});
                }
            },
        });
    }
    return dbPromise;
}

async function fetchJar(dep: PomDep, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    const coords = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
    const resp = await fetch(`/api/maven/jar?coords=${encodeURIComponent(coords)}`);
    if (!resp.ok) throw new Error(`JAR ${resp.status}: ${coords}`);
    const total = Number(resp.headers.get("Content-Length") || 0);
    if (!onProgress || !resp.body) return resp.arrayBuffer();
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            loaded += value.length;
            onProgress(loaded, total);
        }
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
}

async function parseJarBuffer(buf: ArrayBuffer, onClass?: (i: number, total: number) => void): Promise<DictClass[]> {
    const zip = await JSZip.loadAsync(buf);
    const classEntries = Object.values(zip.files).filter(f =>
        !f.dir && f.name.endsWith(".class") && !f.name.includes("META-INF/")
    );
    const out: DictClass[] = [];
    for (let i = 0; i < classEntries.length; i++) {
        try {
            const ab = await classEntries[i].async("arraybuffer");
            const parsed = parseClassFile(ab);
            if (parsed && parsed.members.length > 0) out.push(parsed);
        } catch { /* skip broken classes */ }
        if (onClass && i % 50 === 0) onClass(i, classEntries.length);
    }
    if (onClass) onClass(classEntries.length, classEntries.length);
    return out;
}

export type LoadStatus = {
    phase: "idle" | "downloading" | "parsing" | "done" | "error";
    coords?: string;
    loaded?: number;
    total?: number;
    classCount?: number;
    error?: string;
};

export async function loadDeps(
    deps: PomDep[],
    onStatus?: (s: LoadStatus) => void,
): Promise<DictClass[]> {
    const all: DictClass[] = [];
    const db = await getDB();

    for (const dep of deps) {
        const coords = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
        const cached = await db.get(STORE, coords);
        if (cached?.classes) {
            onStatus?.({phase: "done", coords, classCount: cached.classes.length});
            all.push(...cached.classes);
            continue;
        }

        try {
            onStatus?.({phase: "downloading", coords, loaded: 0, total: 0});
            const buf = await fetchJar(dep, (loaded, total) => {
                onStatus?.({phase: "downloading", coords, loaded, total});
            });

            onStatus?.({phase: "parsing", coords, classCount: 0});
            const classes = await parseJarBuffer(buf, (i, total) => {
                onStatus?.({phase: "parsing", coords, classCount: i, total});
            });

            await db.put(STORE, {coords, classes, savedAt: Date.now()});
            onStatus?.({phase: "done", coords, classCount: classes.length});
            all.push(...classes);
        } catch (e: any) {
            onStatus?.({phase: "error", coords, error: e?.message || String(e)});
        }
    }
    return all;
}

export async function loadFromPom(
    pomText: string,
    onStatus?: (s: LoadStatus) => void,
): Promise<DictClass[]> {
    const deps = filterDepsForCompletion(parsePom(pomText));
    if (!deps.length) return [];
    const raw = await loadDeps(deps, onStatus);
    return expandInheritance(raw);
}

export async function clearJarCache() {
    const db = await getDB();
    await db.clear(STORE);
}
