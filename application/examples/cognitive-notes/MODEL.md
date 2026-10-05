# 作者笔记服务的数据模型

这是独立作者 Service 的自管 SQLite 模型，不是 Morphz Platform schema。
首次空库初始化 schema v1；非空未知版本或损坏元数据拒绝启动，不清空重建。
SQLite 启用外键、WAL、FULL 同步；每次变更使用 `BEGIN IMMEDIATE`，不在事务内
等待网络。备份与恢复由作者负责，Morphz 备份不包含此库。

| 表                    | 权威、身份与关系                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| metadata              | 单例 schema/app/service/dataAuthority；新库随机 authority 持久保存，重启不换；换库不能复用旧保存方                          |
| author_definitions    | 精确 version PK、canonical definition/SHA；不可变。仅代码静态 supported Map 中的声明可处理请求，DB 任意旧字节不成为执行代码 |
| integrations          | 专用 credential SHA → issuer/tenant/principal/Human actant、active；不保存明文 token                                        |
| allowed_agent_actants | integration 的允许 Agent actant；不把任意自报 Agent 当真                                                                    |
| projects/project_acl  | 作者认可的 tenant/project 与本人读写权限，write 要求 read；不复制 Morphz 全项目或目录                                       |
| notes                 | opaque object ID、tenant/project、creator、当前版本；项目不能从参数或修订偷偷更换                                           |
| note_versions         | object/version PK、title、JSON 原文、时间；禁止 UPDATE/DELETE；当前版本关系为 deferred FK                                   |
| author_commands       | tenant/command PK、semantic hash、完整固定绑定、terminal receipt JSON/SHA；业务版本与回执一次提交，禁止 UPDATE/DELETE       |

metadata 不绑定单一应用版本。代码可在明确支持旧接口的前提下追加新精确定义；
同版本不能改变 hash，也不从 DB 读取任意 Schema 来执行。当前只实现 headless
1.0.0，未提供 GUI、版本升级管理或删除／迁移原件 API。

只有本地同步笔记事务，没有外部 execute 效果。因此 author_commands 只在同一
原子事务内提交 committed/rejected 终态，无独立对外可见 admitted 中间行。
HTTP 超时或断响应不撤销已提交事实；未见回执仅返回 unknown/not_seen，不宣称
没有旧请求在途。当前 project ACL 或凭据拒绝只产生安全 HTTP 错误，不覆盖旧回执。

作者凭据只信任配置映射的 issuer/tenant/principal/Human 和 Agent 白名单。
Input/task-run IDs 仍来自已认证 Host 声明：示例不独立连接 Runtime 核验来源。
instanceId 是该受认证 Host 的有界关系标签，命令固定后必须精确匹配；不作为
作者权限，也不允许跨本地 dataAuthority。账户及项目 ACL 在事务内重新检查。

正文保存为 JSON carrier，保留 NUL、未配对 surrogate 等合法业务 JSON 字符串。
SQL raw 身份/展示元数据拒绝这些不可移植文本，不修剪/规范化合法 Unicode。
标题还须满足回执元数据的非空、最多 180 UTF-16 单元约束；Schema 的码点上限
不是保证每份输入都通过作者领域规则。基线不符时真实持久 rejected，原件不变。

首次 bootstrap 显式建立凭据 hash 与 ACL，冷重启不重新 seed、不恢复已停用许可。
后续账户管理需作者运维或新增经设计的管理接口，当前四条业务路由不能管理 ACL。
