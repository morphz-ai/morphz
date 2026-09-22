import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import { scriptStudioApplication } from "../../core/src/applications.js";
import { scriptCommandSchema } from "../../core/src/script-studio.js";
import { scriptToolSchema } from "./script-studio-tools.js";
import { bookmarkRequestSchema } from "../../core/src/bookmarks.js";

export const operationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("list"),
      domain: z.string().max(100).optional(),
      query: z.string().max(200).default(""),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  z
    .object({ action: z.literal("describe"), operationId: z.string().max(100) })
    .strict(),
  z
    .object({
      action: z.literal("invoke"),
      operationId: z.string().max(100),
      parameters: z.unknown(),
    })
    .strict(),
]);

type Effect = "read" | "write" | "execute";
type Definition = {
  id: string;
  domain: string;
  title: string;
  effect: Effect;
  parameters: z.ZodObject;
  request: (parameters: Record<string, unknown>) => Record<string, unknown>;
};

/** Discovery is an adapter over the existing, authorized domain commands, not
 * another dispatcher, workflow engine, or authority supplied by the model.
 * Parameter constraints are the same Zod instances used by those commands.
 */
export function applicationOperations(shape: Record<string, z.ZodType>) {
  const definitions: Definition[] = [];
  const add = (
    id: string,
    title: string,
    effect: Effect,
    parameters: z.ZodObject,
    request: Definition["request"],
  ) =>
    definitions.push({
      id,
      domain: id.split(".")[0]!,
      title,
      effect,
      parameters,
      request,
    });
  const fields = (required: string, optional = "", source = shape) => {
    const result: Record<string, z.ZodType> = {};
    for (const key of optional.split(" ").filter(Boolean))
      result[key] = source[key]!;
    for (const key of required.split(" ").filter(Boolean)) {
      const field = source[key]!;
      result[key] = field.nonoptional();
    }
    return z.object(result).strict();
  };
  const simple = (
    id: string,
    title: string,
    effect: Effect,
    action: string,
    required = "",
    optional = "",
  ) =>
    add(id, title, effect, fields(required, optional), (params) => ({
      action,
      ...params,
    }));
  const withoutAction = (schema: z.ZodObject) => schema.omit({ action: true });

  simple(
    "input.read",
    "读取本次真实输入及附件、选择线索",
    "read",
    "read-input",
  );
  simple(
    "connection.status",
    "检查连接和模型配置，不修改凭据",
    "read",
    "connection-status",
  );
  simple(
    "content.list",
    "列出内容与确切版本",
    "read",
    "list",
    "",
    "contentOnly sort offset limit",
  );
  simple(
    "content.search",
    "检索可检索的成果",
    "read",
    "search",
    "query",
    "offset limit",
  );
  simple(
    "content.read",
    "读取对象或其历史版本、分页正文",
    "read",
    "read",
    "artifactId",
    "revision page offset rowOffset limit",
  );
  simple(
    "content.create-document",
    "保存文档、报告或 Markdown 表格",
    "write",
    "create-document",
    "title markdown",
  );
  simple(
    "content.revise-document",
    "修改文档，保留版本历史",
    "write",
    "revise-document",
    "artifactId revision title markdown",
  );
  simple(
    "content.organize",
    "重命名、归入项目或新建项目并归入",
    "write",
    "organize-content",
    "content revision metadata",
  );
  simple(
    "content.link",
    "关联两个对象",
    "write",
    "link",
    "artifactId toId relation",
  );
  simple(
    "content.annotate",
    "对确切版本添加批注",
    "write",
    "annotate",
    "artifactId revision quote body",
    "page",
  );
  simple(
    "table.create",
    "创建持续维护的交互数据表",
    "write",
    "create-interactive",
    "title interactive",
  );
  simple(
    "table.revise",
    "修改数据表，保留行列 ID",
    "write",
    "revise-interactive",
    "artifactId revision title interactive",
  );
  simple(
    "tasks.list",
    "读取事项、可见顺序及顺序版本",
    "read",
    "list-tasks",
    "",
    "offset limit",
  );
  simple(
    "tasks.create",
    "创建事项，不默认启动执行",
    "write",
    "create-task",
    "title task",
  );
  simple(
    "tasks.revise",
    "修改事项",
    "write",
    "revise-task",
    "artifactId revision title task",
  );
  simple(
    "tasks.reorder",
    "调整事项优先顺序",
    "write",
    "reorder-tasks",
    "taskIds orderRevision",
  );
  simple(
    "tasks.arrange",
    "设置负责人、截止日期及项目",
    "write",
    "arrange-task",
    "artifactId revision changes",
  );
  simple(
    "tasks.start",
    "请求执行事项",
    "execute",
    "start-task",
    "artifactId revision",
  );
  simple(
    "tasks.cancel",
    "取消未启动事项",
    "write",
    "cancel-task",
    "artifactId revision",
  );
  simple(
    "tasks.status",
    "检查实际执行、依赖和成果",
    "read",
    "task-status",
    "artifactId",
  );
  simple(
    "tasks.control",
    "暂停、恢复或停止实际执行",
    "execute",
    "control-task",
    "artifactId control",
  );
  simple(
    "tasks.finish",
    "用已保存成果交付自己负责的事项",
    "write",
    "finish-task",
    "artifactId revision resultIds",
  );
  simple(
    "applications.list",
    "发现已安装认知应用和 Harness",
    "read",
    "list-applications",
  );
  simple(
    "applications.open",
    "打开应用或精确内容入口，不启动工作流",
    "write",
    "launch-application",
    "applicationId applicationVersion",
    "scriptTarget",
  );
  simple(
    "files.read",
    "读取本次用户授权的本地文件",
    "read",
    "local-file",
    "",
    "path offset limit",
  );
  simple(
    "files.directory",
    "访问本次授权目录，写入需确切版本",
    "write",
    "directory",
    "directory",
  );
  simple(
    "browser.control",
    "读取或操作已授权网页，点击仍须用户确认",
    "execute",
    "browser",
    "browser",
  );

  const management = (shape.management as z.ZodOptional<z.ZodObject>).unwrap()
    .shape;
  for (const domain of ["projects", "conversations"] as const) {
    const target = domain === "projects" ? "projectId" : "conversationId";
    for (const [action, label] of Object.entries({
      list: "查找",
      create: "创建",
      rename: "重命名",
      archive: "归档",
      restore: "恢复",
      delete: "移入回收站",
    })) {
      if (domain === "conversations" && ["create", "delete"].includes(action))
        continue;
      add(
        `${domain}.${action}`,
        `${label}${domain === "projects" ? "项目" : "会话"}`,
        action === "list" ? "read" : "write",
        action === "list"
          ? fields("", "status query offset limit projectId", management)
          : action === "create"
            ? fields("title", "", management)
            : fields(
                `${target} revision${action === "rename" ? " title" : ""}`,
                "",
                management,
              ),
        (params) => ({ action: domain, management: { action, ...params } }),
      );
    }
  }
  for (const schema of bookmarkRequestSchema.options) {
    const action = schema.shape.action.value;
    add(
      `bookmarks.${action}`,
      {
        list: "查找浏览器收藏",
        add: "收藏网址",
        update: "修改收藏",
        remove: "移除收藏",
        restore: "恢复收藏",
      }[action],
      action === "list" ? "read" : "write",
      withoutAction(schema),
      (params) => ({ action: "bookmarks", bookmarks: { action, ...params } }),
    );
  }
  for (const schema of scriptToolSchema.options) {
    const action = schema.shape.action.value;
    if (action === "command") {
      for (const command of scriptCommandSchema.options) {
        const name = command.shape.action.value;
        const labels: Record<string, string> = {
          "create-production": "创建空剧本",
          "create-item": "创建空创作条目",
          "submit-candidate": "提交已固定范围的候选",
          "add-review": "提交已固定版本的审阅意见",
        };
        if (labels[name])
          add(
            `script.${name}`,
            labels[name]!,
            "write",
            withoutAction(command),
            (params) => ({
              action: "script",
              script: {
                action: "command",
                command: { action: name, ...params },
              },
            }),
          );
      }
    } else {
      const labels: Record<string, string> = {
        list: "查找剧本",
        "read-production": "读取创作要求、目录和当前版本",
        "read-generation": "读取本次已固定的生成范围",
        "read-workflow": "读取当前请求和工作流资料包",
        "prepare-workflow": "固定目标、版本、依赖和生成预算，交给 Yao 继续",
        "submit-workflow": "校验并保存本次工作流成果，返回消息入口",
        "read-results": "核对本次已保存成果",
        "read-result": "读取本次确切成果",
        "read-item": "读取确切版本的剧本文稿",
        "read-source": "读取获准原作",
        issues: "读取结构检查结果",
        impact: "查询依赖影响范围",
      };
      add(
        `script.${action}`,
        labels[action]!,
        ["prepare-workflow", "submit-workflow"].includes(action)
          ? "write"
          : "read",
        withoutAction(schema),
        (params) => ({ action: "script", script: { action, ...params } }),
      );
    }
  }
  const summary = (op: Definition) => ({
    id: op.id,
    domain: op.domain,
    title: op.title,
    effect: op.effect,
    ...(op.domain === "script"
      ? { harness: scriptStudioApplication.harness }
      : {}),
  });
  const lookup = (id: string) => {
    const op = definitions.find((op) => op.id === id);
    if (!op)
      throw new DomainError("not_found", "操作不存在，请重新发现可用操作。");
    return op;
  };
  return {
    list: () => definitions.map(summary),
    describe: (id: string) => {
      const op = lookup(id);
      return {
        ...summary(op),
        parameters: z.toJSONSchema(op.parameters, { io: "input" }),
        result:
          "返回原领域操作的结构化结果；写操作返回真实 receipt。受理/准备不等于生成或完成；必须核对保存结果与入口。",
        authority:
          "由 Host 从真实输入推导身份、项目、权限；参数不能选择操作者或伪造用户。调用与按钮共用领域校验。",
        ...(op.domain === "script"
          ? {
              workflow:
                "明确要求生成/改写/检查时选择本应用 Harness，由 Yao 完成意图→工具查找/准备→创作→检查/修订→保存。不要求先打开工作室或点击按钮。讨论不保存；歧义才追问；资料未授权则说明缺口，不代替用户确认权利。",
            }
          : {}),
      };
    },
    invoke: (id: string, parameters: unknown) => {
      const op = lookup(id);
      return op.request(op.parameters.parse(parameters));
    },
  };
}
