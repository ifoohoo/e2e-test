# 安全政策

## 项目状态

e2e-test 的规格内核（default、help、author、review、repair）为 stable（稳定），浏览器扩展（implement、execute）为 experimental（实验性）。五个核心服务已完成操作行为资格认证，但在未显式 binding（绑定）的项目中默认 NOT_ENABLED（不启用）；浏览器扩展还需要显式 ExtensionBinding。

## 运行边界

- 本技能族仅在 agent 宿主（Claude Code / Codex）本地会话中运行，不提供网络服务，不监听端口。
- 技能产物为本地文件（artifact、run 记录、门禁报告），不上传远端。
- 确定性门禁脚本只读取项目内文件并输出校验结果，不执行任意远程代码。

## 支持的版本

| 版本系列 | 状态 | 安全支持 |
| --- | --- | --- |
| 0.2.x | 正式版 | 接收安全报告并提供修复版本 |
| 0.2.0-alpha.x | 历史预发布 | 仅建议升级到最新 0.2.x |
| 更早版本 | 不维护 | 无 |

## 漏洞报告

如发现安全问题，请不要在公开 issue 中披露细节。请通过以下任一方式私下报告：

1. 在 [ifoohoo/e2e-test](https://github.com/ifoohoo/e2e-test) 的 issues 中提交标题含「安全」的报告，正文只写影响范围与复现入口，不附利用细节；
2. 如 GitHub 启用了私有漏洞报告（Security Advisories），优先使用该通道。

我们将在收到报告后尽快确认，并在修复发布后同步致谢（除非报告者要求匿名）。

## 安全相关配置提示

- 启用本技能族需要项目显式声明 binding；默认安装不会自动开启任何服务。
- 门禁与 attestation（认证记录）文件（如 `conformance/last-run.json`、`family/implementation.yaml`）是真实性证据，请勿手工篡改；被篡改的证据会导致 Registry 校验失败并拒绝绑定。
