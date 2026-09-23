# Alpha 本地操作与证据边界

## 一次可重复的本地安装

从独立克隆开始。Node 版本需满足 package.json 的 engines，npm 使用锁文件：

~~~sh
npm ci
npm run build
npm test
npm run setup -- --source /path/to/demo-app --scope main.mjs --scope checks --evidence /path/to/evidence --data /path/to/project-os-data --id demo --label "示例项目"
npm start
~~~

这些路径只是占位符；demo-app、main.mjs、checks 和 evidence 需在运行前由用户准备，数据目录位于本包与 demo-app 之外。未配置 --evidence 时仍可浏览与分析，但无法从证据根导入文件回执。setup 不读取源码或启动模型；启动后的“开始理解代码”会把已登记范围的源文本发给本机配置的 Codex CLI 及其提供方。请先核对范围、传输许可和本地配置。若重配项目，先检查既有 .local/config.json 和持久状态，setup 不覆盖它们。

服务打印 127.0.0.1 的实际端口。先在界面记录人的目标并核对原文，再运行分析、检查来源行号和未知项。模型场景是建议；修改并确认可观察的场景条件后，才将开发轮次与目标和产品主线关联。选定 Codex 会话的自动观察属于独立入口，不会代替人的目的和步骤关联。先捕获真实开发前来源，开发后观察新的来源，再作同轮次比较。

## 登记一个实际条件检查

以下例子假设被检查的项目有 main.mjs 导出 answer()，并在项目自己的 checks/read-answer.mjs 中运行真正的行为检查：

~~~js
import { answer } from '../main.mjs';
const actual = answer();
console.log('PROJECT_OS_ASSERTION ' + JSON.stringify({
  assertionId: 'returns-42',
  status: actual === 42 ? 'passed' : 'behavior-failed',
  actual: String(actual),
  evidence: 'answer() returned ' + String(actual)
}));
~~~

在确认的场景中，假设 scenarioId 为 read-answer、criterionId 为 returns-42。把下面片段加入 setup 生成的 .local/config.json 顶层；若实际确认的 ID 不同，先以页面记录为准修改绑定，不能为匹配示例而改写结论：

~~~json
{
  "verificationChecks": {
    "demo": [{
      "id": "read-answer",
      "label": "answer() returns 42",
      "argv": ["node", "checks/read-answer.mjs"],
      "prerequisites": [{"kind": "path", "value": "checks/read-answer.mjs"}],
      "bindings": [{
        "assertionId": "returns-42",
        "scenarioId": "read-answer",
        "criterionId": "returns-42"
      }]
    }]
  }
}
~~~

保留配置原有的 projects、dataDir 等字段；上述 JSON 只是要合并的字段，不是整个配置。检查程序从已登记来源根启动，且只能由本地验证 CLI 的配置 argv 调用。它不从 HTTP 接收 shell 字符串。若服务正在运行，改过配置后先正常停止并重启，使服务与 CLI 使用同一登记。检查执行前确认目标、来源分析、场景确认和本轮登记均为当前版本。

~~~sh
npm run verify -- --config .local/config.json --project demo --round ROUND_ID --checks read-answer --output /path/to/evidence/read-answer-1.json
~~~

把 ROUND_ID 替换为真实登记的轮次 ID。输出文件必须尚不存在；失败、环境阻塞和未知结果也保留原件。验证 CLI 打印 receipt ID 和 SHA-256；导入使用文件字节的 SHA-256，不使用屏幕复制的摘要或检查程序自己的文字说明。若需复核，可用 Node 计算：

~~~sh
node -e "const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" /path/to/evidence/read-answer-1.json
~~~

在同源工作台向 /api/projects/demo/verification-import 发送 POST JSON，Origin 为页面的 http://127.0.0.1:实际端口，Content-Type 为 application/json。用当前 /api/projects/demo/state 的 generation 替换下方数字，用上一步文件摘要替换 SHA256；路径相对 setup 中第一个 --evidence 根：

~~~json
{
  "expectedGeneration": 8,
  "idempotencyKey": "import-read-answer-1",
  "record": {
    "rootIndex": 0,
    "path": "read-answer-1.json",
    "sha256": "SHA256"
  },
  "analyze": false
}
~~~

相同 idempotencyKey 只可重放同一请求；新回执用新文件名与新键。导入后查看条件状态及前后比较，不能仅凭收到 receipt 或命令零退出码断言目标完成。若来源、场景确认、目标或轮次已改变，旧回执保留作历史，再对当前绑定验证。

## 已知边界与发布判断

本包的合成测试验证实现约束，不能代替实际项目的模型分析、真实开发事件、行为检查、重启后的连续性和桌面阅读。Alpha 尚无独立新手或陌生项目的可重复验收，也没有生产托管或 npm 发布。自动事件适配器仅覆盖 SPEC 中列出的精确版本。npm run build 不复制静态页面文件，因此启动请使用 npm start。本公开包采用 [MIT 许可证](../LICENSE)，版权归 2026 rossky094-hub 所有；使用、修改和再分发时须保留版权与许可声明。
