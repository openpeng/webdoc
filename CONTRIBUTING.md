# 贡献指南

感谢参与 WebPilot！项目结构与设计决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发环境

- Node.js >= 18（推荐 LTS）
- Chrome / Edge 等 Chromium 内核浏览器（加载 browser-extension，步骤见 [INSTALL.md](INSTALL.md)）

```bash
cd mcp-server
npm install
npm run build     # tsc 编译到 dist/
npm run dev       # watch 模式
npm test          # 构建 + node:test 测试套件（test/*.test.mjs）
npm run doctor    # 安装自检：Node 版本、构建产物、定义加载、桥接端口
```

测试直接驱动 `dist/` 编译产物，所以改动 `src/` 后 `npm test` 会先自动构建。扩展端改动（browser-extension/）在 `chrome://extensions` 点击"重新加载"即可生效，无需构建。

## 三种贡献路径

### 1. 改代码（mcp-server/src、browser-extension）

- 提交前必须通过 `npm test`；扩展端 JS 至少通过 `node --check`。
- 新增校验逻辑、白名单、持久化格式时请同步补测试——安全边界相关行为（白名单重建、占位符校验、缓存准入）都有对应测试文件可以参考。
- 涉及组件职责或数据流变化时，同步更新 docs/ARCHITECTURE.md。

### 2. 贡献站点定义（definitions/*.json，无需写代码）

新增/修改适配器或预置工作流只需编辑 JSON，写法见 [docs/adapter-authoring.md](docs/adapter-authoring.md)。注意安全约束（校验不通过的定义会被静默跳过，`npm run doctor` 可查看跳过原因）：

- 适配器 spec 只支持 fields/list/table 三种只读提取形态；`attribute` 仅 `href`/`content`；不存在 `computed` 之类的可执行字段。
- 预置工作流 id 必须带 `preset-` 前缀；navigate 仅 http(s)；type 文本必须是 `{{param}}` 占位符，不允许字面输入。
- 先在本地用 `WEBPILOT_ADAPTER_DIR` / `WEBPILOT_WORKFLOW_DEF_DIR` 指向自己的目录验证，跑通后再移入内置 definitions/ 提交。

### 3. 改文档

README 讲用法，docs/ 按主题分工（架构 / 适配器编写 / 沉淀策略）。行为变化时请保持文档与代码同步。

## 提交规范

提交信息格式与仓库历史保持一致：

```
feat(webpilot): 中文描述本次改动
```

常用 type：feat / fix / docs / test / refactor。

## PR 自查清单

- [ ] `npm test` 全绿
- [ ] `npm run doctor` 无 FAIL（定义改动无新增"被跳过"告警）
- [ ] 新行为有测试覆盖（代码改动时）
- [ ] 相关文档已同步（README / docs/）
- [ ] 提交信息符合 `type(webpilot): 中文描述` 格式
