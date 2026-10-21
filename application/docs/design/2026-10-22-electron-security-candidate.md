# Electron 44.x 安全维护与开发包签名边界

状态：隔离候选，尚未更新原应用；完整应用／CI 和原窗口验收分别记录。

## 版本和影响

Electron 从锁定的 44.2.0 更新到同主版本 44.9.3，关闭完整 npm audit 中的
GHSA-fw47-9c62-h3vw。虽然 npm 将 Electron 列为开发依赖，它是实际分发的
Desktop 引擎，不能用 production-only audit 排除。只更改此直接依赖及其
锁定记录、许可证；不使用 audit fix，不升级无关依赖，不换用户数据目录。

新候选在独立自动化目录、精确 lock 的 npm ci 下验证，实际可执行文件及
dist/version 均为 44.9.3。完整依赖 audit 为零；原生启动与权限／生命周期
专项 48 项通过，内嵌 Desktop、真实公开 PDF OCR 和阅读器 12 轮稳定性通过。
这些是自动化夹具，不代表原应用／用户窗口已经验收。

## 完整打包发现的问题

直接用 Electron 运行页面并不能证明最终 Morphz.app 可正确打包。新增的
真实完整打包检查发现，此候选的 Framework 只有有效的 Mach-O linker ad-hoc
签名，没有 bundle 的资源封装；旧打包器假定第三方 Framework 已完整签名。
另外，普通版本／图标校验戳放在 Contents 根部，会被新包签名视为嵌套代码。

新建包将两份戳放入 Contents/Resources。已有旧格式戳只原位读取，正常重开
不为迁移路径而改字节或重签名；两份同时存在则拒绝猜测。Electron 版本不符、
不完整包和运行中修改的原保护保持不变。真正升级仍须先正常退出，保留旧包，
再在原固定路径重建，不在原签名包上直接覆盖新引擎。

## 限定的本地开发签名

只对本次全新复制的开发包检查直接 Framework。完整严格校验已通过的厂商
签名原样保留；只有签名明确为 linker-signed、adhoc、无 TeamIdentifier、
Sealed Resources=none，且忽略不存在的资源封装后代码签名仍有效，才补充
本地 ad-hoc 资源封装。之后立即完整严格校验，最后再严格递归校验整个应用。
不以 --deep 批量重签，不忽略最终资源验证，不把 Developer ID 签名失败当作
“未签名”修复，也不修复已有安装包或已封装后发生改变的 Framework。

这只是本机开发包，不宣称 Developer ID、notarization 或正式分发签名。
共享 node_modules/Electron.app 和原应用均不由隔离测试改写。

## 回归要求

真实 macOS 测试使用生产打包器、新引擎和系统 codesign，在临时自动化目录
构建，不启动第二个手工验收应用。断言完整嵌套签名通过、两份戳位于 Resources、
同配置重开不改资源签名／启动器／包时间、已签 Framework 被改动后必须拒绝、
引擎版本不符必须拒绝且不覆盖启动器。非 macOS 是明确的平台不适用，不冒称
已执行该系统检查。完整测试、GitHub 检查和原应用更新仍是独立交付门槛。
