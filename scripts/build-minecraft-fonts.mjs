import fs from "node:fs/promises";
import path from "node:path";
import subsetFont from "subset-font";

const ROOT = process.cwd();

const fonts = [
  {
    source: path.join(ROOT, "font", "Minecrafter.Alt.ttf"),
    targets: [
      path.join(ROOT, "font", "minecrafter-alt.woff2"),
      path.join(ROOT, "public", "minecrafter-alt.woff2"),
    ],
  },
  {
    source: path.join(ROOT, "font", "Minecrafter.Reg.ttf"),
    targets: [
      path.join(ROOT, "font", "minecrafter-reg.woff2"),
      path.join(ROOT, "public", "minecrafter-reg.woff2"),
    ],
  },
];

// Keep the display fonts compact while covering nav labels and all waiting words.
const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_/… ";

for (const font of fonts) {
  const source = await fs.readFile(font.source);
  const woff2 = await subsetFont(source, charset, { targetFormat: "woff2" });
  for (const target of font.targets) {
    await fs.writeFile(target, woff2);
  }
  console.log(`${path.relative(ROOT, font.source)} -> ${font.targets.map((t) => path.relative(ROOT, t)).join(", ")}`);
}
