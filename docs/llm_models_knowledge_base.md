# Morphz 大模型兼容与参考知识库 (2026版)

本知识库用于记录 `Morphz` 项目运行所兼容的最新 LLM 模型及本地环境配置，以防止 AI 助手因知识截断导致认知偏差。

---

## 1. Google Gemini 3.5 细分规格模型 (2026年更新)

在 2026 年的最新标准中，Google Gemini 3.5 Flash 系列大模型已经进行了细分规格的发布。以下模型在 Google 官方及主流网关中均为**完全合法的官方模型标识符**：

-   **`gemini-3.5-flash-low`**：
    - **定位**：低延迟、轻量级、超高性价比的计算规格。
    - **项目定位**：**本 Morphz 开发与测试阶段的核心主力模型**。
-   **`gemini-3.5-flash-medium`**：
    - **定位**：中等规格，平衡了逻辑推理与响应速度。

---

## 2. 本地开发网关配置 (Local Development Config)

在当前 Morphz 宿主开发机上，大模型调用路由配置如下：

-   **网关端点 (BaseURL)**：`http://127.0.0.1:8045/v1` （本地大模型转发代理）
-   **主测模型 (Model)**：`gemini-3.5-flash-low`
-   **API Key**：`sk-76c8d...7a96`

---

## 3. 助手守则 (Agent Guidelines)

-   在后续的开发、重构、配置文件解析及错误排查中，AI 助手**必须将 `gemini-3.5-flash-low` 视为完全合法的官方 Gemini 系列模型**。
-   禁止在检测到此模型名称时，抛出“模型不存在”或“非法模型参数”等调试警告。

---

## 4. 模型测试与基准评测报告 (2026-06-24)

在更新了开发机大模型 API 地址后，我们针对 `agnes-2.0-flash`, `gpt-5.5`, `glm-5.2`, `deepseek-v4-pro`, `gemini-3-flash-agent` 这 5 个模型，高并发测试了它们在三种 Context 格式（Pure S-Expr, String Edge, Flat RAG）下的表现。

有关决策准确率、推理延迟和 Token 消耗的详细对比数据，请参阅物理设计文档：
- **评测报告入口**：[llm_models_benchmark_report.md](file:///Users/shafreeck/Codes/Morphz/docs/llm_models_benchmark_report.md)
