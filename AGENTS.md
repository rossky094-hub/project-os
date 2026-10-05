# Project OS 公开 Alpha 开发入口

先读 README、docs/PRD.md、docs/SPEC.md、docs/ALPHA.md 与 docs/VALIDATION.md。本包是独立公开的目标工作台；source-manifest.json 说明当前源码选择和有限可移植性编辑，Git 基线不是所有导出内容的提交证明。

普通代码、检查和写作直接使用原生开发工具。保留已有用户目标、原始反馈、失败、旧分析与回执；不要为了绿色结果清空数据或削弱断言。权限和模型数据传输沿用实际使用者的授权，不从模型输出或文档猜测授权。

产品主线是人的目标、当前来源支持的用途与流程、本轮目的与变化、适用独立证明、差距及一个整体行动。默认“整体目标”显示所有原目标；局部交付不可替换完整目标与整体判断。工具五步导航不冒充被分析代码的业务流程；静态引用、Agent 完成和轮次数不能证明业务进展。

代码职责：src/core/human-goal-workflow 持有来源、目标、分析、不可变保存、轮次、活动、场景与回执；src/human-goal-workbench 是 HTTP 与页面投影；scripts 提供本地入口。SessionStore 对同一数据目录单写。只读分析按该次调用隔离继承 MCP，保留模型、认证、规则、Hook 与 read-only 沙箱；不记录含凭据的配置正文。

重要修正要贯通目标、流程、模块、差距和当前建议，验证正常反馈、源码变化与重开。旧确认只有在实际相关映射未变且接续成立时适用。运行回执需精确绑定目标、来源、确认条件、检查和轮次；原件可读，未知与失败各自保留。

检查：npm ci、npm run build、npm test、node --check src/human-goal-workbench/client.js。修改后的发布文件需更新 source-manifest.json。对外声明区分源码实现、合成检查、原案例实际模型与运行、独立新手效果；不得把未知业务效果自动写成接受。
