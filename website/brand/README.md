# Morphz 标识素材

从原始分享封面 `public/og.png` 中整理的 M／蝶翼标识。保留对称翼面、中央凹口和蓝紫配色；独立标识使用清晰的矢量轮廓。

## 文件

- `public/brand/morphz-mark.svg`：彩色版，透明背景。
- `public/brand/morphz-mark-cyan.svg`：电光青纯色版，`#56d0de`，当前用于导航栏。
- `public/brand/morphz-mark-ink.svg`：深色单色版，适合浅色背景与小尺寸。
- `public/brand/morphz-mark-white.svg`：白色单色版，适合深色背景。
- `public/brand/morphz-favicon.svg`：小尺寸专用版，使用实色蓝紫翼面，将中央暗色折角合入翼面，并略微放大轮廓；另有 16、32、48 px 透明 PNG。
- `public/brand/morphz-favicon-cyan.svg`：相同小尺寸轮廓的电光青纯色版，当前用于 favicon，另有 16、32、48 px 透明 PNG。
- 同名 `-16.png` 至 `-512.png`：透明 PNG 导出，共 8 种尺寸。
- `public/brand/preview.png`：彩色、单色、深浅背景及实际小尺寸对照。

四个常规尺寸 SVG 共用 `0 0 96 96` 坐标与完全相同的路径。标识自身无背景、描边、光晕或字体依赖。预览中的 Morphz 字样仅用于组合效果检查。

## 使用

保持宽高比例，外围建议至少留出标识宽度的 1/4 作为净空。常规界面建议使用 24 px 及以上；favicon 使用单独绘制的小尺寸版。导航栏使用 28 px 电光青纯色版，蓝紫版保留备用。

SVG 用作 `<img>` 时应由调用方提供合适的 `alt`。如果旁边已有完整的 Morphz 文字，可使用 `alt=""`，避免读屏重复播报。内联多个彩色 SVG 时，需要为每份渐变与标题 ID 加唯一前缀。

网站 favicon 在 `app/layout.tsx` 中配置，使用 `morphz-favicon-cyan.svg`，并提供 `morphz-favicon-cyan-32.png` 作为兼容版本。中英文首页和内容页面共用这组图标。

## 导出

导出脚本独立于站点构建。使用现有的 sharp 安装：

```sh
MORPHZ_BRAND_SHARP=/absolute/path/to/sharp/dist/index.cjs node scripts/render-brand-assets.mjs
```

也可在环境能直接解析 `sharp` 时运行 `node scripts/render-brand-assets.mjs`。脚本只从 SVG 生成 PNG 与对照图，不修改分享封面的原始位图。

## 分享封面

当前选定的分享封面是 `public/brand/og-cyan-v2.png`，为 1731 × 909 PNG。`app/layout.tsx` 的 Open Graph 与 X 卡片均引用这个版本，图片尺寸与描述同步更新。原始 `public/og.png` 和蓝紫版 `public/brand/og-v2.png` 保留。分享封面的文字对应当前三项核心能力：

> Open-source agent
>
> Autonomous context maintenance.
> Concurrent scheduling. Governed execution.

封面最初采用 imagegen 对原位图进行定向文字编辑，生成提示词见 `cover-edit-prompt.txt`；后续电光青调整见下面的版本记录。网站导航栏和 favicon 使用电光青纯色标识；Dashboard 和演示视频保持原样。这次修改仅供本地预览，不包含线上部署。

### 电光青版本记录

`public/brand/og-cyan-v1.png` 保留现有封面文案和构图，将标识、线条、圆环及光线统一为电光青与深青色。使用内置 imagegen 编辑生成，并以 `morphz-mark-cyan-512.png` 作为标识参考；完整提示词分别保存在 `cover-cyan-edit-prompt.txt` 与 `cover-cyan-logo-refinement-prompt.txt`。

这份纯色封面保留用于比较，不被当前 metadata 引用。蓝紫原版也保留。

`public/brand/og-cyan-v2.png` 是当前选定的电光青渐变版：仅为封面的大尺寸 logo 增加冰青高光到深青的渐变，保持背景与文案。由内置 imagegen 编辑生成，提示词见 `cover-cyan-gradient-edit-prompt.txt`。已接入 Open Graph / X metadata，尚未部署。网站导航栏和 favicon 仍使用电光青纯色版本。

`public/brand/og-cyan-violet-v1.png` 是独立保存的多色色相渐变试验版：logo 以电光青为主，右翼由青经蓝过渡到紫色；背景仍为电光青。由内置 imagegen 编辑生成，提示词见 `cover-cyan-violet-edit-prompt.txt`。该试验版保留备用，不被当前 metadata 引用；网站采用 `og-cyan-v2.png`。
