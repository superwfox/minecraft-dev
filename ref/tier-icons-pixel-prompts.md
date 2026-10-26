# 档位图标像素版生成记录

- 工具：内置 ImageGen，三张独立图像并发生成。
- 风格基准：`default-icon-pixel-v1.png`（用户选定的第一版）。
- 各档位原图：`../public/silver.png`、`../public/gold.png`、`../public/diamond.png`。
- 所有输出均为透明 PNG。最终采用的版本与网站资源映射见文末“网站资源替换”。
- Diamond 沿用现有原图的金色及其纹饰；没有按档位名称自行改成蓝色。

## silver

输出：`silver-icon-pixel-v1.png`

最终提示词：

```text
Use case: style-transfer. Asset type: one transparent PNG website tier icon. Input image 1 is the APPROVED PIXEL-ART STYLE MASTER, the first white-gray guardian beast version; borrow its deliberate square pixel clusters, stair-step contours, simplified ornamental curls, approximate 64x64 logical pixel density, strong dark outlines and readable small-icon treatment. Input image 2 is THIS VARIANT'S ORIGINAL ICON and is the identity, silhouette, facial-expression, ornament and palette reference. Convert input image 2 into the exact same pixel-art family as input image 1. Preserve the distinct design of input image 2 rather than replacing it with a recoloring of image 1. Keep the frontal centered guardian beast lion head, two clearly visible fierce eyes with readable pupils, pointed ears, snarling open mouth, fangs, curled mane and lower tuft. Render deliberate retro-game pixel art with sharp square pixel blocks, cohesive pixel size, 8-12 discrete color tones, simple readable clusters and no antialiased smooth curves, no blur, continuous gradients, 3D rendering or vector appearance. Simplify minute lines into strong pixel clusters while retaining the variant's distinctive motifs. Composition: one full uncropped centered head, square 1:1 canvas, aim for 1024x1024 output with a small even transparent margin, suitable to display as a 48px website icon. Fully transparent alpha background outside the silhouette: remove any original blue-gray backdrop or vignette, no checkerboard baked in, glow, shadow, tile, frame, text, watermark, new objects or additional heads. Output one standalone icon, no layout or comparison.
Variant: SILVER. Preserve the original silver icon's white highlights, cool silver midtones and charcoal-gray structural shadows. Keep its broad curling mane and original fierce face. Monochrome silver/white/gray only, no gold, blue gems or accessories.
```

## gold

输出：`gold-icon-pixel-v1.png`

最终提示词：

```text
Use case: style-transfer. Asset type: one transparent PNG website tier icon. Input image 1 is the APPROVED PIXEL-ART STYLE MASTER, the first white-gray guardian beast version; borrow its deliberate square pixel clusters, stair-step contours, simplified ornamental curls, approximate 64x64 logical pixel density, strong dark outlines and readable small-icon treatment. Input image 2 is THIS VARIANT'S ORIGINAL ICON and is the identity, silhouette, facial-expression, ornament and palette reference. Convert input image 2 into the exact same pixel-art family as input image 1. Preserve the distinct design of input image 2 rather than replacing it with a recoloring of image 1. Keep the frontal centered guardian beast lion head, two clearly visible fierce eyes with readable pupils, pointed ears, snarling open mouth, fangs, curled mane and lower tuft. Render deliberate retro-game pixel art with sharp square pixel blocks, cohesive pixel size, 8-12 discrete color tones, simple readable clusters and no antialiased smooth curves, no blur, continuous gradients, 3D rendering or vector appearance. Simplify minute lines into strong pixel clusters while retaining the variant's distinctive motifs. Composition: one full uncropped centered head, square 1:1 canvas, aim for 1024x1024 output with a small even transparent margin, suitable to display as a 48px website icon. Fully transparent alpha background outside the silhouette: remove any original blue-gray backdrop or vignette, no checkerboard baked in, glow, shadow, tile, frame, text, watermark, new objects or additional heads. Output one standalone icon, no layout or comparison.
Variant: GOLD. Preserve the original gold icon's warm yellow-gold metal palette, pale cream/yellow highlights, rich gold midtones and deep ochre/brown pixel outlines. Keep its broad ornamental curls and original sturdy face proportions. Match the reference warm gold, no silver recoloring, no blue gems and no new accessories.
```

## diamond

输出：`diamond-icon-pixel-v1.png`

最终提示词：

```text
Use case: style-transfer. Asset type: one transparent PNG website tier icon. Input image 1 is the APPROVED PIXEL-ART STYLE MASTER, the first white-gray guardian beast version; borrow its deliberate square pixel clusters, stair-step contours, simplified ornamental curls, approximate 64x64 logical pixel density, strong dark outlines and readable small-icon treatment. Input image 2 is THIS VARIANT'S ORIGINAL ICON and is the identity, silhouette, facial-expression, ornament and palette reference. Convert input image 2 into the exact same pixel-art family as input image 1. Preserve the distinct design of input image 2 rather than replacing it with a recoloring of image 1. Keep the frontal centered guardian beast lion head, two clearly visible fierce eyes with readable pupils, pointed ears, snarling open mouth, fangs, curled mane and lower tuft. Render deliberate retro-game pixel art with sharp square pixel blocks, cohesive pixel size, 8-12 discrete color tones, simple readable clusters and no antialiased smooth curves, no blur, continuous gradients, 3D rendering or vector appearance. Simplify minute lines into strong pixel clusters while retaining the variant's distinctive motifs. Composition: one full uncropped centered head, square 1:1 canvas, aim for 1024x1024 output with a small even transparent margin, suitable to display as a 48px website icon. Fully transparent alpha background outside the silhouette: remove any original blue-gray backdrop or vignette, no checkerboard baked in, glow, shadow, tile, frame, text, watermark, new objects or additional heads. Output one standalone icon, no layout or comparison.
Variant: DIAMOND TIER, strictly use the existing diamond.png identity. This particular original diamond-tier icon is an ORNATE GOLD guardian head; preserve its existing gold coloration, more intricate filigree curls, elaborate forehead ornament and pointed ornamental mane. Preserve its premium detailed visual distinction from the simpler gold-tier head, translating fine filigree into readable pixel clusters. Use pale warm gold highlights, rich golden midtones and darker ochre/brown outlines. The tier name is not an instruction to turn it blue, icy or add gemstones: do not invent gems, a crown or other objects absent from the original.
```

## Silver v2：增强银质金属反光

- 输出：`silver-icon-pixel-v2.png`。
- 编辑目标：`silver-icon-pixel-v1.png`；材质参考：`../public/silver.png`。
- 已确认范围：仅增强 Silver 的银白高光、冷灰暗部和硬边反光，保持造型、像素风与透明背景；Gold、Diamond 不变。
- 使用内置 ImageGen；另存第二版，保留第一版；未替换网站资源。

最终提示词：

```text
Use case: lighting-weather. Asset type: transparent PNG pixel-art silver-tier website icon, material/shading revision only. Input image 1 is the EDIT TARGET, the approved silver guardian-beast pixel-art icon. Input image 2 is a MATERIAL REFERENCE ONLY: the original polished silver-metal icon. Keep image 1's design, silhouette, pixel-art geometry, head proportions, facial expression, two visible eyes and pupils, ear shapes, mane curls, forehead spiral, nose, teeth, mouth, lower tuft, framing, square aspect ratio and existing pixel-block scale unchanged as faithfully as possible. Change only the material rendering and light/shadow color clusters so the object unmistakably reads as highly polished SILVER METAL. Replace broad flat white areas with structured silver reflection patterns: narrow brilliant silver-white specular bands following the raised curl ridges, adjacent cool medium-gray reflection bands, deep charcoal-gray recesses in engraved grooves, crisp small highlights on the nose, ears, brow ridges and curl crests, and bright reflected rim accents. Strong local light/dark contrast and abrupt bright-to-dark reflection transitions should describe sculpted metallic relief. Keep a coherent upper-left light direction and preserve the face's readable dark eye sockets. Use a restrained 10-14 tone palette of near-white silver, cool light gray, steel gray, cool dark gray and charcoal, with only a subtle cool-gray cast, no saturated blue, gold or other colors. Essential: accomplish all metallic shine with DELIBERATE SHARP PIXEL CLUSTERS AND HARD-EDGED DISCRETE COLOR BANDS, preserving the approved retro-game sprite style. No smooth gradients, antialiasing, blur, soft airbrush, vector curves, photorealistic or smooth 3D rendering. No added starbursts, floating sparkles, particles, gems, accessories, new curls or other objects. Fully transparent alpha background outside the existing silhouette, no backdrop, checkerboard, ground, drop shadow, glow, text, frame or watermark. Preserve the full uncropped icon and existing margins, aim to retain the original 1254x1254 square canvas. Output one edited icon.
```

## 网站资源替换

最终选用用户标注的第一轮三个档位版本，默认图标选用最早的第一版；文件按原名替换，现有档位映射继续生效。

| 网站资源 | 选用文件 |
| --- | --- |
| `../public/icon.png` | `default-icon-pixel-v1.png` |
| `../public/silver.png` | `silver-icon-pixel-v1.png` |
| `../public/gold.png` | `gold-icon-pixel-v1.png` |
| `../public/diamond.png` | `diamond-icon-pixel-v1.png` |

参考版本继续保留在本目录，`favicon.png` 未改动。

检查结果：四个网站资源与选用参考文件的 SHA-256 一致；已在本地网站检查默认图标的页头显示，尺寸与留白正常。未执行测试或构建。
