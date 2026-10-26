# 默认头像 v3：以网站默认第一版重新生成

- 工具：内置 ImageGen。
- 输出：`default-avatar-cute-pixel-v3.png`。
- 造型参考：`default-icon-pixel-v1.png`（网站默认第一版）。
- 构图及眼睛形状参考：`default-avatar-eye-reference.png`。
- 已确认范围：以网站默认第一版为造型参考重新绘制；大颗粒像素概括白灰瑞兽，保持斜向构图、简化卷毛、张嘴与牙齿；两只眼睛采用深灰黑色实心短矩形，粗细像素共用基础网格。
- 新头像另存，既有参考与网站文件保留。

## 32×32 大颗粒导出（v4）

- 原稿：`default-avatar-cute-pixel-v3.png`，由网站默认第一版作为造型参考生成。
- 实际 32×32 PNG：`default-avatar-32x32-v4.png`。
- 512×512 预览：`default-avatar-32x32-v4-preview.png`，按 16 倍最近邻放大，每个原始像素对应 16×16 方块。
- 使用现有 Sharp 将原稿按最近邻缩至 32×32，保留原有颜色和透明通道；预览仅放大像素块。

## 最终提示词

```text
Use case: stylized-concept. Create a FRESH NEW chunky-pixel avatar design using TWO references with distinct roles. Image 1 is the user's COMPOSITION AND SIMPLE EYE-SHAPE SKETCH: follow the approximate head placement, clockwise diagonal lean, lower-left entrance and crop, upper-right negative space, and the two short diagonal rectangles representing the eyes. Blue, orange, yellow and the white rounded frame are drawing guides only; do not reproduce those colors, shapes as objects, or border. Image 2 is the WEBSITE'S ORIGINAL APPROVED FIRST DEFAULT ICON, used ONLY AS THE GUARDIAN-BEAST IDENTITY REFERENCE: borrow its white-gray guardian lion character, pointed ears, central forehead spiral, curled mane, gray nose and open mouth with tiny fangs. This is a BRAND NEW SIMPLIFIED AVATAR DRAWING from that first default icon, not a local edit of any prior cute avatar. USER ART DIRECTION: simple cute expression, large chunky pixels for the main head, with smaller pixels permitted only for tiny features, and ALL pixel sizes strictly aligned to one shared underlying grid. Dramatically simplify image 2's fine ornament into a broad friendly chibi head with ONE prominent forehead curl and just TWO OR THREE broad mane curls/tufts. Big rounded-square head and short muzzle, no dense fine filigree or realistic ornate emblem rendering. Preserve recognizable guardian-lion ears, a little gray nose, and a SMALL CUTE OPEN MOUTH WITH TWO LITTLE FANG/TEETH ACCENTS, using only a few pixel clusters. EYES ARE CRITICAL: exactly TWO IDENTICAL SOLID DARK CHARCOAL SHORT RECTANGLES, roughly 2:1 in length-to-width, arranged like the user's sketch. Each rectangle's long direction is lower-left to upper-right, the pair sits along the head's upper-left to lower-right eye line. No eye whites, iris, pupil, highlight, eye outlines, brows, lashes, smooth oval shapes, capsule eyes or rounded pill ends. Flat-ended rectangle geometry translated into clear axis-aligned staircase pixels. Match the sketch's simple eye language exactly, using only dark charcoal fill rather than the annotation's yellow/orange colors. COMPOSITION: close-up head leaning approximately 45 degrees clockwise from lower left, lower-left mane and cheek intentionally cropped, most of both ears and forehead recognizable, both eyes and mouth visible, uncluttered open space in the upper right. PIXEL GRID: one hidden 64x64 base lattice covers the entire square canvas. Main construction uses large 2x2 and 4x4-cell aligned clusters for a roughly 32x32-pixel main-form appearance; small details use whole single base cells. All sizes are exact integer multiples of the shared base and boundaries snap to this same grid, never half-cell offsets. Individual pixel cells ALWAYS stay HORIZONTAL AND VERTICAL WITH THE CANVAS even while the CHARACTER tilts. Draw the diagonal pose as staircase pixel shapes, never rotate a finished pixel raster. Restricted palette of 5-7 flat neutral grayscale colors; white, light gray, medium gray, charcoal and near-black. Broad continuous flat-color areas and only simple hard-edged shadow patches. Fully opaque interiors and fully transparent background with crisp binary alpha edges. NO antialiasing, smooth curves, blur, gradients, soft shading, chrome reflections, noisy texture, tiny scattered speckles, dithering, many curls or thin strokes. No body, extra objects, background tile, badge, frame, text, logo, watermark or ground shadow. Output ONE standalone square transparent PNG avatar, aim for 1024x1024, a charming intentionally low-resolution game sprite.
```
