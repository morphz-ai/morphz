# Morphz

[English](README.md) · 简体中文

> **从聊天补全走向结构化上下文求值。**

<p align="center">
  <a href="https://morphz.ai/#demo">
    <img src="website/public/video/morphz-concept-demo-poster.jpg" alt="用 74 秒了解 Morphz" width="960">
  </a>
</p>

<p align="center"><a href="https://morphz.ai/#demo"><strong>用 74 秒了解 Morphz →</strong></a></p>

Morphz 是一台面向持久 Agent 的 **S 表达式认知机（S-Expression Cognitive Machine）**。
它让结构化 Context，而不是不断增长的聊天记录，成为大语言模型直接求值的对象。模型负责
非确定性语义处理；确定性事务内核负责事实、权限、状态、执行与恢复。

Morphz 由新变元创建并维护。

## Developer Preview

Morphz 0.1 是一次以源码为先的 Developer Preview。核心机制已经可以复现，公开接口、
多进程运行和部分跨平台验证仍在演进，后续可能发生不兼容变更；当前版本也不承诺生产级
多租户云服务能力。

Morphz 已经拥有 macOS、Linux 和 Windows 的原生沙箱实现，但 0.1 最终支持的操作系统与
架构矩阵仍在验证中。Linux 的 workspace-write 模式依赖 Bubblewrap；Windows 的安全声明
依赖包含完整辅助程序的 Morphz Windows bundle。

已经实现、完成验证、仍属实验以及尚在规划的能力边界，以
[当前核心实现状态](docs/morphz_runtime_core_implementation_status_v1.md)为准。

## Morphz 改变了什么

- **Context 是持久状态。** Agent 拥有带版本的认知 Frames，不依附于某一个 Session 或聊天记录。
- **求值是状态变换。** 模型提出语义判断与行动；确定性内核验证并提交获得授权的变化。
- **并发具有因果结构。** Objectives、Threads、Activations、依赖关系和版本化事务让并行工作
  可以被检查和恢复。
- **认知实践可以编程。** Harness 包和 Yao 程序可以定义求值循环，而不替换 Agent 身份。
- **经验可以成为可移植证据。** Agent Trajectory 与 Mind Frame Exchange 规范定义了跨实现的
  可审计记录与选择性认知交换。

## 安装与运行

### 前置条件

- 可以访问至少一个受支持的模型服务；
- 对交给 Agent 的工作目录具有读写权限。

在 macOS 或 Linux 上安装预编译版本：

```bash
curl -fsSL https://morphz.ai/install.sh | sh -s -- setup
```

Windows PowerShell：

```powershell
irm https://morphz.ai/install.ps1 | iex
```

安装器会显示各安装阶段，选择对应的 GitHub Release 原生制品、校验 SHA-256，并为后续
终端配置用户级命令路径。`setup` 参数会让安装器直接启动设置；打开新终端后可继续：

```bash
morphz doctor
morphz
```

`setup` 默认打开内嵌的控制台向导。在 SSH 主机或没有浏览器的机器上使用 `setup --tui`；
只需要输出控制台地址而不打开浏览器时，使用 `setup --no-open`。

Morphz 的启动目录可能成为 Agent 的工作目录；必要时用显式的 `--cwd` 启动，不要无意中
把源码 checkout 的写权限交给实验中的 Agent。开发者仍可使用
[`rust-toolchain.toml`](rust-toolchain.toml) 固定的工具链从源码构建。

完整首次运行流程见[快速开始](https://morphz.ai/docs/getting-started)。

## 文档与研究

- [项目主站](https://morphz.ai)
- [产品文档](https://morphz.ai/docs)
- [技术文章：从聊天补全到结构化上下文求值](https://morphz.ai/blog/from-chat-completion-to-structured-context-evaluation)
- [中文预印本](website/public/paper/morphz_nondeterministic_cognitive_symbol_evaluation_preprint_zh.pdf)
  · [English preprint](website/public/paper/morphz_nondeterministic_cognitive_symbol_evaluation_preprint_en.pdf)
- [Morphz 技术标准](docs/standards/zh-CN/README.md)
- [核心实现状态](docs/morphz_runtime_core_implementation_status_v1.md)

标准工作区包括 Structured Context、Agent Trajectory、Cognitive Application 与 Harness、
Yao，以及 Mind Frame Exchange。Draft 标准描述的是评审目标，并不自动证明每一项要求都已经实现。

## 仓库结构

- `morphz/`：核心实现、Application API、CLI 与 Server 适配器；
- `yao/`：确定性求值程序使用的类型化语言；
- `morphz-evals/`：评测框架与测试夹具；
- `extensions/`：默认核心之外的可选能力；
- `dashboard/`：内嵌的 Web 控制面与 Inspector；
- `website/`：Morphz 技术主站；
- `docs/standards/`：公开规范与一致性工作；
- `docs/`：架构、研究、验证与路线文档。

## 开发

运行 Rust 质量门禁：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
cargo build --release --workspace
```

单独验证 Dashboard：

```bash
cd dashboard
npm ci
npm run lint
npm run test
npm run build
```

提交变更前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，项目与标准治理方式见
[GOVERNANCE.md](GOVERNANCE.md)。

## 安全

Morphz 对文件、Shell、本机执行和远程执行能力使用统一的权限配置。workspace-write 模式由
操作系统原生沙箱强制执行；缺少所需后端时会 fail closed。`full_access` 会主动移除这些边界，
只应在已经信任的环境中使用。

安全模型仍属于 Developer Preview。向不可信工作区或远程用户开放 Morphz 之前，请阅读
[统一沙箱与审批架构](docs/morphz_sandbox_execution_and_approval_architecture.md)。

## 许可证

原创源码、测试、开发工具、技术文档、规范文本和公开一致性测试夹具通常采用
[Apache License 2.0](LICENSE)。论文、专利文件、网站编辑内容、品牌素材和第三方材料可能适用
独立条款。完整边界见[许可证适用范围](LICENSE_SCOPE.zh-CN.md)、
[专利政策](PATENTS.zh-CN.md)、[商标政策](TRADEMARKS.zh-CN.md)与
[第三方声明](THIRD_PARTY_NOTICES.md)。
