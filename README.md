# 多模型协作

Windows 本地模型协作插件及桌面面板。当前 GPT 负责协调、执行修改与验证，可将明确子任务交给 DeepSeek 或兼容 Chat Completions 的服务。

## 功能

- 配置模型服务、助手角色、职责和输出预算。
- 在模型名称下方选择服务商默认、低、高或最高推理等级，任务可单独覆盖。
- 支持 1 至 4 个并发任务，默认并发数为 2。
- 流式显示任务阶段和已生成的部分结果，完整结果与用量保存在本机。
- 通过 `wait_tasks` 收取先完成的任务，支持取消、幂等提交及中断恢复。
- API 密钥使用 Windows 当前用户加密存储。

## 运行

需要 Windows 和 Node.js 22 或以上版本。

在仓库目录执行下列命令，打开本机配置面板。

```powershell
node plugins/model-team/src/cli.mjs open
```

在“模型接入”里填写自己的接口和 API 密钥，然后配置助手并提交任务。默认模型 ID 为 `deepseek-flash`，以服务商账号实际可用模型为准。

流式接口需要支持 Chat Completions SSE。兼容服务可在角色设置中关闭流式输出，并按服务商能力选择推理参数。

## Codex 插件

插件定义位于 `plugins/model-team`，本地插件市场清单位于 `.agents/plugins/marketplace.json`。安装前按本机 Node.js 位置调整 `plugins/model-team/mcp.json` 的启动命令，安装后重新加载插件。

通过 `list_roles` 一次获取角色、主 Agent 职责及协作规则，通过 `submit_task` 分配子任务，使用 `wait_tasks` 等待任一任务结束。

## 协作方式

简单查询和局部修改由主 Agent 直接完成，独立子任务并行提交。范围明确的任务可使用低推理，复杂推导与关键审查使用高推理。主 Agent 应用结果并运行相关测试，遇到测试失败、截断或关键证据缺失时补充材料并升级复核。详细规则见 [任务角色与协作规则](任务角色与协作规则.md)。

这些规则由协调模型执行，任务质量和实际耗时取决于模型、材料、网络和验证过程。

## 桌面端

桌面入口位于 `desktop/main.cjs`。`desktop/build.mjs` 当前使用作者本机已有的 Electron 运行库及 Node.js 路径，迁移到其他电脑构建时需要调整这两个路径。发布目录由构建脚本生成。

## 测试

```powershell
cd plugins/model-team
npm test
```

测试覆盖配置保存、Windows 密钥加密、并发、取消、重启恢复、推理等级、流式响应、中断处理和插件协议。测试使用虚构密钥和本机模拟服务。

真实 API 密钥、用户配置及协作任务记录存放在本机用户数据目录，仓库提供程序源码、测试、静态资源和说明。
