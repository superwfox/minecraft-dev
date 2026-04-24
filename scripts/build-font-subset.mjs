import fs from "node:fs/promises";
import path from "node:path";
import subsetFont from "subset-font";

const ROOT = process.cwd();
const SCAN_DIRS = [path.join(ROOT, "src")];
const SCAN_FILES = [path.join(ROOT, "index.html")];
const ALLOWED_EXT = new Set([".vue", ".ts", ".js", ".tsx", ".jsx", ".html"]);

async function walkFiles(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, out);
      continue;
    }
    if (ALLOWED_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
  return out;
}

function isVisibleChar(ch) {
  if (!ch) {
    return false;
  }
  const cp = ch.codePointAt(0);
  if (!cp) {
    return false;
  }
  if (cp < 32 || cp === 127) {
    return false;
  }
  return true;
}

function sortByCodePoint(chars) {
  return [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    try {
      await fs.access(dir);
      await walkFiles(dir, files);
    } catch {
      // ignore missing dir
    }
  }
  files.push(...SCAN_FILES);

  const sourceTextParts = await Promise.all(
      files.map(async (file) => await readIfExists(file))
  );
  const sourceText = sourceTextParts.join("\n");
  const chars = new Set();
  for (const ch of sourceText) {
    if (isVisibleChar(ch)) {
      chars.add(ch);
    }
  }

  const sortedChars = sortByCodePoint(chars);
  const charset = sortedChars.join("");
  const sourceCandidates = [
    path.join(ROOT, "lib", "jiangxizhuokai.ttf"),
    path.join(ROOT, "font", "jiangxizhuokai.ttf"),
  ];

  let sourceFontPath = "";
  for (const candidate of sourceCandidates) {
    try {
      await fs.access(candidate);
      sourceFontPath = candidate;
      break;
    } catch {
      // try next
    }
  }

  if (!sourceFontPath) {
    throw new Error("No source font found. Expected lib/jiangxizhuokai.ttf or font/jiangxizhuokai.ttf");
  }

  const sourceBuffer = await fs.readFile(sourceFontPath);
  const subsetBuffer = await subsetFont(sourceBuffer, charset, { targetFormat: "woff2" });

  const charsOutputPath = path.join(ROOT, "font", "jiangxizhuokai_chars.txt");
  const publicWoff2Path = path.join(ROOT, "public", "jiangxizhuokai_subset.woff2");
  const fontWoff2Path = path.join(ROOT, "font", "jiangxizhuokai_subset.woff2");

  await fs.writeFile(charsOutputPath, charset, "utf8");
  await fs.writeFile(publicWoff2Path, subsetBuffer);
  await fs.writeFile(fontWoff2Path, subsetBuffer);

  const sourceSize = sourceBuffer.length;
  const subsetSize = subsetBuffer.length;

  console.log(`Scanned files: ${files.length}`);
  console.log(`Unique visible chars: ${sortedChars.length}`);
  console.log(`Source font: ${path.relative(ROOT, sourceFontPath)} (${sourceSize} bytes)`);
  console.log(`Subset font: public/jiangxizhuokai_subset.woff2 (${subsetSize} bytes)`);
  console.log(`Chars file: font/jiangxizhuokai_chars.txt`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
