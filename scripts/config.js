const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');
const DATA_PATH = path.join(ROOT_DIR, 'docs', 'data', 'status.json');

/**
 * 解析本地 .env 文件（不覆盖已存在的系统环境变量，兼容 GitHub Actions Secrets）
 */
function parseEnvFile(filePath = ENV_PATH) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx === -1) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    let val = cleaned.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * 根据发件邮箱后缀自动推断国内/国际主流 SMTP 服务器配置
 */
function inferSmtpSettings(smtpUser = '', explicitHost = '', explicitPort = '') {
  const domain = (smtpUser.split('@')[1] || '').toLowerCase().trim();
  const presets = {
    'qq.com': { host: 'smtp.qq.com', port: 465, secure: true, provider: 'QQ邮箱' },
    'vip.qq.com': { host: 'smtp.qq.com', port: 465, secure: true, provider: 'QQ VIP邮箱' },
    'foxmail.com': { host: 'smtp.qq.com', port: 465, secure: true, provider: 'Foxmail(QQ邮箱)' },
    '163.com': { host: 'smtp.163.com', port: 465, secure: true, provider: '网易163邮箱' },
    '126.com': { host: 'smtp.126.com', port: 465, secure: true, provider: '网易126邮箱' },
    'yeah.net': { host: 'smtp.yeah.net', port: 465, secure: true, provider: '网易Yeah邮箱' },
    'sina.com': { host: 'smtp.sina.com', port: 465, secure: true, provider: '新浪邮箱' },
    'sina.cn': { host: 'smtp.sina.com', port: 465, secure: true, provider: '新浪邮箱' },
    'aliyun.com': { host: 'smtp.aliyun.com', port: 465, secure: true, provider: '阿里邮箱' },
    '139.com': { host: 'smtp.139.com', port: 465, secure: true, provider: '移动139邮箱' },
    'gmail.com': { host: 'smtp.gmail.com', port: 465, secure: true, provider: 'Gmail' },
    'outlook.com': { host: 'smtp.office365.com', port: 587, secure: false, provider: 'Outlook' },
    'hotmail.com': { host: 'smtp.office365.com', port: 587, secure: false, provider: 'Hotmail' },
    'live.com': { host: 'smtp.office365.com', port: 587, secure: false, provider: 'Live邮箱' },
  };

  if (explicitHost && explicitHost.trim()) {
    const port = parseInt(explicitPort, 10) || 465;
    return {
      host: explicitHost.trim(),
      port,
      secure: port === 465,
      provider: '自定义SMTP',
    };
  }

  if (presets[domain]) {
    if (explicitPort && parseInt(explicitPort, 10)) {
      const p = parseInt(explicitPort, 10);
      return { ...presets[domain], port: p, secure: p === 465 };
    }
    return presets[domain];
  }

  const fallbackPort = parseInt(explicitPort, 10) || 465;
  return {
    host: domain ? `smtp.${domain}` : '',
    port: fallbackPort,
    secure: fallbackPort === 465,
    provider: domain || '未配置',
  };
}

/**
 * 清理邮箱 16 位授权码中常见的复制空格（如 "abcd efgh ijkl mnop"）
 */
function normalizeSmtpPass(rawPass = '') {
  const trimmed = rawPass.trim();
  if (/^[a-zA-Z0-9]{4}(\s+[a-zA-Z0-9]{4}){3}$/.test(trimmed)) {
    return trimmed.replace(/\s+/g, '');
  }
  return trimmed;
}

function loadConfig() {
  const fileEnv = parseEnvFile();
  const get = (key, fallback = '') => {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      return process.env[key];
    }
    if (fileEnv[key] !== undefined && fileEnv[key] !== '') {
      return fileEnv[key];
    }
    return fallback;
  };

  const smtpUser = get('SMTP_USER', '').trim();
  const smtpPass = normalizeSmtpPass(get('SMTP_PASS', ''));
  const smtp = inferSmtpSettings(smtpUser, get('SMTP_HOST', ''), get('SMTP_PORT', ''));

  return {
    emUrl: get('EM_URL', 'https://www.editorialmanager.com/boeg/default2.aspx').trim(),
    journalName: get(
      'JOURNAL_NAME',
      'Bulletin of Engineering Geology and the Environment (BOEG)'
    ).trim(),
    emUsername: get('EM_USERNAME', '').trim(),
    emPassword: get('EM_PASSWORD', ''),
    smtpUser,
    smtpPass,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecure: smtp.secure,
    smtpProvider: smtp.provider,
    notifyTo: get('NOTIFY_TO', '').trim(),
    dashboardUrl: get('DASHBOARD_URL', '').trim(),
    hideManuscriptTitle:
      String(get('HIDE_MANUSCRIPT_TITLE', 'false')).toLowerCase() === 'true',
    notifyOnFirstRun:
      String(get('NOTIFY_ON_FIRST_RUN', 'true')).toLowerCase() !== 'false',
    forceEmail: String(get('FORCE_EMAIL', 'false')).toLowerCase() === 'true',
  };
}

/**
 * 保存配置到本地 .env 文件（供本地可视化控制台调用）
 */
function saveEnvUpdates(updates = {}) {
  const existing = parseEnvFile();
  const merged = { ...existing };

  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) continue;
    // 如果前端未重新输入密码，保留原密码
    if ((k === 'EM_PASSWORD' || k === 'SMTP_PASS') && v === '__KEEP__') {
      continue;
    }
    merged[k] = String(v).trim();
  }

  const orderedKeys = [
    'EM_URL',
    'JOURNAL_NAME',
    'EM_USERNAME',
    'EM_PASSWORD',
    'SMTP_USER',
    'SMTP_PASS',
    'NOTIFY_TO',
    'SMTP_HOST',
    'SMTP_PORT',
    'DASHBOARD_URL',
    'HIDE_MANUSCRIPT_TITLE',
    'NOTIFY_ON_FIRST_RUN',
  ];

  const lines = [
    '# BOEG 科研论文投稿进度自动跟踪配置（仅保存在本地，已被 .gitignore 忽略）',
    `# 更新时间: ${new Date().toISOString()}`,
    '',
  ];

  const seen = new Set();
  for (const key of orderedKeys) {
    seen.add(key);
    const val = merged[key] !== undefined ? merged[key] : '';
    const needsQuote = /[\s#"']/.test(val);
    lines.push(`${key}=${needsQuote ? JSON.stringify(val) : val}`);
  }

  for (const [key, val] of Object.entries(merged)) {
    if (seen.has(key)) continue;
    const needsQuote = /[\s#"']/.test(val);
    lines.push(`${key}=${needsQuote ? JSON.stringify(val) : val}`);
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

/**
 * Editorial Manager 状态中文学术解读与阶段映射（1~6 步进度条）
 */
function explainStatus(status = '', folder = '', finalDisposition = '') {
  const s = `${status} ${finalDisposition}`.toLowerCase().trim();
  const f = (folder || '').toLowerCase();

  if (f.includes('sent back to author') || s.includes('sent back')) {
    return {
      stageIndex: 1,
      stageLabel: '退回修改格式',
      badgeColor: 'warning',
      cnTitle: '退回作者补充/修改格式',
      explanation:
        '编辑部在技术审查阶段将稿件退回（常见原因：缺少伦理/利益冲突声明、字数或图表格式要求等），尚未进入正式审稿，请登录系统查看邮件说明并重新提交。',
    };
  }
  if (f.includes('waiting for author') || s.includes('approve')) {
    return {
      stageIndex: 1,
      stageLabel: '待确认PDF',
      badgeColor: 'warning',
      cnTitle: '等待作者批准生成 PDF',
      explanation:
        '稿件或修回稿已生成预览 PDF，正在等待通讯作者在系统中点击 Approve 正式完成提交。',
    };
  }
  if (s.includes('accept') || (f.includes('decision') && s.includes('accept'))) {
    return {
      stageIndex: 6,
      stageLabel: '正式录用',
      badgeColor: 'success',
      cnTitle: '恭喜！稿件已正式录用 (Accepted)',
      explanation:
        '您的论文已被 BOEG 正式接收！后续将收到 Springer Nature 出版生产邮件（版权协议、校样 Proof 及 Online First 上线通知）。',
    };
  }
  if (
    s.includes('reject') ||
    s.includes('decline') ||
    s.includes('transfer') ||
    s.includes('withdraw')
  ) {
    return {
      stageIndex: 6,
      stageLabel: '审稿结束',
      badgeColor: 'danger',
      cnTitle: '审稿决定已出（未录用 / 建议转投）',
      explanation:
        '期刊已完成本轮裁决，请登录 Editorial Manager 或查收通讯作者邮件获取详细审稿意见。',
    };
  }
  if (
    f.includes('needing revision') ||
    s.includes('revise') ||
    s.includes('major revision') ||
    s.includes('minor revision')
  ) {
    return {
      stageIndex: 5,
      stageLabel: '需要修回',
      badgeColor: 'warning',
      cnTitle: '编辑给出修改决定（请准备修回稿）',
      explanation:
        '审稿意见已返回且编辑给予修改机会（大修/小修），请登录系统查看审稿人具体意见，并在截止日期前上传逐条回复信（Response Letter）与修改稿。',
    };
  }
  if (s.includes('decision in process') || s.includes('decision pending')) {
    return {
      stageIndex: 5,
      stageLabel: '编辑裁决中',
      badgeColor: 'purple',
      cnTitle: '编辑正在做审稿裁决 (Decision in Process)',
      explanation:
        '处理编辑/主编正在综合外审意见（或初审评估）撰写最终决定，通常几天到两周内会出审稿结果。',
    };
  }
  if (s.includes('required reviews completed') || s.includes('reviews completed')) {
    return {
      stageIndex: 4,
      stageLabel: '外审意见齐备',
      badgeColor: 'info',
      cnTitle: '已收回足够数量的外审意见 (Required Reviews Completed)',
      explanation:
        '已有满足期刊最低数量要求的审稿人提交了审稿报告，系统已通知处理编辑评估（若编辑邀请了更多审稿人，也可能继续等待其余意见）。',
    };
  }
  if (s.includes('under review')) {
    return {
      stageIndex: 3,
      stageLabel: '同行外审中',
      badgeColor: 'primary',
      cnTitle: '同行专家外审中 (Under Review)',
      explanation:
        '至少已有审稿专家接受邀请并正在审阅论文。注：若状态维持 Under Review 但 Status Date 更新，通常代表有新审稿人接受邀请，或某位审稿人已提交审稿报告。',
    };
  }
  if (s.includes('reviewer') && s.includes('invited')) {
    return {
      stageIndex: 3,
      stageLabel: '邀请审稿人',
      badgeColor: 'primary',
      cnTitle: '已发出外审邀请 (Reviewers Invited)',
      explanation:
        '处理编辑已向潜在审稿专家发送邀请邮件，正在等待审稿人点击接受邀请。',
    };
  }
  if (
    s.includes('with editor') ||
    s.includes('editor assigned') ||
    s.includes('editor invited')
  ) {
    return {
      stageIndex: 2,
      stageLabel: '编辑处理中',
      badgeColor: 'info',
      cnTitle: '稿件在编辑手中 (With Editor / Editor Assigned)',
      explanation:
        '稿件已通过形式审查并分配给主编或副主编（AE），编辑正在初审稿件创新性与期刊契合度，并准备物色审稿专家。',
    };
  }
  if (s.includes('submitted to journal') || s.includes('revision submitted')) {
    return {
      stageIndex: 1,
      stageLabel: '已提交待审',
      badgeColor: 'neutral',
      cnTitle: '已提交至期刊办公室 (Submitted to Journal)',
      explanation:
        '稿件已成功投递至期刊编辑部，正在进行初步技术/格式检查与分配稿件编号。',
    };
  }

  return {
    stageIndex: 2,
    stageLabel: status || '处理中',
    badgeColor: 'info',
    cnTitle: status || '期刊处理中',
    explanation:
      '系统正在正常记录该状态，当状态名称或状态日期（Status Date）发生任何变化时将第一时间邮件通知您。',
  };
}

function hashText(text = '') {
  return crypto
    .createHash('sha256')
    .update(String(text).trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function maskTitle(title = '') {
  const clean = String(title).trim();
  if (!clean) return '（未命名稿件）';
  if (clean.length <= 16) return clean.slice(0, 6) + '*** [隐私保护已开启]';
  return clean.slice(0, 16) + '... *** [隐私保护已开启]';
}

module.exports = {
  ROOT_DIR,
  ENV_PATH,
  DATA_PATH,
  loadConfig,
  saveEnvUpdates,
  inferSmtpSettings,
  explainStatus,
  hashText,
  maskTitle,
};
