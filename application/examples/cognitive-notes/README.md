# 独立认知笔记 Service

实验 headless 示例，Node >=24.13.0；作者进程和数据库独立，只有打包后的
`@morphz/cognitive-app-sdk@0.1.0` 依赖。无 GUI、Host 内部模块或 Runtime 依赖。
实际跨 Host/Human/Agent、生产 TLS 和原 App 验收不由此示例测试替代。
当前实际验证运行时为 Node 25.8.1；声明的最低 Node 版本尚未单独验证。

先在 SDK 包目录 `npm install && npm pack`，将 tarball 带到独立作者目录，
再安装 `npm install /absolute/path/morphz-cognitive-app-sdk-0.1.0.tgz`。
有完整缓存可用 `--offline`；包尚未发布，不能直接假设公网 npm 可安装。
把此目录复制到独立项目即可，不复制 Morphz Host/UI/Platform 代码。

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
