(function () {
  const STAGE_STEPS = [
    { index: 1, name: '提交待审' },
    { index: 2, name: '编辑初审' },
    { index: 3, name: '同行外审' },
    { index: 4, name: '意见返回' },
    { index: 5, name: '裁决/修回' },
    { index: 6, name: '最终决定' },
  ];

  let isLocalMode = false;
  let localSavedHasEmPass = false;
  let localSavedHasSmtpPass = false;

  const el = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '暂无记录';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return isoStr;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  }

  function calcDaysSince(dateStr) {
    if (!dateStr) return null;
    const parsed = new Date(dateStr);
    if (Number.isNaN(parsed.getTime())) return null;
    const diffMs = Date.now() - parsed.getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return days >= 0 ? days : 0;
  }

  function showFeedback(msg, type = 'ok') {
    const box = el('localActionFeedback');
    if (!box) return;
    box.className = `action-feedback feedback-${type}`;
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function renderBanner(data) {
    const banner = el('statusBanner');
    const summary = el('lastCheckSummary');
    const timeEl = el('lastCheckTime');

    banner.className = 'status-banner';
    if (data.lastCheckStatus === 'OK') {
      banner.classList.add('status-ok');
    } else if (data.lastCheckStatus === 'UPDATED') {
      banner.classList.add('status-updated');
    } else if (data.lastCheckStatus === 'ERROR' || data.lastCheckStatus === 'WARNING') {
      banner.classList.add('status-error');
    }

    if (data.journalName) {
      el('journalTitle').textContent = data.journalName;
    }
    if (data.emUrl) {
      el('emPortalLink').href = data.emUrl;
    }

    summary.textContent = data.lastCheckMessage || '等待首次自动检查';
    timeEl.textContent = data.lastCheckedAt
      ? `最近检查时间：${formatDateTime(data.lastCheckedAt)} (北京时间) · 云端定时：每日 09:35 / 21:35`
      : '云端定时计划：每日北京时间 09:35 与 21:35 自动登录检查';
  }

  function renderManuscripts(manuscripts = []) {
    const container = el('manuscriptsContainer');
    if (!manuscripts.length) {
      container.innerHTML = `
        <div class="card empty-state">
          <div class="empty-icon">📄</div>
          <h3 style="margin:0 0 8px;color:#0f172a;">暂未展示在审稿件数据</h3>
          <p style="max-width:560px;margin:0 auto;font-size:13.5px;">
            ${
              isLocalMode
                ? '请在上方「本地配置与一键连通测试中心」填入您的 BOEG 用户名密码及国内发件邮箱授权码，点击「立即登录抓取进度」即可立刻同步您的论文状态！'
                : '当 GitHub Actions 完成首次定时或手动检查后，您的 BOEG 论文实时审稿进度、阶段持续天数与历史时间轴将自动展示在此处。'
            }
          </p>
        </div>`;
      return;
    }

    container.innerHTML = manuscripts
      .map((m) => {
        const totalDays = calcDaysSince(m.initialDateSubmitted);
        const statusDays = calcDaysSince(m.statusDate);
        const activeStage = m.stageIndex || 2;
        const pillClass = `pill-${m.badgeColor || 'primary'}`;

        const stepperHtml = STAGE_STEPS.map((st) => {
          const cls =
            st.index === activeStage
              ? 'step-item active'
              : st.index < activeStage
              ? 'step-item done'
              : 'step-item';
          return `
            <div class="${cls}">
              <div class="step-num">STEP ${st.index}</div>
              <div class="step-name">${escapeHtml(st.name)}</div>
            </div>`;
        }).join('');

        return `
        <article class="ms-card">
          <div class="ms-header">
            <div>
              <div class="ms-id-row">
                <span class="ms-number">${escapeHtml(m.manuscriptNumber || '待分配稿号')}</span>
                <span class="ms-folder">📂 ${escapeHtml(m.folderCn || m.folder || 'Submissions')}</span>
                ${
                  m.revisionDueDate
                    ? `<span class="ms-folder" style="border-color:#fcd34d;background:#fffbeb;color:#b45309;">⏰ 修回截止: ${escapeHtml(m.revisionDueDate)}</span>`
                    : ''
                }
              </div>
              <h2 class="ms-title">${escapeHtml(m.title)}</h2>
            </div>
            <div class="status-pill ${pillClass}">
              ${escapeHtml(m.currentStatus || 'Unknown')}
            </div>
          </div>

          <div class="stepper">${stepperHtml}</div>

          <div class="metrics-grid">
            <div class="metric-box">
              <div class="metric-label">最新状态日期 (Status Date)</div>
              <div class="metric-value">${escapeHtml(m.statusDate || '—')}</div>
              <div class="metric-sub">${
                statusDays !== null ? `当前日期已维持 ${statusDays} 天` : '等待系统日期'
              }</div>
            </div>
            <div class="metric-box">
              <div class="metric-label">初次投稿日期</div>
              <div class="metric-value">${escapeHtml(m.initialDateSubmitted || '—')}</div>
              <div class="metric-sub">${
                totalDays !== null ? `投稿至今共 ${totalDays} 天` : '—'
              }</div>
            </div>
            <div class="metric-box">
              <div class="metric-label">状态名称变更次数</div>
              <div class="metric-value">${Number(m.statusChangeCount || 0)} 次</div>
              <div class="metric-sub">跨阶段进展跃迁计数</div>
            </div>
            <div class="metric-box">
              <div class="metric-label">同状态日期跳动次数</div>
              <div class="metric-value">${Number(m.dateChangeCount || 0)} 次</div>
              <div class="metric-sub">捕捉审稿人接受/完成动态</div>
            </div>
          </div>

          <div class="explain-box">
            <strong>💡 当前阶段解读（${escapeHtml(m.cnTitle || m.currentStatus)}）：</strong>
            ${escapeHtml(m.explanation || '')}
          </div>
        </article>`;
      })
      .join('');
  }

  function renderTimeline(history = []) {
    const container = el('timelineContainer');
    if (!history.length) {
      container.innerHTML = `<div style="color:#94a3b8;font-size:13.5px;padding:12px 0;">暂无状态变更记录，首次抓取后将自动建立基线。</div>`;
      return;
    }

    container.innerHTML = history
      .slice(0, 30)
      .map((item) => {
        return `
        <div class="tl-item">
          <div class="tl-time">${escapeHtml(formatDateTime(item.timestamp))}</div>
          <div class="tl-title">
            ${escapeHtml(item.manuscriptNumber ? `[${item.manuscriptNumber}] ` : '')}${escapeHtml(item.summary)}
          </div>
          <div class="tl-meta">
            状态：<strong>${escapeHtml(item.newStatus || '—')}</strong> · 状态日期：${escapeHtml(item.newStatusDate || '—')} · 目录：${escapeHtml(item.newFolder || '—')}
          </div>
        </div>`;
      })
      .join('');
  }

  function renderLogs(logs = []) {
    const container = el('logsContainer');
    if (!logs.length) {
      container.innerHTML = `<div style="color:#94a3b8;font-size:13px;">尚无运行日志</div>`;
      return;
    }

    container.innerHTML = logs
      .slice(0, 15)
      .map((log) => {
        const icon = log.ok ? (log.changesCount > 0 ? '🔔' : '✅') : '❌';
        return `
        <div class="log-row">
          <div>${icon} ${escapeHtml(log.message)}</div>
          <div class="log-time">${escapeHtml(formatDateTime(log.timestamp))}</div>
        </div>`;
      })
      .join('');
  }

  async function loadStatusData() {
    try {
      const resp = await fetch(`./data/status.json?t=${Date.now()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderBanner(data);
      renderManuscripts(data.manuscripts || []);
      renderTimeline(data.history || []);
      renderLogs(data.checkLogs || []);
    } catch (err) {
      el('lastCheckSummary').textContent = `读取状态数据失败: ${err.message}`;
    }
  }

  async function detectLocalMode() {
    if (
      window.location.hostname !== '127.0.0.1' &&
      window.location.hostname !== 'localhost'
    ) {
      return;
    }

    try {
      const resp = await fetch('/api/local-info');
      if (!resp.ok) return;
      const info = await resp.json();
      if (!info.isLocalServer) return;

      isLocalMode = true;
      el('btnOpenLocalConfig').classList.remove('hidden');
      el('btnLocalCheckNow').classList.remove('hidden');

      const cfg = info.config || {};
      el('cfgEmUrl').value = cfg.emUrl || 'https://www.editorialmanager.com/boeg/default2.aspx';
      el('cfgEmUsername').value = cfg.emUsername || '';
      el('cfgSmtpUser').value = cfg.smtpUser || '';
      el('cfgNotifyTo').value = cfg.notifyTo || '';
      el('cfgHideTitle').checked = Boolean(cfg.hideManuscriptTitle);

      localSavedHasEmPass = Boolean(cfg.hasEmPassword);
      localSavedHasSmtpPass = Boolean(cfg.hasSmtpPass);

      if (localSavedHasEmPass) {
        el('cfgEmPassword').placeholder = '已保存密码（留空则保持原密码不变）';
        el('emPassHint').textContent = '✅ 本地已保存登录密码';
      }
      if (localSavedHasSmtpPass) {
        el('cfgSmtpPass').placeholder = '已保存授权码（留空则保持原授权码不变）';
        el('smtpPassHint').textContent = `✅ 已识别发信通道：${cfg.smtpProvider} (${cfg.smtpHost}:${cfg.smtpPort})`;
      }

      // 如果还没配置账号，自动展开配置抽屉方便首次填写
      if (!cfg.emUsername || !cfg.smtpUser || !cfg.notifyTo) {
        el('localConfigPanel').classList.remove('hidden');
      }
    } catch (_) {
      // 静态托管环境直接忽略
    }
  }

  async function saveLocalConfig(silent = false) {
    const rawEmPass = el('cfgEmPassword').value;
    const rawSmtpPass = el('cfgSmtpPass').value;

    const payload = {
      emUrl: el('cfgEmUrl').value.trim(),
      emUsername: el('cfgEmUsername').value.trim(),
      emPassword: rawEmPass ? rawEmPass : localSavedHasEmPass ? '__KEEP__' : '',
      smtpUser: el('cfgSmtpUser').value.trim(),
      smtpPass: rawSmtpPass ? rawSmtpPass : localSavedHasSmtpPass ? '__KEEP__' : '',
      notifyTo: el('cfgNotifyTo').value.trim(),
      hideManuscriptTitle: el('cfgHideTitle').checked,
    };

    const resp = await fetch('/api/save-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const resJson = await resp.json();
    if (!resp.ok || !resJson.ok) {
      throw new Error(resJson.message || '保存配置失败');
    }

    if (rawEmPass) {
      localSavedHasEmPass = true;
      el('cfgEmPassword').value = '';
      el('cfgEmPassword').placeholder = '已保存密码（留空则保持原密码不变）';
      el('emPassHint').textContent = '✅ 本地已保存登录密码';
    }
    if (rawSmtpPass) {
      localSavedHasSmtpPass = true;
      el('cfgSmtpPass').value = '';
      el('cfgSmtpPass').placeholder = '已保存授权码（留空则保持原授权码不变）';
      el('smtpPassHint').textContent = `✅ 已识别发信通道：${resJson.smtpProvider} (${resJson.smtpHost})`;
    }

    if (!silent) {
      showFeedback(
        `${resJson.message}（发件服务器已自动匹配为 ${resJson.smtpProvider}: ${resJson.smtpHost}）`,
        'ok'
      );
    }
  }

  async function triggerLocalCheck(options = {}) {
    try {
      if (!el('localConfigPanel').classList.contains('hidden')) {
        await saveLocalConfig(true);
      }
      showFeedback(
        options.headed
          ? '⏳ 正在弹出浏览器自动登录 BOEG 抓取稿件进度，请勿关闭新弹出的浏览器窗口...'
          : '⏳ 正在后台无头登录 BOEG Editorial Manager 抓取最新进度（约需 10~25 秒）...',
        'loading'
      );
      el('btnLocalCheckNow').disabled = true;

      const resp = await fetch('/api/check-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });
      const resJson = await resp.json();
      await loadStatusData();

      if (!resp.ok || !resJson.ok) {
        showFeedback(`❌ 抓取失败：${resJson.message}`, 'err');
      } else {
        showFeedback(`✅ ${resJson.message}`, 'ok');
      }
    } catch (err) {
      showFeedback(`❌ 请求出错：${err.message}`, 'err');
    } finally {
      el('btnLocalCheckNow').disabled = false;
    }
  }

  function bindEvents() {
    el('btnRefreshData').addEventListener('click', () => loadStatusData());

    el('btnOpenLocalConfig').addEventListener('click', () => {
      el('localConfigPanel').classList.toggle('hidden');
    });

    el('btnCloseConfig').addEventListener('click', () => {
      el('localConfigPanel').classList.add('hidden');
    });

    el('configForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await saveLocalConfig(false);
      } catch (err) {
        showFeedback(`❌ ${err.message}`, 'err');
      }
    });

    el('btnTestEmail').addEventListener('click', async () => {
      const btn = el('btnTestEmail');
      btn.disabled = true;
      try {
        await saveLocalConfig(true);
        showFeedback('⏳ 正在通过国内邮箱向您的 Gmail 发送测试邮件...', 'loading');
        const resp = await fetch('/api/test-email', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.message || '发送失败');
        showFeedback(`✅ ${data.message}`, 'ok');
      } catch (err) {
        showFeedback(`❌ 邮件测试失败：${err.message}`, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    el('btnLocalCheckNow').addEventListener('click', () =>
      triggerLocalCheck({ headed: false, forceEmail: false })
    );
    el('btnCheckHeaded').addEventListener('click', () =>
      triggerLocalCheck({ headed: true, forceEmail: false })
    );
    el('btnCheckAndMail').addEventListener('click', () =>
      triggerLocalCheck({ headed: false, forceEmail: true })
    );
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    await detectLocalMode();
    await loadStatusData();
  });
})();
