---
title: 命令行参考
description: 从 Morphz 当前命令结构自动生成的完整命令索引与顶层帮助。
section: reference
order: 400
status: current
source: generated-cli-schema
---

> 本页根据 Morphz 当前命令行结构生成，并与当前二进制保持一致。

## 命令索引

| 命令 | 说明 |
|---|---|
| `morphz exec` | 执行一次提示并输出最终回复 |
| `morphz resume` | 重新连接现有或最近活跃的会话 |
| `morphz serve` | 启动网络运行时和内置控制台 |
| `morphz dashboard` | 启动控制台并在默认浏览器中打开 |
| `morphz edge` | 配对并运行主动出站的执行节点 |
| `morphz edge pairing-code` | 为当前身份创建短期执行节点配对码 |
| `morphz edge nodes` | 列出当前身份拥有的执行节点 |
| `morphz edge revoke` | 撤销一个已配对执行节点 |
| `morphz edge local-leases` | 列出当前节点本地保存的能力租约 |
| `morphz edge revoke-local-lease` | 撤销一个节点本地能力租约 |
| `morphz edge pair` | 将此设备与 Morphz 网关配对 |
| `morphz edge run` | 运行经过认证的主动出站边缘执行器 |
| `morphz edge rotate-key` | 轮换此执行节点的设备身份密钥 |
| `morphz edge status` | 显示已配对节点和本地执行节点身份 |
| `morphz target` | 检查和管理执行节点 |
| `morphz target list` | 列出当前身份可见的执行节点 |
| `morphz target show` | 查看一个执行节点 |
| `morphz target enable` | 启用一个执行节点 |
| `morphz target disable` | 禁用一个执行节点 |
| `morphz target authorize` | 将执行节点限制到智能体、上下文或线程范围 |
| `morphz target authorizations` | 列出执行节点的范围授权 |
| `morphz target revoke-authorization` | 撤销一个执行节点范围授权 |
| `morphz lease` | 检查和撤销执行节点能力租约 |
| `morphz lease list` | 列出有效的能力租约 |
| `morphz lease revoke` | 撤销一个能力租约 |
| `morphz execution` | 检查和控制持久化物理执行任务 |
| `morphz execution list` | 列出物理执行任务 |
| `morphz execution show` | 查看一个物理执行任务 |
| `morphz execution output` | 读取一个任务持久化的标准输出和错误输出 |
| `morphz execution cancel` | 请求取消一个物理执行任务 |
| `morphz setup` | 打开模型服务商配置向导 |
| `morphz provider` | 检查并验证模型服务商 |
| `morphz provider list` | 列出目录和已配置的模型服务商 |
| `morphz provider test` | 验证模型服务商的目录、流式响应和工具调用 |
| `morphz provider show` | 查看一个有效模型服务实例 |
| `morphz provider set` | 校验并保存模型服务实例 TOML 文件 |
| `morphz provider account` | 管理模型服务认证账号 |
| `morphz provider account list` | 列出账号配置和运行时状态 |
| `morphz provider account login` | 开始 OAuth 登录 |
| `morphz provider account complete` | 完成或轮询 OAuth 登录 |
| `morphz provider account logout` | 注销 OAuth 登录 |
| `morphz provider account set` | 校验并保存不含 Secret 的 Auth Account TOML |
| `morphz provider account enable` | 启用账号 |
| `morphz provider account disable` | 禁用账号 |
| `morphz provider account test` | 通过兼容的模型路由诊断一个认证账号 |
| `morphz model` | 发现或选择模型 |
| `morphz model list` | 列出模型服务商提供的模型 |
| `morphz model use` | 保存默认模型服务商和模型 |
| `morphz model refresh` | 刷新并验证一个模型路由的远端目录 |
| `morphz model route` | 管理逻辑模型路由 |
| `morphz model route list` | 列出有效模型路由 |
| `morphz model route show` | 查看模型路由 |
| `morphz model route set` | 校验并保存模型路由 TOML 文件 |
| `morphz model route test` | 诊断路由解析、账号认证和模型服务健康状态 |
| `morphz profile` | 检查或选择配置方案 |
| `morphz profile list` | 列出可用的配置方案 |
| `morphz profile show` | 显示配置方案的解析结果 |
| `morphz profile use` | 选择默认配置方案 |
| `morphz context` | 检查持久认知上下文 |
| `morphz context list` | 列出认知上下文 |
| `morphz context show` | 显示一个认知上下文 |
| `morphz context status` | 显示上下文状态、会话和活跃工作 |
| `morphz context audit` | 通过事件回放验证上下文的认知投影 |
| `morphz context recall-index` | 检查或重建派生的词法召回索引 |
| `morphz context recall-index inspect` | 显示召回索引能力与文档数量 |
| `morphz context recall-index rebuild` | 根据持久化事件与认知重建派生的召回索引 |
| `morphz context recall` | 搜索上下文记忆或遍历一个认知帧的血缘 |
| `morphz context recall search` | 搜索已索引的事件与认知帧文档 |
| `morphz context recall frame` | 遍历认知帧的来源与关系 |
| `morphz scheduler` | 检查权威调度器状态 |
| `morphz scheduler show` | 显示线程、求值、作业、审批和调度计划 |
| `morphz scheduler thread` | 检查和控制一条持久线程 |
| `morphz scheduler thread show` | 显示一条线程的因果链和结构化结果 |
| `morphz scheduler thread pause` | 暂停线程 |
| `morphz scheduler thread resume` | 继续线程 |
| `morphz scheduler thread cancel` | 取消线程 |
| `morphz scheduler thread supersede` | 取消当前代次并按修订后的要求继续 |
| `morphz session` | 管理上下文中的会话 |
| `morphz session list` | 列出会话 |
| `morphz session show` | 显示一个会话 |
| `morphz session create` | 在指定上下文中创建会话 |
| `morphz session resume` | 重新连接现有或最近活跃的会话 |
| `morphz agent` | 管理持久智能体 |
| `morphz agent list` | 列出智能体 |
| `morphz agent show` | 显示一个智能体 |
| `morphz agent create` | 创建带根上下文和初始会话的智能体 |
| `morphz harness` | 安装和查看版本化领域程序包 |
| `morphz harness list` | 列出已安装的领域程序包版本 |
| `morphz harness show` | 显示一个已安装领域程序包的精确版本 |
| `morphz harness install` | 校验并安装 .hns 文件或目录 |
| `morphz objective` | 管理长期目标 |
| `morphz objective list` | 列出上下文中的目标 |
| `morphz objective show` | 显示一个目标 |
| `morphz objective create` | 创建并运行长期目标 |
| `morphz objective edit` | 使用修订隔离替换目标内容 |
| `morphz objective pause` | 暂停目标 |
| `morphz objective resume` | 继续目标 |
| `morphz objective cancel` | 取消目标 |
| `morphz trajectory` | 导出和校验可移植的智能体执行轨迹包 |
| `morphz trajectory export` | 将运行时权威事实导出为智能体执行轨迹包 |
| `morphz trajectory verify` | 校验不可信的智能体执行轨迹包 |
| `morphz trajectory episode` | 派生经过权限校验的训练片段 |
| `morphz storage` | 检查并迁移运行时存储权威 |
| `morphz storage migrate-cognitive-store` | 将认知状态显式同步到选定存储引擎 |
| `morphz experiment` | 检查并验证显式门控的实验功能 |
| `morphz experiment list` | 列出实验功能的编译与启用状态 |
| `morphz experiment check` | 确认一个实验功能已经编译并启用 |
| `morphz job` | 检查或取消子智能体委派 |
| `morphz job list` | 列出子智能体委派 |
| `morphz job cancel` | 取消子智能体委派及其后代 |
| `morphz config` | 检查解析后的配置及其来源 |
| `morphz config show` | 输出解析后的配置 |
| `morphz config check` | 验证所有已加载的配置层 |
| `morphz config path` | 按优先级列出已加载的配置文件 |
| `morphz config explain` | 说明每个解析值的来源 |
| `morphz update` | 从经过校验的 GitHub Release 更新 Morphz |
| `morphz update status` | 检查最新发行版本，不修改任何文件 |
| `morphz update rollback` | 恢复上次更新保留的旧版本 |
| `morphz doctor` | 检查存储、工作区、权限和模型服务商配置 |
| `morphz completion` | 生成命令行补全定义 |
| `morphz version` | 显示 Morphz 版本 |

## 顶层命令帮助

```text
Morphz 是一台具有持久上下文、会话、目标和全屏终端界面的 S 表达式认知机。语言模型是它的非确定性语义处理器，运行时是确定性事务内核。

不带子命令输入的文本会直接发送给所选智能体实例。

用法：morphz [OPTIONS] [PROMPT]... [COMMAND]

命令：
  exec
          执行一次提示并输出最终回复
  resume
          重新连接现有或最近活跃的会话
  serve
          启动网络运行时和内置控制台
  dashboard
          启动控制台并在默认浏览器中打开
  edge
          配对并运行主动出站的执行节点
  target
          检查和管理执行节点
  lease
          检查和撤销执行节点能力租约
  execution
          检查和控制持久化物理执行任务
  setup
          打开模型服务商配置向导
  provider
          检查并验证模型服务商
  model
          发现或选择模型
  profile
          检查或选择配置方案
  context
          检查持久认知上下文
  scheduler
          检查权威调度器状态
  session
          管理上下文中的会话
  agent
          管理持久智能体
  harness
          安装和查看版本化领域程序包
  objective
          管理长期目标
  trajectory
          导出和校验可移植的智能体执行轨迹包
  storage
          检查并迁移运行时存储权威
  experiment
          检查并验证显式门控的实验功能
  job
          检查或取消子智能体委派
  config
          检查解析后的配置及其来源
  update
          从经过校验的 GitHub Release 更新 Morphz
  doctor
          检查存储、工作区、权限和模型服务商配置
  completion
          生成命令行补全定义
  version
          显示 Morphz 版本
参数：
  [PROMPT]...
          直接向智能体发送文本
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录

      --config-file <FILE>
          加载指定的可信配置文件

  -p, --profile <NAME>
          加载具名配置方案

      --provider <ID>
          覆盖已配置的模型服务商

  -m, --model <MODEL>
          覆盖已配置的模型

      --reasoning-effort <LEVEL>
          设置模型推理强度

      --agent <ID>
          选择智能体

      --context <ID>
          选择或挂载认知上下文

      --session <ID>
          重新连接现有会话

      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本

  -s, --sandbox <MODE>
          设置命令沙箱模式

  -a, --approval <MODE>
          设置权限审批策略

      --add-dir <DIR>
          添加额外的可读写工作区目录

      --network[=<BOOL>]
          允许沙箱命令访问网络

  -c, --set <KEY=VALUE>
          覆盖单个配置值

      --log-level <FILTER>
          覆盖日志过滤器

      --theme <THEME>
          选择终端界面颜色主题

      --language <LANGUAGE>
          选择用户界面语言

      --format <FORMAT>
          选择管理命令输出格式

      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能

      --tui
          强制使用全屏终端界面

      --plain
          使用经典行式终端

  -h, --help
          显示帮助

  -V, --version
          显示版本

示例：
  morphz
  morphz 请帮我修复这个项目
  morphz -- session list
  morphz session list --format=json
  morphz resume --context=context-default
```

### `morphz exec`

执行一次提示并输出最终回复

```text
执行一次提示并输出最终回复

用法：morphz exec [OPTIONS] <PROMPT>...

参数：
  <PROMPT>...
          要发送给智能体的提示
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
  -h, --help
          显示帮助
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

示例：
  morphz exec explain this repository
  morphz exec -- --text-that-starts-with-a-dash
```

### `morphz resume`

重新连接现有或最近活跃的会话

```text
在不改变会话身份的前提下重新连接。不指定标识时，默认继续最近活跃的匹配会话。

用法：morphz resume [OPTIONS] [[SESSION] [PROMPT]]...

参数：
  [[SESSION] [PROMPT]]...
          可选的会话标识，之后可跟可选提示
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录

      --last
          继续最近活跃的匹配会话

      --config-file <FILE>
          加载指定的可信配置文件

  -h, --help
          显示帮助

  -p, --profile <NAME>
          加载具名配置方案

      --provider <ID>
          覆盖已配置的模型服务商

  -m, --model <MODEL>
          覆盖已配置的模型

      --reasoning-effort <LEVEL>
          设置模型推理强度

      --agent <ID>
          选择智能体

      --context <ID>
          选择或挂载认知上下文

      --session <ID>
          重新连接现有会话

      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本

  -s, --sandbox <MODE>
          设置命令沙箱模式

  -a, --approval <MODE>
          设置权限审批策略

      --add-dir <DIR>
          添加额外的可读写工作区目录

      --network[=<BOOL>]
          允许沙箱命令访问网络

  -c, --set <KEY=VALUE>
          覆盖单个配置值

      --log-level <FILTER>
          覆盖日志过滤器

      --theme <THEME>
          选择终端界面颜色主题

      --language <LANGUAGE>
          选择用户界面语言

      --format <FORMAT>
          选择管理命令输出格式

      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能

      --tui
          强制使用全屏终端界面

      --plain
          使用经典行式终端

  -V, --version
          显示版本

示例：
  morphz resume
  morphz resume session_123
  morphz resume session_123 continue the task
  morphz resume --context=context-default
```

### `morphz serve`

启动网络运行时和内置控制台

```text
启动 HTTP/WebSocket 运行时和内置控制台。环回地址可以不启用控制台认证；非环回地址需要 MORPHZ_DASHBOARD_TOKEN。

用法：morphz serve [OPTIONS]

选项：
      --bind <ADDR>
          监听地址

  -C, --cwd <DIR>
          在加载配置前更改工作目录

      --config-file <FILE>
          加载指定的可信配置文件

      --coordination-mesh <SOURCE>
          使用 static:URL,URL 或 file:PATH 加入 Coordination Mesh

  -h, --help
          显示帮助

  -p, --profile <NAME>
          加载具名配置方案

      --provider <ID>
          覆盖已配置的模型服务商

  -m, --model <MODEL>
          覆盖已配置的模型

      --reasoning-effort <LEVEL>
          设置模型推理强度

      --agent <ID>
          选择智能体

      --context <ID>
          选择或挂载认知上下文

      --session <ID>
          重新连接现有会话

      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本

  -s, --sandbox <MODE>
          设置命令沙箱模式

  -a, --approval <MODE>
          设置权限审批策略

      --add-dir <DIR>
          添加额外的可读写工作区目录

      --network[=<BOOL>]
          允许沙箱命令访问网络

  -c, --set <KEY=VALUE>
          覆盖单个配置值

      --log-level <FILTER>
          覆盖日志过滤器

      --theme <THEME>
          选择终端界面颜色主题

      --language <LANGUAGE>
          选择用户界面语言

      --format <FORMAT>
          选择管理命令输出格式

      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能

      --tui
          强制使用全屏终端界面

      --plain
          使用经典行式终端

  -V, --version
          显示版本

示例：
  morphz serve
  morphz serve --bind=127.0.0.1:9090
  morphz serve --coordination-mesh=static:http://10.0.0.11:18804,http://10.0.0.12:18804
  morphz serve --coordination-mesh=file:/etc/morphz/mesh.toml
  MORPHZ_DASHBOARD_TOKEN=replace-with-a-secret morphz serve --bind=0.0.0.0:18804
```

### `morphz dashboard`

启动控制台并在默认浏览器中打开

```text
使用密码学安全的随机临时认证令牌启动内置控制台，并在默认浏览器中打开本地地址。

用法：morphz dashboard [OPTIONS]

选项：
      --bind <ADDR>
          监听地址

  -C, --cwd <DIR>
          在加载配置前更改工作目录

      --config-file <FILE>
          加载指定的可信配置文件

      --no-open
          只输出控制台地址，不打开浏览器

  -h, --help
          显示帮助

  -p, --profile <NAME>
          加载具名配置方案

      --provider <ID>
          覆盖已配置的模型服务商

  -m, --model <MODEL>
          覆盖已配置的模型

      --reasoning-effort <LEVEL>
          设置模型推理强度

      --agent <ID>
          选择智能体

      --context <ID>
          选择或挂载认知上下文

      --session <ID>
          重新连接现有会话

      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本

  -s, --sandbox <MODE>
          设置命令沙箱模式

  -a, --approval <MODE>
          设置权限审批策略

      --add-dir <DIR>
          添加额外的可读写工作区目录

      --network[=<BOOL>]
          允许沙箱命令访问网络

  -c, --set <KEY=VALUE>
          覆盖单个配置值

      --log-level <FILTER>
          覆盖日志过滤器

      --theme <THEME>
          选择终端界面颜色主题

      --language <LANGUAGE>
          选择用户界面语言

      --format <FORMAT>
          选择管理命令输出格式

      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能

      --tui
          强制使用全屏终端界面

      --plain
          使用经典行式终端

  -V, --version
          显示版本

示例：
  morphz dashboard
  morphz dashboard --no-open
  morphz dashboard --bind=0.0.0.0:18804
```

### `morphz edge`

配对并运行主动出站的执行节点

```text
配对并运行主动出站的执行节点

用法：morphz edge [OPTIONS] [COMMAND]

命令：
  pairing-code
          为当前身份创建短期执行节点配对码
  nodes
          列出当前身份拥有的执行节点
  revoke
          撤销一个已配对执行节点
  local-leases
          列出当前节点本地保存的能力租约
  revoke-local-lease
          撤销一个节点本地能力租约
  pair
          将此设备与 Morphz 网关配对
  run
          运行经过认证的主动出站边缘执行器
  rotate-key
          轮换此执行节点的设备身份密钥
  status
          显示已配对节点和本地执行节点身份
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
  -h, --help
          显示帮助
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本
```

### `morphz target`

检查和管理执行节点

```text
检查和管理执行节点

用法：morphz target [OPTIONS] [COMMAND]

命令：
  list
          列出当前身份可见的执行节点
  show
          查看一个执行节点
  enable
          启用一个执行节点
  disable
          禁用一个执行节点
  authorize
          将执行节点限制到智能体、上下文或线程范围
  authorizations
          列出执行节点的范围授权
  revoke-authorization
          撤销一个执行节点范围授权
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
  -h, --help
          显示帮助
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本
```

### `morphz lease`

检查和撤销执行节点能力租约

```text
检查和撤销执行节点能力租约

用法：morphz lease [OPTIONS] [COMMAND]

命令：
  list
          列出有效的能力租约
  revoke
          撤销一个能力租约
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -h, --help
          显示帮助
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本
```

### `morphz execution`

检查和控制持久化物理执行任务

```text
检查和控制持久化物理执行任务

用法：morphz execution [OPTIONS] [COMMAND]

命令：
  list
          列出物理执行任务
  show
          查看一个物理执行任务
  output
          读取一个任务持久化的标准输出和错误输出
  cancel
          请求取消一个物理执行任务
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -h, --help
          显示帮助
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本
```

### `morphz setup`

打开模型服务商配置向导

```text
启动内置控制台并直接进入模型服务商配置向导。在 SSH 或没有浏览器的环境中，使用 --tui 启动全屏终端向导。

用法：morphz setup [OPTIONS]

选项：
      --bind <ADDR>
          控制台监听地址

  -C, --cwd <DIR>
          在加载配置前更改工作目录

      --config-file <FILE>
          加载指定的可信配置文件

      --no-open
          只输出配置向导地址，不打开浏览器

  -h, --help
          显示帮助

  -p, --profile <NAME>
          加载具名配置方案

      --provider <ID>
          覆盖已配置的模型服务商

  -m, --model <MODEL>
          覆盖已配置的模型

      --reasoning-effort <LEVEL>
          设置模型推理强度

      --agent <ID>
          选择智能体

      --context <ID>
          选择或挂载认知上下文

      --session <ID>
          重新连接现有会话

      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本

  -s, --sandbox <MODE>
          设置命令沙箱模式

  -a, --approval <MODE>
          设置权限审批策略

      --add-dir <DIR>
          添加额外的可读写工作区目录

      --network[=<BOOL>]
          允许沙箱命令访问网络

  -c, --set <KEY=VALUE>
          覆盖单个配置值

      --log-level <FILTER>
          覆盖日志过滤器

      --theme <THEME>
          选择终端界面颜色主题

      --language <LANGUAGE>
          选择用户界面语言

      --format <FORMAT>
          选择管理命令输出格式

      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能

      --tui
          强制使用全屏终端界面

      --plain
          使用经典行式终端

  -V, --version
          显示版本

示例：
  morphz setup
  morphz setup --tui
  morphz setup --no-open --bind=127.0.0.1:9090
```

### `morphz provider`

检查并验证模型服务商

```text
检查并验证模型服务商

用法：morphz provider [OPTIONS] [COMMAND]

命令：
  list
          列出目录和已配置的模型服务商
  test
          验证模型服务商的目录、流式响应和工具调用
  show
          查看一个有效模型服务实例
  set
          校验并保存模型服务实例 TOML 文件
  account
          管理模型服务认证账号
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
  -h, --help
          显示帮助
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz provider <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz model`

发现或选择模型

```text
发现或选择模型

用法：morphz model [OPTIONS] [COMMAND]

命令：
  list
          列出模型服务商提供的模型
  use
          保存默认模型服务商和模型
  refresh
          刷新并验证一个模型路由的远端目录
  route
          管理逻辑模型路由
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -h, --help
          显示帮助
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz model <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz profile`

检查或选择配置方案

```text
检查或选择配置方案

用法：morphz profile [OPTIONS] [COMMAND]

命令：
  list
          列出可用的配置方案
  show
          显示配置方案的解析结果
  use
          选择默认配置方案
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
  -h, --help
          显示帮助
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz profile <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz context`

检查持久认知上下文

```text
检查持久认知上下文

用法：morphz context [OPTIONS] [COMMAND]

命令：
  list
          列出认知上下文
  show
          显示一个认知上下文
  status
          显示上下文状态、会话和活跃工作
  audit
          通过事件回放验证上下文的认知投影
  recall-index
          检查或重建派生的词法召回索引
  recall
          搜索上下文记忆或遍历一个认知帧的血缘
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
  -h, --help
          显示帮助
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz context <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz scheduler`

检查权威调度器状态

```text
检查权威调度器状态

用法：morphz scheduler [OPTIONS] [COMMAND]

命令：
  show
          显示线程、求值、作业、审批和调度计划
  thread
          检查和控制一条持久线程
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -h, --help
          显示帮助
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz scheduler <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz session`

管理上下文中的会话

```text
管理上下文中的会话

用法：morphz session [OPTIONS] [COMMAND]

命令：
  list
          列出会话
  show
          显示一个会话
  create
          在指定上下文中创建会话
  resume
          重新连接现有或最近活跃的会话
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -h, --help
          显示帮助
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz session <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz agent`

管理持久智能体

```text
管理持久智能体

用法：morphz agent [OPTIONS] [COMMAND]

命令：
  list
          列出智能体
  show
          显示一个智能体
  create
          创建带根上下文和初始会话的智能体
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
  -h, --help
          显示帮助
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz agent <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz harness`

安装和查看版本化领域程序包

```text
安装和查看版本化领域程序包

用法：morphz harness [OPTIONS] [COMMAND]

命令：
  list
          列出已安装的领域程序包版本
  show
          显示一个已安装领域程序包的精确版本
  install
          校验并安装 .hns 文件或目录
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
  -h, --help
          显示帮助
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz harness <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz objective`

管理长期目标

```text
管理长期目标

用法：morphz objective [OPTIONS] [COMMAND]

命令：
  list
          列出上下文中的目标
  show
          显示一个目标
  create
          创建并运行长期目标
  edit
          使用修订隔离替换目标内容
  pause
          暂停目标
  resume
          继续目标
  cancel
          取消目标
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
  -h, --help
          显示帮助
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz objective <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz trajectory`

导出和校验可移植的智能体执行轨迹包

```text
导出和校验可移植的智能体执行轨迹包

用法：morphz trajectory [OPTIONS] [COMMAND]

命令：
  export
          将运行时权威事实导出为智能体执行轨迹包
  verify
          校验不可信的智能体执行轨迹包
  episode
          派生经过权限校验的训练片段
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
  -h, --help
          显示帮助
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本
```

### `morphz storage`

检查并迁移运行时存储权威

```text
检查并迁移运行时存储权威

用法：morphz storage [OPTIONS] [COMMAND]

命令：
  migrate-cognitive-store
          将认知状态显式同步到选定存储引擎
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -h, --help
          显示帮助
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行时启动不会隐式迁移认知状态。
```

### `morphz experiment`

检查并验证显式门控的实验功能

```text
检查并验证显式门控的实验功能

用法：morphz experiment [OPTIONS] [COMMAND]

命令：
  list
          列出实验功能的编译与启用状态
  check
          确认一个实验功能已经编译并启用
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -h, --help
          显示帮助
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

实验功能默认关闭，不提供稳定性承诺。
```

### `morphz job`

检查或取消子智能体委派

```text
检查或取消子智能体委派

用法：morphz job [OPTIONS] [COMMAND]

命令：
  list
          列出子智能体委派
  cancel
          取消子智能体委派及其后代
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -h, --help
          显示帮助
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz job <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz config`

检查解析后的配置及其来源

```text
检查解析后的配置及其来源

用法：morphz config [OPTIONS] [COMMAND]

命令：
  show
          输出解析后的配置
  check
          验证所有已加载的配置层
  path
          按优先级列出已加载的配置文件
  explain
          说明每个解析值的来源
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -h, --help
          显示帮助
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

运行 `morphz config <COMMAND> --help` 查看具体命令的帮助。
```

### `morphz update`

从经过校验的 GitHub Release 更新 Morphz

```text
从经过校验的 GitHub Release 更新 Morphz

用法：morphz update [OPTIONS] [COMMAND]

命令：
  status
          检查最新发行版本，不修改任何文件
  rollback
          恢复上次更新保留的旧版本
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
      --to <VERSION>
          安装指定的已发布版本，而不是最新版本
      --allow-downgrade
          允许 --to 安装较旧的发行版本
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -h, --help
          显示帮助
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

示例：
  morphz update status
  morphz update
  morphz update --to 0.2.0
  morphz update rollback
```

### `morphz doctor`

检查存储、工作区、权限和模型服务商配置

```text
检查存储、工作区、权限和模型服务商配置

用法：morphz doctor [OPTIONS]

选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
  -h, --help
          显示帮助
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

示例：
  morphz doctor
```

### `morphz completion`

生成命令行补全定义

```text
生成命令行补全定义

用法：morphz completion [OPTIONS] <SHELL>

参数：
  <SHELL>
          要生成补全定义的命令行环境
选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
  -h, --help
          显示帮助
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

示例：
  morphz completion zsh > ~/.zfunc/_morphz
```

### `morphz version`

显示 Morphz 版本

```text
显示 Morphz 版本

用法：morphz version [OPTIONS]

选项：
  -C, --cwd <DIR>
          在加载配置前更改工作目录
  -h, --help
          显示帮助
      --config-file <FILE>
          加载指定的可信配置文件
  -p, --profile <NAME>
          加载具名配置方案
      --provider <ID>
          覆盖已配置的模型服务商
  -m, --model <MODEL>
          覆盖已配置的模型
      --reasoning-effort <LEVEL>
          设置模型推理强度
      --agent <ID>
          选择智能体
      --context <ID>
          选择或挂载认知上下文
      --session <ID>
          重新连接现有会话
      --harness <ID@VERSION>
          为首次求值选择已安装领域程序包的精确版本
  -s, --sandbox <MODE>
          设置命令沙箱模式
  -a, --approval <MODE>
          设置权限审批策略
      --add-dir <DIR>
          添加额外的可读写工作区目录
      --network[=<BOOL>]
          允许沙箱命令访问网络
  -c, --set <KEY=VALUE>
          覆盖单个配置值
      --log-level <FILTER>
          覆盖日志过滤器
      --theme <THEME>
          选择终端界面颜色主题
      --language <LANGUAGE>
          选择用户界面语言
      --format <FORMAT>
          选择管理命令输出格式
      --enable-experimental <FEATURE>
          为当前进程启用一个已编译的实验功能
      --tui
          强制使用全屏终端界面
      --plain
          使用经典行式终端
  -V, --version
          显示版本

示例：
  morphz version
```

## 查看更深层帮助

每个子命令的参数仍以当前二进制为准。使用 `morphz help <COMMAND>` 或在任意命令路径后添加 `--help`。自动化应使用 `--format=json` 和稳定 ID，不要解析面向人的表格或翻译文本。
