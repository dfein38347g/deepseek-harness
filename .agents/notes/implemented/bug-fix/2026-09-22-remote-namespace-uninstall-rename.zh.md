# Agent Note: 远程命名空间服务生命周期方法改名为 uninstall

Status: implemented

[English](2026-09-22-remote-namespace-uninstall-rename.md) | 中文

## 问题

远程客户端的命名空间服务 `RemoteNamespaceService`（`packages/api/gateway/src/client/index.ts`）暴露生命周期方法 `remove(kind, method, token)`，在挂载被释放或回滚时卸载已挂载的方法。该服务的守卫 `assertMethodAvailable` 拒绝任何属于命名空间服务字段或出现在服务原型上的远程方法名，而 `remove` 正在该原型上。当 session 远程贡献为会话删除添加 `@Remote('remove')` 后，挂载 session 贡献抛出 `client api: method "session/remove" conflicts with its namespace service`，整个 `dsh-api-remotes` 插件加载失败。

## 决策

生命周期方法改名为 `uninstall(kind, method, token)`。两处调用点——`ClientRemoteService` 的命名空间释放路径与 `installMethods` 的回滚路径——调用 `uninstall`。wire 契约不变：远程方法仍为 `session/remove`，客户端的 `sessions.remove()` 调用不变。守卫不变：`remove` 不再被保留，而 `has`、`empty` 及其余服务成员仍被拒绝作为方法名。

## 考虑过的替代方案

**在 wire 上重命名远程方法（例如 `session/delete`）。** wire 名是 session-controller 的 Host 贡献、生成的描述符与客户端消费者共享的契约；为仅由 gateway 客户端内部辅助方法引起的冲突而在包间传播破坏性变更，代价不成比例。

**让 `remove` 豁免于保留名守卫。** 守卫的存在正是为了捕获远程方法悄悄遮蔽命名空间服务成员的情况；豁免一个名字会留下同类冲突，并编码一个守卫测试无法与回归区分的例外。

## 后果

名为 `remove` 的远程方法可以干净地挂载与释放。gateway 客户端规格固定两侧：`has` 描述符仍抛出 `conflicts with its namespace service`，而 `remove` 描述符挂载后其释放器运行改名后的生命周期路径。名为 `uninstall` 的远程方法现在取而代之被保留。e2e 通道的 `built-lib.e2e.ts` 启动构建后的 remotes 客户端 bundle，其中携带 session 贡献，在修复前会复现原有的加载失败。