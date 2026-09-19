# 本机中心与身份接入

当前源码位于 Morphz 主仓库 `application/`；下文 npm 命令在该目录执行。Desktop 默认内嵌应用业务层，Web／显式远端连接才使用应用 HTTP 服务。Runtime 是独立模块，两种接入都不能绕过身份与数据边界。本文件不提供公网部署；本机测试监听保持 loopback，不通过代理或端口转发公开暴露。

## 单用户入口

全新安装构建后运行 `npm run desktop`，在桌面进程内直接打开应用 SQLite 和已构建界面，不先启动应用 HTTP 服务或 Vite。Runtime 连接见[应用 README](../README.md#本机-runtime-连接)。应用数据不写入源码目录，也不复用 Runtime 数据库。

已有安装继续使用原 Morphz.app、数据目录、profile、环境文件引用和 Runtime 配置；不得为了源码迁移建立新中心、搬移旧数据或重新发送输入。`MORPHZ_APP_DATA_DIR`／`--data-dir=` 显式选择本机数据目录，`MORPHZ_APP_PROFILE` 选择桌面 profile。

Web 开发或远端适配测试才使用 `npm start`，由 `MORPHZ_APP_PORT` 控制 HTTP 端口（默认 65420）；独立测试应显式选择新的绝对数据目录和空闲端口。下面命令连接一个已经启动的指定服务，不打开本机应用数据库：

```sh
npm run desktop -- --center=http://127.0.0.1:65422
```

当前桌面的 HTTP 连接只接受明确的数字 loopback 地址；只有这个显式模式要求先启动 HTTP 服务，无参数的正常桌面不会默认连接 65420。不要让 HTTP 宿主与内嵌 Desktop 同时写同一应用数据库，不得为了换中心修改既有 Runtime 地址、namespace 或身份模式。

### 显式开发热更新与隔离 Runtime

`npm run dev:center -- --source-center=<原中心私有数据目录> --data-dir=<新开发数据目录> --model-key-file=<私有环境文件绝对路径> --model-key-name=<指定的模型密钥变量名> --desktop` 是专门的隔离开发工具：启动独立 Runtime（18089）、应用 HTTP 宿主（65424）及带 Vite 热更新的桌面，不是现有安装的日常启动／升级方式。先在本仓库构建应用及 `experimental-session-io` Runtime；脚本通过 `scripts/runtime-path.mjs` 找到仓库根目录的 `target/debug/morphz`，也可用 `MORPHZ_APP_RUNTIME_BINARY` 显式选择测试二进制。

已有中心无需重新运行这个启动器：先正常退出旧桌面，再以原 `MORPHZ_APP_PROFILE` 执行 `npm run desktop:dev -- --center=http://127.0.0.1:65424` 即可。该命令只管理 Vite 和桌面客户端，关闭桌面不停止中心。65419 必须空闲，不能与 Web 开发或既有桌面测试同时使用。

热更新只在非打包开发壳显式启用：渲染器使用 65419，Vite 将 `/api` 代理到指定中心，保留服务端原有 Origin 与 CSRF 校验，不拦截 Electron 的 HTTP 协议。原生来源与网站分区仍绑定实际中心，不随渲染地址改变。首次连接复制同中心、同身份的偏好与草稿，不覆盖目标已有值，不复制待执行命令。CSS／React 自动更新；主进程与 preload 需要正常退出重开，服务端需单独更新。前端非组件模块的变化仍可能触发整页刷新。

启动器只读取原中心当前选定的单一 API Key 模型路由，不复制其数据库、会话、协调网络、OAuth 账号或全部环境变量。只将指定的模型 Key 注入新 Runtime，豆包 Key 仍由应用宿主独立加载，Electron 不继承两者。默认要求模型端点为 HTTPS；如果原模型已使用可信本机／局域网 HTTP 代理，需要显式添加 `--allow-http-model`，不会自动降级端点。

新目录会记录中心配置和命名空间，后续运行保持数据与桌面配置；已有目录标记不匹配、端口被占用或模型路由不受支持时直接拒绝，不覆盖旧中心或停止占端口的进程。Runtime 首次运行将模型配置拆分到独立文件，启动器保留这些文件并检查实际生效模型，不把正常迁移当作配置损坏。关闭桌面不关闭中心；停止启动器会正常结束它创建的服务，已打开的桌面会显示断线，可从应用菜单正常退出。此入口是隔离开发环境，不是把旧中心迁移到新版，也不是公开部署命令。

## 团队模拟中心

在一个**新建的独立中心**私有数据目录中配置 `members.json`，权限为 0600，不放入仓库。结构如下，示例中的占位符必须替换：

```json
{
  "version": 1,
  "members": [
    {
      "principalId": "alice",
      "actantId": "alice-human",
      "name": "Alice",
      "projectIds": ["first-project"],
      "enabled": true,
      "loginTokenHash": "<个人连接凭据的 SHA-256，64 位小写十六进制>"
    }
  ]
}
```

个人连接凭据应为随机 32 字节编码成的 64 位小写十六进制字符串，不是密码。每个人使用不同凭据、Principal 和 Actant。通过私密渠道交给对应成员，登录页输入明文凭据；配置只存其 SHA-256。不要把它输出到共享日志、提交到仓库或发给模型。

配置给出的项目必须已存在。新中心默认有 `first-project`。成员配置由管理员在本机维护，目前没有邀请与成员管理 UI。修改后向**对应中心进程**发送 SIGHUP 重新加载；无效配置会保留旧配置并报告失败。撤销成员应设 `enabled: false`。启用认证后若身份文件丢失，中心重启会拒绝启动，不会回退到单用户模式；恢复有效的私有配置后再启动。

登录 Cookie 是 HttpOnly／SameSite，认证与 CSRF 在服务端检查，明文凭据不放 localStorage。共享项目里的输入、对象、事项和认知对项目成员共享；每条项目对话使用独立 Session，同项目共享 Context，不同私有项目分开 Context。对话的消息分组不是权限隔离，不能把同一共享项目里的对话当作私聊空间。侧栏固定“对话”则是每个 Human 自己的个人空间。

## Runtime 可信网关

团队应用宿主必须配套启用 Runtime 的 `trusted-gateway` 身份模式，不能把单用户 Dashboard token 当作团队身份。

Runtime 的宿主配置包含：

```toml
[server.identity]
mode = "trusted-gateway"
provider_id = "morphz-application"
service_token_env = "MORPHZ_APP_GATEWAY_TOKEN"
```

以上 `provider_id` 是全新测试部署的示例。既有部署的身份提供方 ID（包括旧 `morphzwork`）是持久身份的一部分，必须保持，不随产品改名迁移。网关令牌通过宿主环境提供。应用宿主私有 `runtime.json` 的结构为：

```json
{
  "url": "http://127.0.0.1:<Runtime端口>",
  "token": "<同一个私有网关令牌>",
  "namespace": "<此中心专用 UUID>",
  "identityMode": "trusted_gateway"
}
```

两个配置的身份模式拼写不同，分别遵循 Runtime TOML 和应用 JSON。应用生成并持久化中心 UUID，原生会话与目录授权绑定该中心。不要复制正在使用的中心配置来假装创建了一个新中心。

已配置 Runtime 的 Desktop 内嵌宿主生成私有 `host-tools-desktop.json`，通过本地 Unix socket 回调；Web HTTP 宿主使用 `host-tools.json`。Runtime 开发构建启动时以 `MORPHZ_HOST_TOOLS_FILE` 指向相应清单的绝对路径，界面刷新不会重新加载它。单用户绑定精确 Context；团队绑定该中心独有、带分隔符的 Context 命名空间，应用还会校验真实 Session、项目成员及身份撤销状态。模型不能修改注册清单或扩展项目范围。

工具注册可通过 `idempotent_requests` 声明可安全重放的具体操作：每条规则是 JSON Pointer
到字符串的精确匹配，规则内部为 AND，多条规则为 OR。它只存在于私有注册清单，
不是模型参数或通用重试开关；未声明操作默认仍为 `AtMostOnce`。当前应用只声明
`script/read-workflow` 与 `script/submit-workflow`，后者由原 job/call 派生的稳定命令 ID、
内容指纹和持久回执保证幂等；重放仍检查原输入及当前权限，不升级历史任务已固定的重试策略。
新 Host 清单需要配套支持此字段的 Runtime，升级时须正常重启两端，保留 token、Context、
数据目录与 Harness 原始字节。`serve` 先开放认证接口，再启动恢复工作器，避免 Host 回查
执行身份时接口尚不可用；本机已退出进程和租约过期的恢复均保留版本 CAS 与副作用边界。

`members.json`、`runtime.json` 和两类 Host 工具清单都是私有控制配置，不属于内容或附件；不要把包含它们的数据目录授权给 Agent 作普通资料。应用不会从项目文档接受这些配置。

## 可重复验证

```sh
npm run build
npm test
npm run test:e2e
npm run test:runtime-tools
npm run test:runtime-identity
```

Runtime 测试先在本仓库根目录执行 `cargo build --locked -p morphz --bin morphz --features experimental-session-io`，再从 `application/` 执行上述联测。测试创建自己的配置、模型替身、数据目录与凭据，不依赖旧相邻仓库，也不读取个人 Runtime 数据库。它验证真实执行与身份路由，但不证明第三方模型质量或桌面原生权限已通过。

真实 Electron 的 `test:desktop` 与 `test:browser` 需要已解锁 macOS 桌面和空闲 65419 测试端口。`test:desktop-hmr` 另需空闲 65426，在临时源码副本上实际修改 CSS 和 React，验证不刷新、不丢草稿、原生 IPC 和对象保存；不修改用户源文件或向模型发消息。操作只针对隔离合成资料／网站，不执行真实外部发布。
