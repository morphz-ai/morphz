# 独立认知笔记 Service

独立作者示例，Node >=24.13.0；作者进程和数据库独立，唯一运行依赖为公开
`@morphz/cognitive-app-sdk@0.2.0`。默认仍是 headless 1.0.0；可显式构建并启用
1.1.0 可选界面。没有 Host 内部模块或 Runtime 依赖。
实际跨 Host/Human/Agent、生产 TLS 和原 App 验收不由此示例测试替代。
当前实际验证运行时为 Node 25.8.1；声明的最低 Node 版本尚未单独验证。

宿主侧流程见[第三方接入 quickstart](https://github.com/morphz-ai/morphz/blob/main/application/docs/42-third-party-cognitive-app-contract.md#接入-quickstart)，
SDK 的公开入口与生命周期见[作者 SDK](https://github.com/morphz-ai/morphz/blob/main/application/packages/cognitive-app-sdk/README.md)。
这些仓库链接不是作者包内文件；若远端尚未包含本地阶段提交，以同一源码
版本的对应文档为准。此示例只提供独立作者 Service／可选 GUI，不复制宿主
目录或权限。Human 明确安装精确定义、同意数据访问权限并连接自己的保存方；
Agent 无需界面，经原输入／后台来源使用相同领域接口，不能安装或自报身份。

先在 SDK 包目录 `npm install && npm pack`，将 tarball 带到独立作者目录，
再安装 `npm install /absolute/path/morphz-cognitive-app-sdk-0.2.0.tgz`。
有完整缓存可用 `--offline`；包尚未发布，不能直接假设公网 npm 可安装。
把此目录复制到独立项目即可，不复制 Morphz Host/UI/Platform 代码。

## 可选作者界面

在独立作者目录安装依赖后，执行：

```sh
npm run build:gui
```

构建工具只有固定 `esbuild@0.28.2` 开发依赖。界面只导入公开 Browser SDK，
生成自包含原始 HTML（最多 1,000,000 UTF-8 字节），不依赖 CDN、宿主组件、
外部脚本或作者网络请求。可从此目录 `npm pack --ignore-scripts` 打包源代码；
先构建再打包则同时包含构建结果。安装到仓库外也能重新构建，不要求 workspace。

生成物：

- `dist/notes.html`：作者 HTML 原字节。
- `dist/definition.gui.json`：固定 1.1.0，`ui.packageVersion` 同为 1.1.0；SHA-256
  精确绑定这份 HTML。除了 version/ui，领域操作及元数据与旧定义完全相同。
- `dist/install.gui.json`：`{definition, manifest}` 安装载体。manifest 仅申请
  `input.compose`，没有原件读写、任意网络或宿主代码执行权限。

旧 `definition.json` 1.0.0 原字节不修改。构建完成不会自动注册新定义、安装 GUI、
绑定项目、设置连接或开放旧应用授权。安装必须由获权 Human 通过宿主现有安装
接口显式提交，并在请求时提供自己生成的原始 commandId；载体不内置命令 ID。
需要支持 SDK 0.2.0 固定 Document facade 的宿主；单独双击 HTML 不连接服务。

作者服务默认不支持 1.1.0。只在操作者明确启用时读取固定路径的 GUI 定义：

```sh
node service.mjs --db /absolute/private-author-data/notes.sqlite --config /absolute/private-author-data/bootstrap.json --port 65432 --gui
```

此模式兼容原 1.0.0，并在同一 schema/事务中追加精确 1.1.0 定义；不迁移原文、
不换 dataAuthority、不重设 ACL、不改旧 hash。同版换 GUI 字节需要另一个新版本，
不能覆写已保存的精确定义。没有 `--gui` 的冷重启保留已保存的 1.1.0 事实，但不
从数据库动态启用它。任意请求、路径或数据库 Schema 都不能添加运行时操作。

界面首次连接只接收 context，不自动列目录或调用业务。刷新、下一页、读取、
保存、查询状态、恢复回执、打开原文、引用协作和记住位置均由明确点击触发。
阅读使用原件/版本的 opaque 字符串，不猜测序号、不回退 latest；引用只提交
精确引用与协作提示，不复制笔记正文，也不自动发送输入。

编辑只在当前 Document 内存中；切换会询问是否放弃未保存草稿。宿主导航状态
只保存阅读位置，不保存正文、编辑或命令 ID。结果不明时锁住原草稿、展示原
commandId，提供状态/回执查询，不自动重试或生成新命令。关闭窗口前应妥善保存
编辑及原命令 ID；此示例不是跨窗口草稿同步或命令恢复管理器。

打开原文可立即离开并销毁作者 Document。按钮先确认脏编辑；保存或确认
放弃必须在调用前完成。成功后的状态提示仅供仍存活的源界面反馈，不作为
必要保存步骤；没收到回应不证明导航未发生，不自动重试或重放写命令。

作者包测试证明独立离线安装/构建、原字节绑定及作者 SQLite 双版本兼容。
受控浏览器机制测试不代替真实 SQL/Service/HPA 的跨宿主 GUI 集成。后续生产
接入已另验：完整 Web／独立作者／公开 SDK／真实 HPA／SQLite＋PostgreSQL
4/4；实际 Electron Remote 的 SQLite＋PostgreSQL、embedded Local 的 SQLite
及资源门组成当前原生 20/20、零跳过。原件终结导航、引用准备未发送草稿、
原回执恢复、同 Document 保存与关闭退休均有实际证据。真实 Rust input／
后台事项／infer 另分层验收，不把作者包或受控模型算作原 App／付费模型。
当前范围与原失败见[最新交付与剩余](https://github.com/morphz-ai/morphz/blob/main/application/docs/42-third-party-cognitive-app-contract.md#最新交付与剩余)。
用户原 App 已沿原 bundle／profile／中心重开并显示完整 UI，Runtime 未停止，
原库差异另有逐字段复核；全部逻辑草稿／窗口交互验收仍在核查，不由隔离
作者测试替代。没有自动接通用户真实第三方账户，也未验收公网 TLS、应用
市场、OAuth、签名发行或公开 npm 发布。

## 作者服务与账户映射

准备只属于作者的私有数据目录及 0600 bootstrap JSON，例如：

```json
{
  "format": "cognitive-notes-bootstrap/v1",
  "integrations": [
    {
      "credentialSha256": "替换为专用高熵随机 token 的实际 SHA-256，不是 token 明文",
      "issuer": "operator-approved-host",
      "tenantId": "tenant",
      "principalId": "alice",
      "humanActantId": "human_alice",
      "agentActantIds": ["agent"],
      "projects": [{ "projectId": "project_one", "read": true, "write": true }]
    }
  ]
}
```

这些是占位身份，必须换成实际账户映射，不能借示例值自报为任意用户。
专用 token 使用至少 32 随机字节的 base64url；只将 SHA 放入 bootstrap，
明文仅交给获准集成连接。服务不加载用户的其他凭据。启动：

```sh
node service.mjs --db /absolute/private-author-data/notes.sqlite --config /absolute/private-author-data/bootstrap.json --port 65432
```

端口 0 可由测试/操作者选择可用端口，启动输出只有公开协议身份和实际端口。
仅监听 numeric 127.0.0.1 HTTP；这是明确批准的本机链路，不是生产 TLS 认证。
生产服务应通过操作者配置的 HTTPS origin 暴露同一四个根路由，不在 manifest
放地址、密钥或网络权限。此示例没有配置反向代理或证书自动化。

四条 POST JSON 路由 `/describe`、`/invoke`、`/objects/read`、`/receipts/read`
均须专用 Bearer。声明包含 notes.list(project read)、notes.create(project write)、
notes.revise(objects write)。修订须一项显式原件/当前精确基线，参数引用必须相同。
读取旧版本返回旧原文，不回退 latest。list 最大 32，更多时给 nextAfterObjectId；
没有更多时该可选字段省略。

JSON 接受不带参数或显式 UTF-8 charset 的 application/json；不接受其他
charset、额外参数或 Content-Encoding。宿主的实际 UTF-8 请求头已单独覆盖。

作者重新计算真实 semantic SHA，完整绑定与命令回执持久化。同 command 不同
内容/来源/实例冲突；同 command/hash 回放同一事实，无第二次写。rejected 只证明
该作者业务规则确知未提交；403、断连、过期和 not_seen 不等于 rejected。
限制为 512KiB wire、8KiB headers、10s绝对处理 deadline；不压缩、不重定向，
正文使用 fatal UTF-8 解码，安全错误不回显 SQL、请求、token 或配置。

[数据模型](./MODEL.md)说明所有权、FK、事务、版本与 ACL。停止服务后备份完整
作者数据库；在线备份须采用 SQLite 一致性备份工具，不能只复制正在写的主文件
而忽略 WAL。不要将 Morphz center 数据库当作此示例的存储。
