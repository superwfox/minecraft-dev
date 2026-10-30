# 首页山谷参考与分层素材

2026-10-30。用户确认采用山谷方向，使用内置 imagegen 先生成参考，再实现 `/home`；根路径仍默认进入 `/chat`。没有使用 CLI/API fallback，也没有新增依赖。

## 最终文件

- `home-valley-concept-v1.png`：完整构图参考，不参与网页加载。
- `../public/home-valley/far-v1.webp`：远山、天空、河谷底图，1672 × 941，不透明，231670 字节。
- `../public/home-valley/middle-v1.webp`：两侧山壁，1672 × 941，保留 Alpha，308488 字节。
- `../public/home-valley/near-v1.webp`：近处岩台，1672 × 941，保留 Alpha，128750 字节。

三张网页素材合计 668908 字节（约 653 KiB）。使用项目已有 sharp 转码为 WebP，quality 88、alphaQuality 100；不改变画面内容，不在网页加载原始大 PNG。

所有生成层都以完整构图为参考；远景补齐山壁遮住的区域，山壁与岩台为独立透明图层。生成结果重新绘制了部分岩石，所以网页构图接近参考，并非逐像素拆分。三层使用相同的画幅和裁切方式，并在视口外预留 16% 的边缘；滚动差速受限于该预留，避免露底。

## 后续内容板块

山谷下方依次为文档和 QQ 群入口。用户明确要求这两个板块采用原始黑底、浅黄色错落矩形草图，参考原图保存在 `home-block-layout-reference.png`；已移除初版文档预览卡和 QQ 群山谷背景，改用 CSS 块面，不新增网页图片或依赖。文档主块靠左，QQ 群主块靠右，文案和链接沿用已确认内容。

首屏山谷与两个块面场景分别测量各自的高度和滚动范围，不因整页变长而过量位移。块面背景三层分别移动当前场景滚动距离的 6%、18%、32%，文字所在前块只移动 4%，保证按钮容易点击；系统减少动态效果时各场景为静态单屏。链接保留共享按钮的纵横内边距，只在这两个浅黄色场景内改为深色按钮以保证对比度。首屏山谷、导航和默认 Chat 入口不变。

文档沿用 `https://minecraft-dev.pages.dev/`；本轮经用户确认，首页、顶栏和文档站所有现有 QQ 群入口统一使用 `https://qm.qq.com/q/GQbHFjEp4k`。仅核对入口地址配置，没有验证 QQ 短链所对应的群号或执行入群。

## 美术方向参考

- [Firewatch 环境美术 — Olly Moss](https://ollymoss.com/firewatch)：可参考景物分层与氛围的组织方式。
- [Monument Valley — ustwo](https://ustwo.com/work/monument-valley/)：可参考几何体块与空间关系。

以上只作方向参考，未下载或使用游戏原画。网页图片均由本轮内置 imagegen 生成。

## 原始 Prompt

### 完整构图

```text
Use case: stylized-concept.
Asset type: finished wide 16:9 scenic hero background and art-direction reference for a Minecraft developer website with three-depth scroll parallax.
Primary request: an immersive VALLEY, not abstract rectangular bars: massive terraced voxel canyon walls frame an open, deep valley, a winding narrow golden river leads toward distant layered mountain ridges and a soft hazy horizon. Create a polished, detailed version of a block-shaped layered landscape, suitable for implementing as an actual website scene.
Style: sophisticated cinematic voxel environmental illustration, Minecraft-like stepped cubic geology, deliberate chunky block geometry with finely shaded stone surfaces, restrained surface grain and small stone terraces; clean art-directed silhouettes rather than noisy game screenshot or photoreal rocks.
Composition: landscape 16:9. View from inside the valley looking toward the horizon at roughly 48% canvas height. Three clearly separable depth planes: distant muted mountain ridges and haze; middle terraced canyon cliffs framing left and right; nearest dark rock ledges in the lower corners. Valley opens through center. Upper center from x=36%-66%, y=18%-42% stays calm and very dark for a two-line Chinese website headline. Top 15% is dark quiet sky for existing website navigation. Avoid vertical flat cutoffs across the image.
Palette: near-black charcoal, warm dark olive-brown stone, muted wheat-gold sunlit cliff edges, a narrow amber river reflection. Dark, refined, warm and atmospheric. No bright green grass or blue sky. Strong depth from detailed close stone, softer mid cliffs, and hazy distant ridges. Gentle rim light on terraces; no neon.
Content constraints: only natural valley terrain and sparse block-shaped vegetation if needed; no people, buildings, temples, doors, characters, animals, logos, lettering, interface controls, grids or frames. No text anywhere. Full bleed finished scene, no collage and no panel labels. Genuine deep valley composition, not a skyline of standalone pillars.
```

### 远景底图

```text
Use case: precise-object-edit. Input image 1 is the EDIT TARGET and exact composition / lighting reference for a parallax website scene. Produce the FAR BACKGROUND PLATE only, full-bleed landscape 16:9, exactly the same camera viewpoint and framing.
Remove ALL close and middle-distance tall canyon side walls and all foreground rock ledges on left and right. Inpaint the removed regions as a coherent continuation of the distant mountain ranges and low valley floor. Keep the dark cloudy upper sky, golden low horizon near center, atmospheric distant layered ridges, winding golden reflective river and distant tiny block terrain. Far mountains may frame the sides but must be distant, soft and small in apparent scale. There must be no large detailed close cliff face anywhere. The complete plate should be opaque and naturally cover the entire canvas, including underlying scenery behind the removed side cliffs. Preserve reference dusk color, golden light, block-shaped geology and central perspective. Keep top 40% quiet and dark for website text. No letters, UI, frames, characters, buildings or watermark.
```

### 中景山壁

```text
Use case: background-extraction. Input image 1 is the EDIT TARGET and exact terrain / lighting reference.
Extract and reconstruct ONLY the MIDDLE-DISTANCE CANYON WALLS on left and right as a single transparent PNG for a scroll parallax layer. Same wide 16:9 canvas, camera, lighting and relative positions as reference. These are the stepped cliff masses that frame the central valley, behind the nearest bottom-corner ledges. Preserve detailed cubic basalt stone terraces, sparse tiny dark block vegetation and gold rim lighting. Keep left wall mainly within x=0-36% and right wall within x=70-100%, irregular stepped silhouettes reaching upper outer sides. Continue their lower cliff faces naturally down to the bottom edge where the nearest ledges have been removed, so the layer has underpainted edges for motion. Center x=38-68% must stay entirely transparent from top through bottom, preserving an open river passage.
Remove the entire sky, distant mountains, distant valley floor, river and ALL closest foreground ledges at bottom corners. All removed regions must have genuine transparent alpha, not black, gray, white or a checkerboard drawn into the image. Retain only the two middle canyon-wall masses. Do not add structures or text. Crisp clean silhouettes with correct semitransparent vegetation edges, no opaque fog filling the open center.
```

### 近景岩台

```text
Use case: background-extraction. Input image 1 is the EDIT TARGET and exact near-rock / lighting reference.
Extract ONLY the NEAREST FOREGROUND ROCK LEDGES at the bottom-left and bottom-right corners into one true transparent PNG with the same wide 16:9 canvas and perspective. Preserve the detailed chunky cubic rock faces, descending stair-like terraces, dark basalt material, and narrow golden highlights of those closest outcrops. Left foreground ledge runs down in steps from about x=0,y=65% toward x=43%,y=96%; right ledge from about x=80%,y=78% toward x=100%,y=67%. Continue these near rock ledges down to the bottom canvas edge. Main center passage x=46-72% must remain transparent all the way to bottom.
Remove EVERYTHING else: sky, sun, distant mountains, middle canyon walls, valley floor, river, fog and background. Outside the two bottom-corner outcrops, actual alpha transparency is required. No solid black background, no white background, no drawn checkerboard, no other terrain layers. Match reference exact warm-dark color scheme and refined cubic stone texture. No text, UI, frames, logos, extra trees, or new objects.
```
