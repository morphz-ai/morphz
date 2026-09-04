# Ubuntu 命令执行验证（2026-09-05）

本记录覆盖 Ubuntu ARM64 的命令执行与本轮沙箱修复，不代表全套发布门禁通过。

## 环境与版本

- 用户虚拟机：Ubuntu 26.04 LTS，aarch64，普通用户，Bubblewrap 0.11.1。
- 原运行实例：`b0832d46`，安装于 `/home/shafreeck/.local/bin/morphz`。原进程、安装文件和数据库保留。
- 首轮验证包：Release 工作流 `33904722193` 的 ARM64 产物，版本 `dab4039f`，下载及传输后均通过 SHA-256 校验。
- 本轮修复源码：冻结的 `dab4039f`，叠加执行输出/完全访问状态修复与本轮 Linux 挂载修复；未混入其他开发任务的未提交修改。
- 测试服务使用独立数据库、工作目录、端口和 Dashboard 访问令牌，模型沿用用户已配置的可用路由。

## 复现与修复

原截图中的 `failed to enumerate sandbox denied read pattern below '/'` 来自旧版本。`b722e039` 已移除 Linux 通配保护路径的递归展开；无法直接执行的通配规则会明确拒绝，不再扫描整个文件系统。

在虚拟机上运行 `dab4039f` 又发现两处挂载问题：

1. 私有 HOME/TMP 在保护路径挂载完成前就被设为只读，导致 Bubblewrap 为保护 `~/.ssh` 建立沙箱内挂载点时失败。现将父目录只读操作移至全部保护挂载完成之后。
2. HOME 被明确授予为可写工作区时，末尾的只读操作覆盖了这项授权。现保留与私有根目录完全匹配的写授权；更窄的保护挂载仍然生效。

新增三项回归测试在旧实现上全部失败，在修复后全部通过。测试通过临时夹具验证行为，未读取真实 SSH 私钥或修改用户配置。

## 原生回归结果

使用实际 `sandbox.rs` 源文件构建轻量测试程序，在 Ubuntu 运行 12 项测试：全部通过，无跳过。设置 `MORPHZ_REQUIRE_LINUX_SANDBOX_ATTACK_TEST=1`，确保 Bubblewrap 缺失或不可用时测试失败。

- 工作区文件创建、读取、删除成功。
- HOME 作为工作区时，直接在 HOME 内写入临时文件成功。
- 私有 HOME 下的保护目录成功挂载；夹具内容不可读取。
- 保护文件被屏蔽且不可写；宿主夹具原内容保持不变。
- 工作区外写入被拒，禁止网络的原生测试通过。
- 不支持的通配保护规则明确失败，无递归展开。
- `strace -f -yy -e trace=getdents64` 对原生沙箱执行 `pwd` 的记录仅包含进程自身 `/proc/<pid>/fd` 枚举，没有系统盘或用户目录遍历。

## 完整程序验证

完整测试程序在 Ubuntu 本机构建，复用已有 Cargo 缓存，单编译任务、LLD、关闭调试符号。该产物用于本轮功能验证；正式发布仍须构建发布配置并跑发布门禁。

完整程序版本：`morphz 0.1.0 (git dab4039f-ubuntu-sandbox-fix-20260905)`。

通过 HTTP API 创建独立会话，由已配置的 `k3-256k` 模型调用真实 `exec` 工具；未用模拟工具结果。逐项校验执行事件、退出码、输出标记、边界状态和宿主文件清理结果。

| 场景 | 结果 |
| --- | --- |
| 普通工作区，自动审批沙箱，`pwd` → 创建 → `ls` → `cat` → 删除 | 退出码 0，`linux-native` / `enforced` |
| 普通工作区，完全访问，同样的文件操作 | 退出码 0，`linux-native` / `disabled` |
| HOME 作为工作区，自动审批沙箱，通过 `~/...` 创建、查看、读取和删除文件 | 退出码 0，`linux-native` / `enforced` |

三组执行的测试文件均已删除；原生保护夹具由临时目录析构清理。独立测试服务验证后关闭，二进制、测试数据库及结果 JSON 保留在 `/home/shafreeck/morphz-linux-validation-20260905`。

## 产物与状态

- 验证二进制：`/home/shafreeck/morphz-linux-validation-20260905/fixed-bundle/morphz`。
- 二进制 SHA-256：`ea253a3ff9b0ff13dd9a6395b3ccdf71afc98c1f28f5ba4302a95c55c2079cc6`。
- `sandbox.rs` SHA-256：`8f73fd02af870708c4f859e4b2d49c37d43fb25dd3f69ef4aaa1ccb90cf74ae0`。
- `tool.rs` SHA-256：`3edf0193efd61b6b62a07315251b10d19ac5ce13ded24373ac8f7c7274486c8d`。
- 本地源码与 Ubuntu 冻结源码的上述两个文件哈希一致。
- 原安装二进制 SHA-256 仍为 `0fa923391a69107b4da3b6029700cc2240bb984dc4acef8e2ed27d691532dde0`，原 PID 7372 保持运行。
- 未替换用户安装；本记录随执行修复一起提交，尚未推送或发布新版本。

## 手动复测

在 Ubuntu 终端执行以下两行。第一行显示这个独立测试实例的登录令牌；第二行启动修复版，保留终端运行：

```bash
cat ~/morphz-linux-validation-20260905/dashboard.token
python3 ~/morphz-linux-validation-20260905/morphz-linux-validation-start.py --fixed --home-workspace
```

在 Ubuntu 浏览器打开 `http://127.0.0.1:18087/`，使用上面的令牌登录。该实例以 HOME 为工作区，使用独立测试数据库，沿用已有模型配置。

新建会话，保留自动审批沙箱模式，让智能体执行 `pwd`、列出当前目录，再创建、读取、删除一个测试文件；也可切换完全访问模式重复操作。原实例仍然使用旧版本，复测应使用上述端口。关闭测试时在启动终端按 Ctrl+C。
