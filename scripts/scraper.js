const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/**
 * 在 Windows 本地运行时优先复用系统已安装的 Chrome 或 Edge，无需额外下载 300MB 浏览器内核；
 * 在 GitHub Actions 云端运行时自动使用预装好的 Playwright Chromium。
 */
function findLocalBrowserExecutable() {
  if (process.env.GITHUB_ACTIONS === 'true') return null;
  if (process.platform !== 'win32') return null;

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
      : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const exe of candidates) {
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Editorial Manager 作者主菜单核心监控目录（覆盖从初审、退修、修回审稿到最终录用全生命周期）
 */
const TARGET_FOLDERS = [
  { key: 'Submissions Being Processed', cnLabel: '初审/外审处理中' },
  { key: 'Submissions Needing Revision', cnLabel: '需要作者修回' },
  { key: 'Revisions Being Processed', cnLabel: '修回稿审理中' },
  { key: 'Submissions Sent Back to Author', cnLabel: '退回作者补充材料/格式' },
  { key: 'Revisions Sent Back to Author', cnLabel: '修回稿退回补充' },
  { key: "Submissions Waiting for Author's Approval", cnLabel: '待作者确认PDF' },
  { key: "Revisions Waiting for Author's Approval", cnLabel: '修回稿待确认PDF' },
  { key: 'Submissions with a Decision', cnLabel: '已有最终审稿决定' },
];

/**
 * 安全合规检查：如果遇到站点人机验证（CAPTCHA / Turnstile），立即停止并如实报告，绝不尝试绕过
 */
async function checkAntiBotChallenge(page) {
  const frames = page.frames();
  for (const frame of frames) {
    const url = (frame.url() || '').toLowerCase();
    if (
      url.includes('recaptcha') ||
      url.includes('hcaptcha') ||
      url.includes('challenges.cloudflare.com') ||
      url.includes('turnstile')
    ) {
      throw new Error(
        '检测到 Editorial Manager 触发了人机验证安全拦截（CAPTCHA），程序已按安全规范自动中止。建议降低检查频率或在本地浏览器查看。'
      );
    }
  }
}

/**
 * 在嵌套 frame 树中寻找包含登录输入框（#username + #passwordTextbox / password）的 Frame
 */
async function findLoginFrame(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkAntiBotChallenge(page);

    for (const frame of page.frames()) {
      try {
        const hasInputs = await frame.evaluate(() => {
          const u =
            document.querySelector('#username') ||
            document.querySelector('input[name="username"]');
          const p =
            document.querySelector('#passwordTextbox') ||
            document.querySelector('input[name="password"]') ||
            document.querySelector('input[type="password"]');
          return Boolean(u && p);
        });
        if (hasInputs) return frame;
      } catch (_) {
        // 跨域或尚未就绪的辅助 iframe（如 OneTrust）安全跳过
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 在 frame 树中寻找登录后的 Author Main Menu 所在 Frame
 */
async function waitForAuthorMenuOrError(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await checkAntiBotChallenge(page);

    for (const frame of page.frames()) {
      try {
        const state = await frame.evaluate((folderKeys) => {
          const text = (document.body && document.body.innerText) || '';
          const lower = text.toLowerCase();

          // 1. 检查是否已经进入 Author Main Menu
          const matchedFolder = folderKeys.some((k) =>
            lower.includes(k.toLowerCase())
          );
          if (
            matchedFolder ||
            lower.includes('submit new manuscript') ||
            lower.includes('new submissions')
          ) {
            return { type: 'MENU_READY' };
          }

          // 2. 检查是否提示密码错误或登录失败
          if (
            lower.includes('invalid login') ||
            lower.includes('login attempt was unsuccessful') ||
            lower.includes('invalid username') ||
            lower.includes('invalid user name') ||
            lower.includes('account has been locked') ||
            lower.includes('password you entered is incorrect')
          ) {
            return { type: 'LOGIN_ERROR', snippet: text.slice(0, 300).trim() };
          }

          // 3. 有时登录后存在“Author Main Menu”跳转链接或隐私确认提示
          const menuLink = Array.from(document.querySelectorAll('a')).find((a) =>
            /author main menu/i.test(a.textContent || '')
          );
          if (menuLink && !document.querySelector('#passwordTextbox')) {
            return { type: 'HAS_MENU_LINK' };
          }

          return { type: 'WAITING' };
        }, TARGET_FOLDERS.map((f) => f.key));

        if (state.type === 'MENU_READY') {
          return frame;
        }
        if (state.type === 'LOGIN_ERROR') {
          throw new Error(
            'Editorial Manager 登录失败：用户名或密码不正确（或账号被锁定），请核对 EM_USERNAME 与 EM_PASSWORD。'
          );
        }
        if (state.type === 'HAS_MENU_LINK') {
          await frame.locator('a:has-text("Author Main Menu")').first().click();
          await page.waitForTimeout(1500);
        }
      } catch (err) {
        if (err.message && err.message.includes('登录失败')) {
          throw err;
        }
      }
    }
    await page.waitForTimeout(600);
  }

  throw new Error(
    '登录后等待 Author Main Menu 超时（可能网络较慢，或账号首次登录需要在网页端补充作者资料/确认隐私条款）。'
  );
}

/**
 * 从当前 Author Main Menu Frame 中提取所有非空（计数 != 0）的稿件目录链接
 */
async function collectActiveFolders(menuFrame) {
  return menuFrame.evaluate((folders) => {
    const anchors = Array.from(document.querySelectorAll('a'));
    const active = [];

    for (const folder of folders) {
      const targetLower = folder.key.toLowerCase();
      const matchedAnchor = anchors.find((a) => {
        const txt = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return txt === targetLower || txt.startsWith(targetLower + ' (') || txt.includes(targetLower);
      });

      if (!matchedAnchor) continue;

      // 查看链接自身及所在父级容器文本中的计数，例如 "Submissions Being Processed (1)" 或 "(0)"
      const rowEl =
        matchedAnchor.closest('tr') ||
        matchedAnchor.closest('li') ||
        matchedAnchor.closest('div') ||
        matchedAnchor.parentElement;
      const contextText = ((rowEl && rowEl.textContent) || matchedAnchor.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();

      // 匹配紧随目录名后的括号数字
      const escapedKey = folder.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const countRegex = new RegExp(escapedKey + '\\s*\\((\\d+)\\)', 'i');
      const m = contextText.match(countRegex) || contextText.match(/\((\d+)\)/);
      const count = m ? parseInt(m[1], 10) : null;

      // 如果明确标注 (0)，直接跳过无需点入
      if (count === 0) continue;

      const rawHref = matchedAnchor.getAttribute('href') || '';
      const resolvedUrl =
        rawHref && !rawHref.toLowerCase().startsWith('javascript:')
          ? new URL(rawHref, window.location.href).href
          : null;

      active.push({
        key: folder.key,
        cnLabel: folder.cnLabel,
        count,
        resolvedUrl,
      });
    }

    return active;
  }, TARGET_FOLDERS);
}

/**
 * 在稿件列表页面中智能按表头提取每一篇论文的详细状态
 */
async function extractManuscriptsFromTable(contentFrame, folderInfo) {
  return contentFrame.evaluate((folder) => {
    const cleanText = (str = '') =>
      str
        .replace(/[\u25b2\u25bc▲▼]/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 注意：单个表头单元格只能匹配唯一字段（匹配后立即 break），防止 "Status Date" 误匹配到 "Current Status"
    const headerRules = [
      {
        field: 'manuscriptNumber',
        exact: ['manuscript number', 'document number', '稿件编号'],
        includes: ['manuscript number', 'document number'],
      },
      {
        field: 'initialDateSubmitted',
        exact: ['initial date submitted', 'date submission began', 'date submitted'],
        includes: ['initial date submitted', 'date submission began'],
      },
      {
        field: 'revisionDueDate',
        exact: ['date revision due', 'revision due'],
        includes: ['revision due'],
      },
      {
        field: 'dateFinalDisposition',
        exact: ['date final disposition set', 'final disposition date'],
        includes: ['date final disposition'],
      },
      {
        field: 'finalDisposition',
        exact: ['final disposition'],
        includes: ['final disposition'],
      },
      {
        field: 'statusDate',
        exact: ['status date'],
        includes: ['status date'],
      },
      {
        field: 'currentStatus',
        exact: ['current status', 'status'],
        includes: ['current status'],
      },
      {
        field: 'title',
        exact: ['title', 'article title', 'manuscript title', '标题'],
        includes: ['article title', 'manuscript title'],
      },
    ];

    const tables = Array.from(document.querySelectorAll('table'));
    let bestTable = null;
    let bestHeaderRowIdx = -1;
    let bestColMap = null;
    let bestMatchScore = 0;

    for (const table of tables) {
      // 只检查该 table 自身的直接行，避免把外层布局 table 当成数据表
      const rows = Array.from(table.rows || []);
      for (let rIdx = 0; rIdx < Math.min(rows.length, 5); rIdx++) {
        const cells = Array.from(rows[rIdx].cells || []);
        if (cells.length < 3) continue;

        const colMap = {};
        let score = 0;

        cells.forEach((cell, cIdx) => {
          // 如果单元格内部还嵌有整张子 table，说明这是外层布局容器，跳过
          if (cell.querySelector('table')) return;
          const hText = cleanText(cell.innerText || cell.textContent || '').toLowerCase();
          if (!hText || hText.length > 60) return;

          for (const rule of headerRules) {
            if (colMap[rule.field] !== undefined) continue;
            const isExact = rule.exact.some((alias) => hText === alias);
            const isIncl = rule.includes.some((alias) => hText.includes(alias));
            if (isExact || isIncl) {
              colMap[rule.field] = cIdx;
              score++;
              break; // 该列已匹配，禁止继续匹配其他字段
            }
          }
        });

        if (
          score >= 2 &&
          (colMap.currentStatus !== undefined ||
            colMap.manuscriptNumber !== undefined ||
            colMap.finalDisposition !== undefined) &&
          score >= bestMatchScore
        ) {
          bestTable = table;
          bestHeaderRowIdx = rIdx;
          bestColMap = colMap;
          bestMatchScore = score;
        }
      }
    }

    if (!bestTable || !bestColMap) {
      return [];
    }

    const dataRows = Array.from(bestTable.rows).slice(bestHeaderRowIdx + 1);
    const manuscripts = [];

    for (const row of dataRows) {
      // 跳过隐藏行或分页导航行
      const cells = Array.from(row.cells || []);
      if (cells.length < 3) continue;

      const rowFullText = cleanText(row.innerText || row.textContent || '');
      if (!rowFullText || /^page\s+\d+\s+of\s+\d+/i.test(rowFullText)) continue;

      const getCol = (field) => {
        const idx = bestColMap[field];
        if (idx === undefined || !cells[idx]) return '';
        return cleanText(cells[idx].innerText || cells[idx].textContent || '');
      };

      const manuscriptNumber = getCol('manuscriptNumber');
      const title = getCol('title');
      const initialDateSubmitted = getCol('initialDateSubmitted');
      const statusDate = getCol('statusDate') || getCol('dateFinalDisposition');
      let currentStatus = getCol('currentStatus');
      const finalDisposition = getCol('finalDisposition');
      const revisionDueDate = getCol('revisionDueDate');

      if (!currentStatus && finalDisposition) {
        currentStatus = `Completed - ${finalDisposition}`;
      }

      // 过滤空行或子表头重复行
      if (!manuscriptNumber && !title && !currentStatus) continue;
      if (
        manuscriptNumber.toLowerCase() === 'manuscript number' &&
        title.toLowerCase() === 'title'
      ) {
        continue;
      }

      manuscripts.push({
        manuscriptNumber,
        title,
        initialDateSubmitted,
        statusDate,
        currentStatus: currentStatus || folder.key,
        finalDisposition,
        revisionDueDate,
        folder: folder.key,
        folderCn: folder.cnLabel,
      });
    }

    return manuscripts;
  }, folderInfo);
}

/**
 * 登录 BOEG Editorial Manager 并抓取所有在审/已决稿件进度
 */
async function scrapeBoegStatus(config, options = {}) {
  if (!config.emUsername || !config.emPassword) {
    throw new Error(
      '尚未配置 Editorial Manager 登录用户名 (EM_USERNAME) 或密码 (EM_PASSWORD)。'
    );
  }

  const localExe = findLocalBrowserExecutable();
  const launchOptions = {
    headless: !options.headed,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  if (localExe) {
    launchOptions.executablePath = localExe;
  }

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (launchErr) {
    // 如果未找到本地浏览器且尚未安装 Playwright 内核，给出清晰指引
    throw new Error(
      `启动浏览器失败: ${launchErr.message}。如果在本地运行，请执行 npx playwright install chromium。`
    );
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // 1. 打开 BOEG Editorial Manager 首页
    await page.goto(config.emUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 2. 若弹出 OneTrust Cookie 提示框，礼貌点击关闭以免遮挡元素
    try {
      const cookieBtn = page.locator('#onetrust-accept-btn-handler');
      if (await cookieBtn.isVisible({ timeout: 3500 })) {
        await cookieBtn.click();
      }
    } catch (_) {
      // 无弹窗则直接继续
    }

    // 3. 定位嵌套在 iframe[name="content"] -> iframe[name="login"] 中的登录框
    let loginFrame = await findLoginFrame(page, 18000);
    if (!loginFrame) {
      // 备用方案：点击顶部导航栏 Login 链接加载登录框
      const topLoginLink = page.locator('a#Login, a[name="Login"]').first();
      if (await topLoginLink.count()) {
        await topLoginLink.click();
        loginFrame = await findLoginFrame(page, 15000);
      }
    }

    if (!loginFrame) {
      throw new Error(
        '未能在页面框架中找到 Editorial Manager 登录输入框，可能是网站维护中或网络超时。'
      );
    }

    // 4. 填入用户名密码并点击 Author Login（兼容点击后子 iframe 立即跳转销毁导致 Frame detached 的情况）
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.waitForTimeout(400);
        if (loginFrame.isDetached()) {
          loginFrame = await findLoginFrame(page, 8000);
          if (!loginFrame) break;
        }

        const userInput = loginFrame
          .locator('#username, input[name="username"]')
          .first();
        const passInput = loginFrame
          .locator('#passwordTextbox, input[name="password"], input[type="password"]')
          .first();
        const authorLoginBtn = loginFrame
          .locator('input[name="authorLogin"], input[value="Author Login"]')
          .first();

        await userInput.fill(config.emUsername, { timeout: 10000 });
        await passInput.fill(config.emPassword, { timeout: 10000 });
        await authorLoginBtn.click({ noWaitAfter: true, timeout: 10000 });
        break;
      } catch (clickErr) {
        const msg = String(clickErr.message || '');
        const isDetach =
          msg.includes('Frame was detached') ||
          msg.includes('Execution context was destroyed') ||
          msg.includes('Target closed');

        if (!isDetach || attempt === 2) {
          if (!isDetach) throw clickErr;
          break;
        }
        // 若是加载期间子 frame 重载导致 detach，短暂等待后检查是否仍在登录页并重试一次
        await page.waitForTimeout(1200);
        const stillHasLogin = await findLoginFrame(page, 2500);
        if (!stillHasLogin) break;
        loginFrame = stillHasLogin;
      }
    }

    // 5. 等待进入 Author Main Menu
    let menuFrame = await waitForAuthorMenuOrError(page, 35000);
    const menuFrameUrl = menuFrame.url();

    // 6. 扫描所有非空（计数 > 0）的稿件目录
    const activeFolders = await collectActiveFolders(menuFrame);
    const allManuscripts = [];

    for (let i = 0; i < activeFolders.length; i++) {
      const folder = activeFolders[i];

      // 如果不是第一个目录，先返回 Author Main Menu
      if (i > 0) {
        if (menuFrameUrl && menuFrameUrl.startsWith('http')) {
          await menuFrame.goto(menuFrameUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
        } else {
          const topMenu = page.locator('a:has-text("Author Main Menu")').first();
          if (await topMenu.count()) {
            await topMenu.click();
          }
          menuFrame = await waitForAuthorMenuOrError(page, 20000);
        }
      }

      // 进入目标稿件目录
      if (folder.resolvedUrl) {
        await menuFrame.goto(folder.resolvedUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 35000,
        });
      } else {
        await menuFrame
          .locator(`a:has-text("${folder.key}")`)
          .first()
          .click();
        await page.waitForTimeout(2500);
      }

      // 等待表格渲染完成
      await menuFrame
        .waitForSelector('table', { timeout: 15000 })
        .catch(() => null);
      await page.waitForTimeout(800);

      const items = await extractManuscriptsFromTable(menuFrame, folder);
      allManuscripts.push(...items);
    }

    await context.close();
    return {
      manuscripts: allManuscripts,
      activeFoldersChecked: activeFolders.map((f) => ({
        folder: f.key,
        cnLabel: f.cnLabel,
        count: f.count,
      })),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  scrapeBoegStatus,
};
