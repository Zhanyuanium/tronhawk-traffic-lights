# TronHawk 红绿灯按钮

将目标 Electron 应用自绘的右上角窗口控件搬移到左上角，改为 macOS
红绿灯式按钮。

实现思路是 **CSS 搬移 + 重绘**：原按钮保留在 DOM 中，点击功能不变，仅改变
位置与外观。插件完全遵守沙盒契约：无 DOM/Node/Electron 直访，无任意页面
JS bridge，不依赖 Electron 私有 API。

## 安装

```sh
bun install
```

这会安装 `@tronhawk/sdk`（类型 + 测试辅助，npmjs `^0.2.0`）以及
`@tronhawk/cli` devDependency（npmjs `^0.1.1`，`tronhawk` 二进制）、
`typescript` 和 `@types/bun`。不需要 monorepo checkout。

## 构建、校验、打包（独立工具链）

`@tronhawk/cli` devDependency（`tronhawk` 二进制）驱动整条工具链。权威
检查永远跑在同版本 Rust 引擎（`tronhawk-pack`）里；`build` / `test` 通过
绝不代替 `validate`：

```sh
bun run build          # tronhawk build .：把 src/ 入口打包为 dist/（单文件 CommonJS）
bun run typecheck      # src/ 上跑 tsc --noEmit（经 allowJs/checkJs 检查 .js）
bun test               # 基于 @tronhawk/sdk mock 的 renderer 冒烟测试（无需宿主）
tronhawk validate .    # 权威目录检查（不写任何文件）
tronhawk test . --sandbox  # QuickJS 契约 harness（与宿主同加载约定）
bun run pack           # tronhawk pack . traffic-lights.thx：build -> staging -> Rust pack
tronhawk inspect traffic-lights.thx   # 透传给 Rust 引擎
```

CLI 需要原生引擎（同版本 `tronhawk-pack`）：把 `TRONHAWK_PACK_BIN` 指向
引擎二进制即可，例如

```sh
TRONHAWK_PACK_BIN=<tronhawk-repo>/target/release/tronhawk-pack.exe tronhawk validate .
```

（在 TronHawk checkout 根目录跑
`cargo build -p tronhawk-package --release` 构建，或从 TronHawk GitHub
Release 下载对应 OS/arch 的产物）。CLI 的 `tronhawk.engineVersion` 必须
与 `tronhawk-pack --version` 严格相等；二进制缺失、digest 不一致或版本
不一致都会 hard-fail 并给出安装指引 —— 不存在 TypeScript 兜底打包器。
Exit code 是稳定契约：0 成功，1 权威拒绝（stderr 会点名原因），2 CLI
用法错误。

`tronhawk build` 把 `src/` 入口打包到 `dist/`（源码 `manifest.json` 保留
`entry.renderer: "src/renderer.js"`，构建才能找到 TypeScript 源；
`src/renderer.ts` 是类型源，`src/renderer.js` 是 CommonJS 运行时文件）。
`tronhawk pack` 接着做最小 staging（`manifest.json` + `dist/*.js` +
`style.css`）并只调一次权威 Rust `pack`（temp 文件 + 同 crate round-trip
+ 原子 rename 全在 Rust 内），因此包内 manifest 指向构建产物
`dist/renderer.js`。`dist/` 与 `*.thx` 已 git-ignored。

替代方案（TronHawk monorepo checkout 内，仓库根目录执行）：

```sh
cargo run -p tronhawk-package --bin tronhawk-pack -- validate <path-to-plugin>
cargo run -p tronhawk-package --bin tronhawk-pack -- pack <path-to-plugin> traffic-lights.thx
```

然后在 TronHawk Manager 中加载 `traffic-lights.thx`。

## 权限（最小按需）

- `renderer.css` —— 注入 `style.css`（经 `webContents.insertCSS` 的静态 CSS
  data）及一小段运行时 padding 补丁，开启时再加一段短期装饰兜底规则。
- `renderer.dom` —— 用快照式 `query` 探测窗口控件组（诊断日志 + 兜底
  检测），仅在兜底生效期间保留一个短期 `observe` 订阅。真实控件一
  出现或插件停用即断开；快照相对实时 DOM 最多滞后一个轮询间隔（约
  500ms）。
- `renderer.script` —— 仅做一次标题保持式 `ctx.script.setDocumentTitle`
  调用（读 `<title>` 快照再写回，可见标题不变）。必须声明，否则 Core 仅在
  grants 含 `renderer.script`（或 `runtime.unsafe`）时才保留
  `plugin.renderer`，renderer 将根本不会执行。
- `electron.windowControls` —— 宿主托管的功能性 overlay
 （`ctx.windowControls.mount` / `unmount`，固定样式红绿灯，绑定当前窗口
 的最小化 / 最大化切换 / 关闭）。仅在未检测到原控件时使用，与装饰灯
 永不同时显示。

## 统一样式

两条路径共用同一套视觉语言——14px 矢量灯（DIP/CSS px；DPR=2 时 28 物理像素）、
pitch 24（gap 10、24×24 格、内距 5）、悬停 ×/–/+ 矢量字形（14 网格、居中、
仅悬停显示、aria-hidden）、`#0a84ff` focus 轮廓：宿主 overlay（72×H 视图、
原点 (m+L, 0) 其中 m=(H-24)/2、默认 (3,0,72,30)、m=(H-24)/2，透明 24×24 命中格 + 居中 14px
内联 SVG，字形仅悬停显示）与挪位后的 DOM 原按钮（原位重绘、悬停居中 SVG 背景
字形，仍是应用自己的可点击
控件）。唯一区别是控件来源。装饰兜底不带 hover 字形。overlay pitch 恒为 24
（H 只改变视图高度与 m）；挪 DOM pitch 同样固定（尺寸 14 + 间距 10 = 24）——
如需调整请覆盖下方的 `:root` 变量，而非走 manifest 配置。overlay 提示语取宿主侧 en/zh 表（应用 locale `zh` 前缀选中中文），可用
`tooltip-*` 配置逐个覆盖（空=语言默认值）。

## Manifest（须满足宿主 schema）

```json
{
  "id": "com.tronhawk.traffic-lights",
  "name": "Traffic Lights",
  "version": "0.1.0",
  "author": "TronHawk Contributors",
  "tronhawk": "^0.1",
  "entry": { "css": "style.css", "renderer": "src/renderer.js" },
  "permissions": ["renderer.css", "renderer.dom", "renderer.script", "electron.windowControls"]
}
```

注意：顶层不允许 `description` 键（宿主 manifest schema 为
`deny_unknown_fields`）；`entry.renderer` 必须是 CommonJS
（`module.exports = { activate, deactivate }`），因为 QuickJS 沙盒跑的是
`vm.evalCode` —— `src/renderer.js` 是运行时入口，`src/renderer.ts` 是类型源。

## 配置项

在 Manager 设置表单中修改（默认值见 `manifest.json`）：

| 键 | 类型 | 默认值 | 含义 |
| --- | ---- | ------ | ---- |
| `left-offset` | number | 0 | 相对左调整量 L（CSS px/DIP，钳制 0-256，宿主 overlay 几何，视图原点 x = m+L 其中 m=(H-24)/2） |
| `region-height` | number | 30 | Overlay 区域高度 H（CSS px/DIP，钳制 30-64，宿主 overlay 几何，视图为 72×H，格 24×24，m=(H-24)/2） |
| `tooltip-close` | string | "" | 关闭提示覆盖（空=语言默认值） |
| `tooltip-minimize` | string | "" | 最小化提示覆盖（空=语言默认值） |
| `tooltip-maximize` | string | "" | 最大化提示覆盖（空=语言默认值） |
| `tooltip-restore` | string | "" | 还原提示覆盖（空=语言默认值） |
| `decorative-fallback-lights` | boolean | true | 未检测到窗口控件时显示装饰性兜底灯（装饰性，不可点击） |
| `functional-fallback-controls` | boolean | true | 未检测到窗口控件时优先挂载功能性宿主 overlay（functional host overlay，可点击） |

宿主 overlay 几何为受限声明式：宿主只从 plan 配置快照读取
`region-height`（H）与 `left-offset`（L）（manifest 默认值叠加已存值）。所有值均为
DIP/CSS px——宿主不做像素换算、不读 `devicePixelRatio`/`scaleFactor`、不测量显示器，
也无自动显示适配（物理像素严禁直接取作 CSS px：DPR=2 时 14 CSS = 28 物理）。
唯一数值表：d=14、p=24、格 24×24、内距 5、gap 10、H=30（30..64）、
m=(H-24)/2、默认 bounds (3,0,72,30)。视觉灯恒为 14px；配置变更的 plan revision 会销毁旧视图
按新几何重建；几何冲突的共存 owner 在 `mount()`（无参、不做 DOM 测量）直接失败。

DOM 路径几何固定（d=14、pitch 24、gap 10）；如需调整请直接覆盖 CSS 变量：

```css
:root {
  --th-traffic-size: 14px;
  --th-traffic-gap: 10px;
  --th-traffic-left: 12px;
  --th-traffic-top: 12px;
}
```

## 兼容性限制

- 纯 CSS 搬移：原按钮功能保留；关闭/最小化/最大化的映射优先使用
  `aria-label`/`title` 语义，其次使用位置兜底（`[最小化, 最大化, 关闭]` →
  `[关闭, 最小化, 最大化]`）。特殊排序可能需要自定义规则。
- 已覆盖通用 Electron 控件组（`.window-controls*`、`.window-control`、
  `[winButtons]`、`[p-titlebar__controls]` / `[titlebar__controls]`、
  `.caption-buttons` / `.captionButtons`、`.frameless-controls`）及原生
  macOS 红绿灯组。检测只用一次 `query` 匹配该组合；完全命中不了的自绘
  结构不会被搬移，而是走下面的装饰兜底。
- 装饰性兜底（默认开启，`decorative-fallback-lights`）：未检测到真实控
  件组时，renderer 会插入一段临时的单个 `html::before` 三灯
  （`pointer-events: none`，复用 `--th-traffic-size` /
  `--th-traffic-gap` / `--th-traffic-left` / `--th-traffic-top`，
  `forced-colors` 下隐藏）。装饰性兜底灯仅为装饰，不可点击，不能控制
  窗口（无法关闭/最小化/最大化）。期间会保留一个短期 `observe` 订阅等
  待晚到的真实控件（轮询延迟最多约 500ms），一旦出现立即移除兜底。单
  个 `html::before` 可能与同样使用 `html::before` 的应用或用户样式冲
  突，冲突时请将 `decorative-fallback-lights` 设为 `false`。
- 功能性兜底（默认开启，`functional-fallback-controls`）：未检测到真实
  控件组时，renderer 会先请求宿主挂载功能性 overlay
 （`ctx.windowControls.mount`，需 `electron.windowControls` 权限）。
  该 overlay 由宿主托管、样式固定、可点击（最小化 / 最大化切换 / 关闭
  当前窗口）。降级顺序严格为：真实控件（CSS 搬移，无 JS 兜底）→ 功能性
  宿主 overlay → 装饰灯（不可点击）→ 无兜底。overlay 与装饰灯永不同时
  显示：`mount()` 成功则跳过装饰灯；`mount()` 被拒（或宿主无该 API）则
  回落到装饰档；晚到的真实控件会先 unmount overlay 再转搬移路。
  `deactivate` 永远先断 observer，再 unmount overlay，再清装饰与 padding
  CSS，各步互不跳过、永不 reject。如需跳过 overlay 直走装饰档，请将
  `functional-fallback-controls` 设为 `false`。
- 若应用本身已渲染原生 macOS 红绿灯，插件会主动避让，避免重复渲染。
- 标题栏保持 `-webkit-app-region: drag`，按钮使用 `no-drag` 以保证可点击；
  hover 显示 `×/–/+` 字形；保留 `focus-visible` 无障碍轮廓；已做
  浅色/深色适配。

## 类型检查

```sh
bun install && bun run typecheck
```

（上文独立工具链的一环：`build` / `typecheck` / `test` / `validate` /
`pack` 全部脱离 monorepo checkout 运行。）
