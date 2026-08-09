import type { FileSummary } from "./prompts";

type StoredFileSummary = Omit<FileSummary, "path">;

function unique(values: string[]): string[] {
    return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectMatches(content: string, pattern: RegExp): string[] {
    const values: string[] = [];
    for (const match of content.matchAll(pattern)) {
        if (match[1]) values.push(match[1]);
    }
    return unique(values);
}

/**
 * Extract the cross-file API context locally. This keeps summaries deterministic and
 * avoids an additional LLM request for every generated file.
 */
export function extractFileSummary(
    filePath: string,
    content: string,
    description = "",
): StoredFileSummary {
    const summary: StoredFileSummary = {
        description: description.trim() || `Generated file ${filePath.split("/").pop() || filePath}`,
    };
    if (!/\.java$/i.test(filePath)) return summary;

    const declaration = content.match(
        /\b(public\s+)?(?:(?:abstract|final|sealed|non-sealed|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^\s{]+))?(?:\s+implements\s+([^\{]+))?\s*\{/m,
    );
    const className = declaration?.[3]
        || filePath.split("/").pop()?.replace(/\.java$/i, "")
        || "";
    if (className) summary.className = className;
    if (declaration?.[4]) summary.extends = declaration[4].trim();
    if (declaration?.[5]) {
        summary.implements = unique(declaration[5].split(",")).slice(0, 20);
    }

    if (className) {
        const escapedClassName = escapeRegExp(className);
        const publicConstructors = collectMatches(
            content,
            new RegExp(`^\\s*public\\s+${escapedClassName}\\s*\\(([^)]*)\\)`, "gm"),
        ).map(params => ({ params }));
        const anyConstructor = new RegExp(
            `^\\s*(?:(?:public|protected|private)\\s+)?${escapedClassName}\\s*\\(`,
            "m",
        ).test(content);
        if (publicConstructors.length) summary.constructors = publicConstructors.slice(0, 20);
        else if (!anyConstructor && declaration?.[1]) summary.constructors = [{ params: "" }];
        else summary.constructors = [];
    }

    const publicMethods: NonNullable<FileSummary["publicMethods"]> = [];
    const methodPattern = /^\s*public\s+(?:(?:static|final|synchronized|abstract|default|native|strictfp)\s+)*(?:<[^>\n]+>\s+)?([A-Za-z_$][\w$<>,.? &\[\]]*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^\{;]+)?[\{;]/gm;
    for (const match of content.matchAll(methodPattern)) {
        if (match[2] === className) continue;
        publicMethods.push({
            returns: match[1].trim(),
            name: match[2],
            params: match[3].trim(),
        });
    }
    if (publicMethods.length) {
        const seen = new Set<string>();
        summary.publicMethods = publicMethods.filter(method => {
            const key = `${method.name}(${method.params})`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, 60);
    }

    const publicFields: string[] = [];
    const fieldPattern = /^[ \t]*public[ \t]+([^;\n()]+);/gm;
    for (const match of content.matchAll(fieldPattern)) {
        const declarationText = match[1].split("=")[0].trim();
        if (declarationText) publicFields.push(declarationText);
    }
    if (publicFields.length) summary.publicFields = unique(publicFields).slice(0, 40);

    const events = collectMatches(content, /\b([A-Z][A-Za-z0-9_$]*Event)\b/g);
    if (events.length) summary.events = events.slice(0, 40);

    const commands = unique([
        ...collectMatches(content, /getCommand\(\s*["']([^"']+)["']\s*\)/g),
        ...collectMatches(content, /getName\(\)\.equalsIgnoreCase\(\s*["']([^"']+)["']\s*\)/g),
    ]);
    if (commands.length) summary.commands = commands.slice(0, 40);

    const configKeys = unique([
        ...collectMatches(content, /(?:getConfig\(\)|\bconfig)\s*\.\s*(?:get\w*|set|contains)\(\s*["']([^"']+)["']/g),
        ...collectMatches(content, /\b(?:getString|getInt|getLong|getDouble|getBoolean|getList|getConfigurationSection|set|contains)\(\s*["']([^"']+)["']/g),
    ]);
    if (configKeys.length) summary.configKeys = configKeys.slice(0, 60);

    return summary;
}
