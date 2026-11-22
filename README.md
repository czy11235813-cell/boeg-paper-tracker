# 📊 BOEG 科研论文投稿进度自动跟踪系统

专为投递 ***Bulletin of Engineering Geology and the Environment* (BOEG)**（`https://www.editorialmanager.com/boeg/default2.aspx`）定制的**全自动投稿进度网页看板 + 国内邮箱转发 Gmail 邮件提醒**工具。

- **电脑关机也能每天自动跑**：基于 **GitHub Actions** 每日北京时间 `09:35` 与 `21:35` 自动登录 Editorial Manager 检查稿件进展，并自动发布更新到 **GitHub Pages** 在线进度网页。
- **精准捕捉每一次细微动态**：不仅监控 `Current Status` 状态变更（如 `With Editor` → `Under Review` → `Required Reviews Completed`），还能捕捉**状态未变但 `Status Date` 审稿日期跳动**（代表新审稿人接受邀请或审稿意见返回），以及初投后正式分配 `BOEG-D-...` 稿号、转入修回目录、出最终录用决定等全流程节点。
- **国内邮箱直连转发至 Gmail**：支持使用 **QQ 邮箱 / 163 邮箱 / 126 邮箱** 的 16 位 SMTP 授权码发信到您的 **Google 邮箱 (`@gmail.com`)**，本地与云端均稳定免代理。
- **自带本地可视化测试中心**：上传 GitHub 前，双击 `启动本地配置与预览网页.bat` 即可在本地网页中一键测试邮件投递和抓取效果。

---

## 一、快速准备：获取国内邮箱 16 位 SMTP 授权码（约 1 分钟）

以 **QQ 邮箱** 或 **163 邮箱** 为例（任选其一作为发信机器人邮箱，收件邮箱填你的 Gmail）：

- **QQ 邮箱**：网页登录 [mail.qq.com](https://mail.qq.com) → 顶部 **设置** → **账号** → 往下找到 **POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务** → 开启 **POP3/SMTP服务** → 按提示验证后复制生成的 **16 位授权码**。
- **163 邮箱**：网页登录 [mail.163.com](https://mail.163.com) → 顶部 **设置** → **POP3/SMTP/IMAP** → 开启 **IMAP/SMTP服务** → 新增授权密码并复制 **16 位授权码**。

---

## 二、第一步（推荐）：在本地网页一键验证账号与邮件（2 分钟）

1. 双击文件夹中的 **`启动本地配置与预览网页.bat`**（会自动打开浏览器访问 `http://127.0.0.1:3080`）。
2. 在页面上方的 **「本地配置与一键连通测试中心」** 填写：
   - **Editorial Manager 用户名 & 密码**（平时点击 `Author Login` 用的账号密码）
   - **国内发件邮箱账号**（如 `123456@qq.com`）与刚才获取的 **16 位 SMTP 授权码**
   - **接收通知的谷歌邮箱**（如 `yourname@gmail.com`）
3. 点击 **「📧 发送一封测试邮件到 Gmail」**，确认 Gmail 能秒收邮件。
4. 点击 **「🔄 立即登录抓取进度」**（或「弹出浏览器可视化抓取一次」），即可看到您的论文实时进度卡片与阶段解读显示在看板上！

> 🔒 **隐私安全保证**：本地填写的 `.env` 文件已在 `.gitignore` 中严格排除，后续上传到 GitHub 时绝不会把您的密码上传到代码库中。

---

## 三、第二步：部署到 GitHub Actions + GitHub Pages（实现关机每日自动追踪）

### 1. 创建 GitHub 仓库并上传代码
1. 登录 GitHub 新建一个仓库（例如命名为 `boeg-paper-tracker`）：
   - **想免费开启 GitHub Pages 在线看板网页**：将仓库设为 **Public（公开）**（账号密码存放在加密 Secrets 中外界完全不可见；如果不想在公开网页显示未发表论文标题，可在 Secrets 中加一条 `HIDE_MANUSCRIPT_TITLE` = `true`，网页会自动脱敏标题，而发给您 Gmail 的邮件仍显示完整标题）。
   - **只想收 Gmail 邮件提醒、不需要公开网页**：可将仓库设为 **Private（私有）**（GitHub 每月赠送 2000 分钟免费运行额度，本项目每月仅消耗约 30 分钟）。
2. 在 `E:\论文投稿进度跟踪` 目录打开终端执行以下命令推送代码：
   ```powershell
   git init
   git branch -M main
   git add .
   git commit -m "feat: init BOEG manuscript tracker"
   git remote add origin https://github.com/<你的GitHub用户名>/<你的仓库名>.git
   git push -u origin main
   ```

### 2. 配置 GitHub Repository Secrets（填入 5 个必填密钥）
进入你的 GitHub 仓库页面 → 点击顶部 **Settings** → 左侧菜单 **Secrets and variables** → **Actions** → 点击绿色按钮 **New repository secret**，依次添加以下 **5 个必填项**：

| Secret 名称 (`Name`) | 填写内容 (`Secret`) |
| :--- | :--- |
| `EM_USERNAME` | 你在 BOEG Editorial Manager 的登录用户名 |
| `EM_PASSWORD` | 你在 BOEG Editorial Manager 的登录密码 |
| `SMTP_USER` | 发件国内邮箱地址（例如 `12345678@qq.com` 或 `xxx@163.com`） |
| `SMTP_PASS` | 发件国内邮箱的 **16 位 SMTP 授权码** |
| `NOTIFY_TO` | 接收通知的谷歌邮箱地址（例如 `yourname@gmail.com`） |

*(可选 Secret：若公开仓库想隐藏网页上的论文标题，额外添加 `HIDE_MANUSCRIPT_TITLE` 填 `true` 即可。)*

### 3. 开启 GitHub Pages 在线进度网页
1. 在仓库 **Settings** → 左侧菜单点击 **Pages**。
2. 在 **Build and deployment** 下的 **Source** 下拉框中，选择 **`GitHub Actions`**。

### 4. 手动触发首次云端运行验证
1. 点击仓库顶部的 **Actions** 标签页 → 左侧点击 **BOEG 论文投稿进度自动跟踪与网页更新**。
2. 点击右侧 **Run workflow** 下拉按钮 → 勾选测试邮件选项（可选）→ 点击绿色 **Run workflow**。
3. 等待约 1 分钟变成绿色 `✓` 后：
   - 你的在线跟踪网页已自动上线：`https://<你的GitHub用户名>.github.io/<你的仓库名>/`（可以收藏到手机浏览器桌面随时查看！）
   - 此后每天北京时间 **09:35** 与 **21:35** 系统会自动在云端巡检，一旦论文状态或审稿日期发生变化，立即发邮件到你的 Gmail！
