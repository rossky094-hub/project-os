# Project OS Alpha 实现约束

## 独立包与入口

package.json 和 package-lock.json 固定源码预览的 Node 依赖。npm run setup 使用 tsx 运行 scripts/setup.ts，npm start 使用 tsx 运行 scripts/human-goal-workbench.ts serve --config .local/config.json。npm run build 执行 TypeScript 编译，包含 src、scripts、tests，输出到忽略的 dist/。服务中的页面资源通过源码模块相对路径读取 src/human-goal-workbench 下的 HTML、CSS 和 JS；dist/ 没有这些静态文件，不能单独用 node dist/scripts/human-goal-workbench.js 当作完整运行包。

src/core/human-goal-workflow 是状态和约束的单一实现。source.ts 在显式范围内枚举源文件，拒绝越界与符号链接，限制文件数量、类型和读取容量，并把未提供部分记为缺口。types.ts 定义严格 schema。service.ts 将目标、反馈、分析、场景确认、观察和回执绑定至代次与项目身份；store.ts 以单写者锁、不可变状态对象和原子指针保存。analyzer.ts 构造受限输入，通过配置的 Codex CLI 以只读分析请求生成结构化结果，并记录调用与输出。模型输出的引用、ID、已发现/拟需状态由本地代码校验；静态支持仍不等于行为验证。

## 范围与本地数据

setup 要求 --source 与至少一个 --scope，可重复 --scope、--exclude、--evidence；--id、--label、--revision、--case-role 和 --data 可选。范围和排除项相对来源根，范围必须存在。证据根需已存在，之后只可通过登记根索引与相对路径读取原件。数据目标不能处在来源根或本包中，也不能包含它们；.local/data 是指向外部数据目录的本地链接，.local/config.json 保存精确登记。若登记范围将覆盖 .local/config.json 或 .local/data，setup 拒绝并要求缩窄范围或显式排除。已有本地配置与链接不会被覆盖。

配置的 project.sourceKind 默认为 working-tree，revision 默认为 working-tree-unpinned；这不是冻结提交的证明。数据、原始分析请求、事件记录和验证原件均为本地私有材料，不能提交至源码预览。首次分析前查看页面“检查范围”中的选中文件、跳过项和读取缺口。source.partial 或未映射条件不能扩大成全仓结论。

## 三种关系和状态变更

- 工作主线的 journey 包含 observed 与 desired 步骤，链接需要明确的 sequence、branch 或 feedback 条件。实际步骤只有在来源和目标映射成立时才可标记 source-supported；未知步骤继续标记 unknown。
- 实现 modules 与 edges 表示代码职责和连接。边记录关系类型与确定性；import 至多支持依赖，不自动成为调用或运行轨迹。
- rounds、agent-activity 与 mainline-progress 记录选定事件、轮次来源快照及人工主线关联。关联引用目标 hash、来源 hash、分析 attempt、旅程和步骤；旧关联以追加记录保存。事件读取状态和 Agent 报告与独立行为验证分开。

自动观察的明确适配范围：Codex exec JSONL 0.155.0-alpha.2.6 或 0.155.0-alpha.9.2；Codex native rollout 0.155.0-alpha.9.2。其他版本（包括 0.155.0-alpha.16）不可凭近似版本号当作已支持。登记的证据根、流身份、工作树和目标绑定不一致时不得自动关联。人工轮次登记也需要真实已有基线；历史流不能冒充刚开始的 live 流。

## 确认条件与验证回执

模型提出的 scenarios 先经人核对、可修改后确认。verificationContext 只在当前目标、来源分析、确认条件和登记轮次相互匹配时产生。verificationChecks[projectId] 中的每个检查含 id、label、argv、prerequisites 和 bindings；bindings 把唯一 assertionId 精确映射到已确认的 scenarioId/criterionId。检查从本地 CLI 选择，直接以 argv 和来源根 cwd 启动，不经 shell；网页没有执行命令路由。

检查程序用一行 PROJECT_OS_ASSERTION 加 JSON 输出 assertionId、status、actual、evidence。支持 passed、behavior-failed、missing-capability、environment-blocked、unknown；只有退出码为零且结构化断言唯一有效时，passed 才被接纳。进程退出码本身不是条件通过。CLI 记录前提、输出、源变化和绑定，使用独占新文件保存 receipt。导入时必须提供已登记 evidenceRoot 的 rootIndex、相对路径和文件 SHA-256；服务重算回执 hash、检查配置、目标、条件、轮次及时间绑定。来源改变、环境缺失或旧条件不会被折算为当前通过。

读者可从 [ALPHA.md](ALPHA.md) 找到可移植的设置、断言映射和导入示例。当前私有案例、真实日志、授权材料和编译产物不属于公开源码输入；source-manifest.json 记录导出的已提交来源及唯一允许的测试路径可移植性编辑。

本公开包采用 [MIT 许可证](../LICENSE)，版权归 2026 rossky094-hub 所有；未导出的私人材料不在本包许可范围内。
