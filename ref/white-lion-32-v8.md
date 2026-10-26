# 白毛狮子头像：原生像素版 v8

- 绘制方式：按用户要求采用 MC 皮肤式逐格绘制，直接建立 32×32 RGBA 像素画布。
- 造型参考：`default-icon-pixel-v1.png`。保留白毛、卷曲鬃毛、狮子鼻吻、张嘴和獠牙。
- 眼睛：两个纯深灰矩形，每个占 2×3 个格子，不含瞳孔、眼白或高光。
- 颜色：5 个不透明灰阶颜色及透明背景；所有笔画均为整数像素。
- 正面原图：`white-lion-upright-32-v8.png`，32×32。
- 正面预览：`white-lion-upright-32-v8-preview.png`，最近邻放大 16 倍。
- 旋转中间图：`white-lion-rotated45-full-v8.png`，顺时针 45° 最近邻旋转，46×46 透明画布。
- 最终头像：`white-lion-avatar-32-v8.png`，按已确认的左下探入构图裁切为 32×32。
- 头像预览：`white-lion-avatar-32-v8-preview.png`，最近邻放大 16 倍。
- 绘制与旋转源码：`white-lion-32-v8.mjs`。

本轮直接绘制原生像素，没有将高分辨率图片缩小作为本轮底图。
