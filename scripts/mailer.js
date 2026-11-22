const nodemailer = require('nodemailer');
const { explainStatus } = require('./config');

function createTransporter(config) {
  if (!config.smtpUser || !config.smtpPass) {
    throw new Error(
      '尚未配置发件邮箱账号 (SMTP_USER) 或授权码 (SMTP_PASS)，请先在配置中填写（如 QQ 邮箱 / 163 邮箱及 16 位授权码）。'
    );
  }
  if (!config.notifyTo) {
    throw new Error('尚未配置接收通知的目标邮箱 (NOTIFY_TO)，请填入您的 Gmail 邮箱地址。');
  }
  if (!config.smtpHost) {
    throw new Error('无法识别发件邮箱的 SMTP 服务器地址，请补充配置 SMTP_HOST。');
  }

  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBeijingTime(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * 发送测试邮件（验证国内邮箱 -> Gmail 投递是否畅通）
 */
async function sendTestEmail(config) {
  const transporter = createTransporter(config);
  const nowStr = formatBeijingTime();

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:640px;margin:0 auto;padding:24px;background:#f8fafc;color:#0f172a;">
    <div style="background:#ffffff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;box-shadow:0 4px 12px rgba(15,23,42,0.04);">
      <div style="display:inline-block;padding:4px 12px;border-radius:999px;background:#dcfce7;color:#166534;font-size:13px;font-weight:600;margin-bottom:14px;">
        ✅ 邮件通知通道测试成功
      </div>
      <h2 style="margin:0 0 12px;font-size:20px;color:#0f172a;">BOEG 论文投稿进度自动跟踪系统已连通</h2>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:#475569;">
        恭喜！您通过 <strong>${escapeHtml(config.smtpProvider)} (${escapeHtml(config.smtpUser)})</strong> 发往 <strong>${escapeHtml(config.notifyTo)}</strong> 的邮件链路工作正常。当您的论文在 Editorial Manager 出现状态变更或审稿日期跳动时，系统将自动发送邮件通知您。
      </p>
      <div style="background:#f1f5f9;border-radius:10px;padding:16px;font-size:13px;line-height:1.8;color:#334155;">
        <div><strong>监控期刊：</strong>${escapeHtml(config.journalName)}</div>
        <div><strong>投稿入口：</strong><a href="${escapeHtml(config.emUrl)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(config.emUrl)}</a></div>
        <div><strong>测试时间：</strong>${escapeHtml(nowStr)} (北京时间)</div>
      </div>
      ${
        config.dashboardUrl
          ? `<div style="margin-top:20px;"><a href="${escapeHtml(config.dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;">查看投稿进度看板</a></div>`
          : ''
      }
    </div>
  </div>`;

  const info = await transporter.sendMail({
    from: `"BOEG 论文进度助手" <${config.smtpUser}>`,
    to: config.notifyTo,
    subject: `【测试成功】BOEG 科研论文投稿自动跟踪通知已就绪`,
    text: `BOEG 论文投稿进度自动跟踪系统测试成功！\n监控期刊: ${config.journalName}\n测试时间: ${nowStr} (北京时间)`,
    html,
  });

  return info;
}

/**
 * 发送投稿进展变更通知（或强制汇总通知）
 */
async function sendProgressEmail(config, changes = [], rawManuscripts = [], options = {}) {
  const transporter = createTransporter(config);
  const nowStr = formatBeijingTime();
  const isManualSummary = Boolean(options.isManualSummary && changes.length === 0);

  let subject = `【投稿进展更新】您的 BOEG 论文状态有新动态`;
  if (changes.length > 0) {
    const primary = changes[0];
    const msNum = primary.manuscriptNumber ? `[${primary.manuscriptNumber}] ` : '';
    if (primary.changeType === 'FIRST_TRACKED') {
      subject = `【监控已开启】${msNum}当前状态: ${primary.newStatus || primary.newFolder}`;
    } else if (primary.changeType === 'STATUS_CHANGED') {
      subject = `【状态更新】${msNum}已变为: ${primary.newStatus}`;
    } else if (primary.changeType === 'DATE_CHANGED') {
      subject = `【审稿日期变动】${msNum}${primary.newStatus} (${primary.newStatusDate})`;
    } else if (primary.changeType === 'NUMBER_ASSIGNED') {
      subject = `【已分配稿号】您的 BOEG 论文已分配编号 ${primary.manuscriptNumber}`;
    } else {
      subject = `【投稿新进展】${msNum}${primary.summary}`;
    }
  } else if (isManualSummary) {
    const first = rawManuscripts[0];
    subject = first
      ? `【当前进度汇总】${first.manuscriptNumber || 'BOEG稿件'}: ${first.currentStatus}`
      : `【当前进度汇总】BOEG 投稿系统巡检正常（暂无在审稿件）`;
  }

  const changeTypeLabels = {
    FIRST_TRACKED: { text: '🎉 首次接入自动监控', bg: '#dbeafe', color: '#1e40af' },
    STATUS_CHANGED: { text: '🚀 审稿状态更新', bg: '#dcfce7', color: '#166534' },
    DATE_CHANGED: { text: '📅 状态日期更新 (审稿人动态)', bg: '#fef3c7', color: '#92400e' },
    FOLDER_CHANGED: { text: '📂 稿件所在目录变更', bg: '#ede9fe', color: '#5b21b6' },
    NUMBER_ASSIGNED: { text: '🔖 正式分配稿件编号', bg: '#dcfce7', color: '#166534' },
    DISPOSITION_CHANGED: { text: '⚖️ 最终裁决更新', bg: '#fce7f3', color: '#9d174d' },
  };

  const changeCardsHtml = changes
    .map((ch) => {
      const badge = changeTypeLabels[ch.changeType] || {
        text: '🔔 进展变动',
        bg: '#e0f2fe',
        color: '#0369a1',
      };
      const info = explainStatus(ch.newStatus, ch.newFolder, ch.finalDisposition);
      return `
      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:16px;background:#ffffff;">
        <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${badge.bg};color:${badge.color};font-size:12px;font-weight:600;margin-bottom:10px;">
          ${escapeHtml(badge.text)}
        </div>
        <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:6px;">
          ${escapeHtml(ch.manuscriptNumber || '待分配稿号')} · ${escapeHtml(ch.rawTitle || ch.title)}
        </div>
        <div style="font-size:14px;color:#1e293b;margin-bottom:12px;font-weight:600;">
          ${escapeHtml(ch.summary)}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155;background:#f8fafc;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;width:110px;color:#64748b;">当前状态</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#0f172a;">
              ${ch.oldStatus && ch.oldStatus !== ch.newStatus ? `<span style="color:#94a3b8;text-decoration:line-through;margin-right:6px;">${escapeHtml(ch.oldStatus)}</span> → ` : ''}
              <span style="color:#2563eb;">${escapeHtml(ch.newStatus || '—')}</span>
              ${ch.finalDisposition ? ` (${escapeHtml(ch.finalDisposition)})` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;">状态日期</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">
              ${ch.oldStatusDate && ch.oldStatusDate !== ch.newStatusDate ? `<span style="color:#94a3b8;text-decoration:line-through;margin-right:6px;">${escapeHtml(ch.oldStatusDate)}</span> → ` : ''}
              <strong>${escapeHtml(ch.newStatusDate || '—')}</strong>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;">所在目录</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(ch.newFolder || '—')}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;color:#64748b;">初次投稿日</td>
            <td style="padding:8px 12px;">${escapeHtml(ch.initialDateSubmitted || '—')}${ch.revisionDueDate ? ` ｜ 修回截止：<strong>${escapeHtml(ch.revisionDueDate)}</strong>` : ''}</td>
          </tr>
        </table>
        <div style="margin-top:12px;padding:10px 12px;background:#eff6ff;border-left:3px solid #3b82f6;border-radius:4px;font-size:12.5px;color:#1e3a8a;line-height:1.6;">
          <strong>💡 阶段解读（${escapeHtml(info.cnTitle)}）：</strong>${escapeHtml(info.explanation)}
        </div>
      </div>`;
    })
    .join('');

  const summaryTableHtml =
    changes.length === 0 && rawManuscripts.length > 0
      ? rawManuscripts
          .map((m) => {
            const info = explainStatus(m.currentStatus, m.folder, m.finalDisposition);
            return `
            <div style="border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:14px;background:#ffffff;">
              <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:8px;">
                ${escapeHtml(m.manuscriptNumber || '待分配稿号')} · ${escapeHtml(m.title)}
              </div>
              <div style="font-size:13px;line-height:1.8;color:#334155;">
                <div><strong>当前状态：</strong><span style="color:#2563eb;font-weight:600;">${escapeHtml(m.currentStatus || '—')}</span></div>
                <div><strong>状态日期：</strong>${escapeHtml(m.statusDate || '—')}</div>
                <div><strong>所在目录：</strong>${escapeHtml(m.folder || '—')}</div>
                <div><strong>阶段解读：</strong>${escapeHtml(info.explanation)}</div>
              </div>
            </div>`;
          })
          .join('')
      : '';

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:660px;margin:0 auto;padding:24px;background:#f8fafc;color:#0f172a;">
    <div style="background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e2e8f0;box-shadow:0 4px 14px rgba(15,23,42,0.04);">
      <div style="font-size:12px;font-weight:600;color:#2563eb;letter-spacing:0.04em;margin-bottom:6px;">
        ${escapeHtml(config.journalName)}
      </div>
      <h2 style="margin:0 0 16px;font-size:20px;color:#0f172a;">
        ${changes.length > 0 ? '📬 检测到您的科研论文有最新进展' : '📋 当前投稿进度巡检汇总'}
      </h2>
      ${changeCardsHtml}
      ${summaryTableHtml}
      <div style="margin-top:22px;display:flex;gap:12px;flex-wrap:wrap;">
        ${
          config.dashboardUrl
            ? `<a href="${escapeHtml(config.dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600;margin-right:10px;">📊 打开可视化进度看板</a>`
            : ''
        }
        <a href="${escapeHtml(config.emUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600;">🔗 登录 BOEG 投稿系统</a>
      </div>
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;">
        巡检时间：${escapeHtml(nowStr)} (北京时间) · 自动跟踪助手生成
      </div>
    </div>
  </div>`;

  const plainLines = [
    `${config.journalName} - 投稿进度通知`,
    `巡检时间: ${nowStr} (北京时间)`,
    '',
  ];
  for (const ch of changes) {
    plainLines.push(
      `稿件: ${ch.manuscriptNumber || '待分配稿号'} | ${ch.rawTitle || ch.title}`,
      `变动: ${ch.summary}`,
      `当前状态: ${ch.newStatus} | 状态日期: ${ch.newStatusDate} | 目录: ${ch.newFolder}`,
      ''
    );
  }
  plainLines.push(`登录系统查看: ${config.emUrl}`);
  if (config.dashboardUrl) plainLines.push(`进度看板: ${config.dashboardUrl}`);

  return transporter.sendMail({
    from: `"BOEG 论文进度助手" <${config.smtpUser}>`,
    to: config.notifyTo,
    subject,
    text: plainLines.join('\n'),
    html,
  });
}

module.exports = {
  sendTestEmail,
  sendProgressEmail,
  formatBeijingTime,
};
