# github-auto-star

自动给指定 GitHub 用户名下所有 **public** 仓库点 star。运行在 GitHub Actions 上，默认每小时一次。

## 工作原理

1. 读取 `users.json` 里的 GitHub 用户名列表
2. 对每个用户拉取其 owner 类型的所有公开仓库（自动分页）
3. 检查当前认证账号是否已 star，未 star 的执行 PUT `/user/starred/{owner}/{repo}`
4. 已 star、已归档（可选）、fork（可选）会被跳过

## 使用方法

### 1. fork / push 到你自己的 GitHub 仓库

将 `github-auto-star` 目录作为根目录推到 GitHub。

### 2. 创建 Personal Access Token (PAT)

> 必须用 PAT，**不能**用 `GITHUB_TOKEN`。后者属于 workflow 自己，没有"代表你 star 别人仓库"的权限。

- Classic Token：勾选 `public_repo` 即可
- Fine-grained Token：Account permissions → **Starring: Read and write**

### 3. 配置仓库 Secret

仓库 → Settings → Secrets and variables → Actions → **New repository secret**

- Name: `STAR_TOKEN`
- Value: 上一步生成的 PAT

### 4. 修改监控的用户列表

编辑 `users.json`：

```json
{
  "users": ["torvalds", "sindresorhus", "tj"],
  "options": {
    "includeForks": true,
    "includeArchived": false,
    "dryRun": false
  }
}
```

| 字段              | 含义                                                  |
| ----------------- | ----------------------------------------------------- |
| `users`           | 要监控的 GitHub 用户名数组                            |
| `includeForks`    | 是否对 fork 仓库也点 star，默认 `true`                |
| `includeArchived` | 是否对已归档仓库也点 star，默认 `false`               |
| `dryRun`          | 只检测不实际 star（用于调试），默认 `false`           |

push 后 GitHub Actions 自动生效，下次定时任务即使用最新配置。

### 5. 手动触发 / 试运行

仓库 → Actions → **Auto Star** → **Run workflow**，可选传入 `dry_run = true` 在不真正 star 的前提下查看会处理哪些仓库。

## 本地调试

```bash
cd github-auto-star
npm install
$env:GITHUB_TOKEN_FOR_STAR="ghp_xxx"   # PowerShell
# 或   export GITHUB_TOKEN_FOR_STAR=ghp_xxx   # bash
npm start
```

## 定时频率

默认 `cron: "17 * * * *"` —— 每小时第 17 分钟执行一次（GitHub Actions 的 cron 在整点容易排队，错开几分钟更稳定）。  
要改频率直接编辑 `.github/workflows/auto-star.yml`。

## 注意事项

- GitHub REST API 已认证用户限速 5000 次/小时。脚本对每个候选仓库会发 1 次"是否已 star"检查 + 最多 1 次 star 写入，所以监控规模 ≤ 数千仓库时无压力。
- 内置 `@octokit/plugin-throttling`，遇到主/次级限速会自动退避并最多重试 2 次。
- workflow 的 `permissions: contents: read` 只用于 checkout 代码，与 star 行为无关。
- 如果某次运行出现失败仓库，job 退出码为 1，便于在 Actions 页面看到红色标记。
