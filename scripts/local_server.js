const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { ROOT_DIR, loadConfig, saveEnvUpdates } = require('./config');
const { sendTestEmail } = require('./mailer');
const { runCheck, readPreviousData } = require('./check_status');

const DOCS_DIR = path.join(ROOT_DIR, 'docs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 256) {
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('无效的 JSON 格式'));
      }
    });
    req.on('error', reject);
  });
}

let isChecking = false;

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // 1. 本地模式探测与脱敏配置读取接口
    if (req.method === 'GET' && pathname === '/api/local-info') {
      const cfg = loadConfig();
      return sendJson(res, 200, {
        isLocalServer: true,
        isChecking,
        config: {
          emUrl: cfg.emUrl,
          journalName: cfg.journalName,
          emUsername: cfg.emUsername,
          hasEmPassword: Boolean(cfg.emPassword),
          smtpUser: cfg.smtpUser,
          hasSmtpPass: Boolean(cfg.smtpPass),
          smtpHost: cfg.smtpHost,
          smtpPort: cfg.smtpPort,
          smtpProvider: cfg.smtpProvider,
          notifyTo: cfg.notifyTo,
          dashboardUrl: cfg.dashboardUrl,
          hideManuscriptTitle: cfg.hideManuscriptTitle,
          notifyOnFirstRun: cfg.notifyOnFirstRun,
        },
      });
    }

    // 2. 保存本地 .env 配置接口
    if (req.method === 'POST' && pathname === '/api/save-config') {
      const body = await readJsonBody(req);
      saveEnvUpdates({
        EM_URL: body.emUrl,
        JOURNAL_NAME: body.journalName,
        EM_USERNAME: body.emUsername,
        EM_PASSWORD: body.emPassword,
        SMTP_USER: body.smtpUser,
        SMTP_PASS: body.smtpPass,
        NOTIFY_TO: body.notifyTo,
        SMTP_HOST: body.smtpHost || '',
        SMTP_PORT: body.smtpPort || '465',
        DASHBOARD_URL: body.dashboardUrl || '',
        HIDE_MANUSCRIPT_TITLE: Boolean(body.hideManuscriptTitle),
        NOTIFY_ON_FIRST_RUN: body.notifyOnFirstRun !== false,
      });
      const updated = loadConfig();
      return sendJson(res, 200, {
        ok: true,
        message: '配置已安全保存至本地 .env 文件！',
        smtpProvider: updated.smtpProvider,
        smtpHost: updated.smtpHost,
      });
    }

    // 3. 一键发送测试邮件接口
    if (req.method === 'POST' && pathname === '/api/test-email') {
      const cfg = loadConfig();
      await sendTestEmail(cfg);
      return sendJson(res, 200, {
        ok: true,
        message: `测试邮件已通过 ${cfg.smtpProvider} 成功发送至 ${cfg.notifyTo}！请去您的 Gmail 查看。`,
      });
    }

    // 4. 一键立即登录抓取 BOEG 进度接口
    if (req.method === 'POST' && pathname === '/api/check-now') {
      if (isChecking) {
        return sendJson(res, 409, {
          ok: false,
          message: '当前正在登录抓取中，请稍候片刻...',
        });
      }
      const body = await readJsonBody(req);
      isChecking = true;
      try {
        // 每次触发时动态重新加载模块，确保代码更新后无需重启服务即可生效
        for (const mod of ['./config', './mailer', './scraper', './check_status']) {
          try {
            delete require.cache[require.resolve(mod)];
          } catch (_) {}
        }
        const { runCheck: freshRunCheck } = require('./check_status');
        const result = await freshRunCheck({
          headed: Boolean(body.headed),
          forceEmail: Boolean(body.forceEmail),
        });
        return sendJson(res, 200, {
          ok: true,
          message: result.data.lastCheckMessage,
          data: result.data,
        });
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          message: err.message,
          data: readPreviousData(),
        });
      } finally {
        isChecking = false;
      }
    }

    // 5. 静态文件服务（复用 docs/ 目录，与 GitHub Pages 完全一致）
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(path.join(DOCS_DIR, relPath));
    if (!safePath.startsWith(DOCS_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }

    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.json' ? 'no-store' : 'no-cache',
    });
    fs.createReadStream(safePath).pipe(res);
  } catch (err) {
    sendJson(res, 500, { ok: false, message: err.message });
  }
});

function startServer(port = 3080) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3095) {
      startServer(port + 1);
    } else {
      console.error('启动本地服务失败:', err.message);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log('====================================================');
    console.log(`🚀 BOEG 论文投稿跟踪本地看板已启动: ${url}`);
    console.log('   在此网页中可直接填写账号授权码、测试发信到 Gmail、立即抓取进度');
    console.log('   按 Ctrl + C 可停止本地预览服务');
    console.log('====================================================');

    if (process.argv.includes('--open') && process.platform === 'win32') {
      exec(`start "" "${url}"`);
    }
  });
}

startServer(3080);
