const fs = require('fs');
const path = require('path');
const {
  DATA_PATH,
  loadConfig,
  explainStatus,
  hashText,
  maskTitle,
} = require('./config');
const { scrapeBoegStatus } = require('./scraper');
const { sendTestEmail, sendProgressEmail } = require('./mailer');

function readPreviousData() {
  if (!fs.existsSync(DATA_PATH)) {
    return {
      journalName: 'Bulletin of Engineering Geology and the Environment (BOEG)',
      emUrl: 'https://www.editorialmanager.com/boeg/default2.aspx',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastCheckStatus: 'NEVER_RUN',
      lastCheckMessage: '等待首次自动检查',
      manuscripts: [],
      history: [],
      checkLogs: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (_) {
    return {
      journalName: 'Bulletin of Engineering Geology and the Environment (BOEG)',
      emUrl: 'https://www.editorialmanager.com/boeg/default2.aspx',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastCheckStatus: 'NEVER_RUN',
      lastCheckMessage: '等待首次自动检查',
      manuscripts: [],
      history: [],
      checkLogs: [],
    };
  }
}

function writeStatusData(data) {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 智能匹配同一篇论文（兼容刚投稿时暂未分配 BOEG-D-... 稿号、随后分配正式稿号的场景）
 */
function findMatchingPrevManuscript(prevList = [], rawItem, titleHash) {
  if (rawItem.manuscriptNumber) {
    const byNum = prevList.find(
      (p) => p.manuscriptNumber && p.manuscriptNumber === rawItem.manuscriptNumber
    );
    if (byNum) return byNum;
  }
  if (titleHash) {
    const byTitle = prevList.find((p) => p.titleHash && p.titleHash === titleHash);
    if (byTitle) return byTitle;
  }
  // 如果之前只有唯一一篇未分配稿号的稿件，且现在只有一篇分配了稿号的稿件
  if (rawItem.manuscriptNumber && prevList.length === 1 && !prevList[0].manuscriptNumber) {
    return prevList[0];
  }
  return null;
}

/**
 * 执行一次完整的状态巡检、对比、数据持久化与邮件通知
 */
async function runCheck(options = {}) {
  const config = loadConfig();
  const prevData = readPreviousData();
  const nowIso = new Date().toISOString();
  const forceEmail = Boolean(options.forceEmail || config.forceEmail);

  try {
    console.log(`[${nowIso}] 正在登录检查: ${config.emUrl} ...`);
    const scrapeResult = await scrapeBoegStatus(config, {
      headed: Boolean(options.headed),
    });

    const rawManuscripts = scrapeResult.manuscripts || [];
    const changes = [];
    const nextManuscripts = [];

    for (const raw of rawManuscripts) {
      const titleHash = hashText(raw.title || raw.manuscriptNumber || '');
      const displayTitle = config.hideManuscriptTitle
        ? maskTitle(raw.title)
        : raw.title || '（无标题）';

      const prev = findMatchingPrevManuscript(prevData.manuscripts, raw, titleHash);
      const statusMeta = explainStatus(
        raw.currentStatus,
        raw.folder,
        raw.finalDisposition
      );

      let statusChangeCount = prev ? prev.statusChangeCount || 0 : 0;
      let dateChangeCount = prev ? prev.dateChangeCount || 0 : 0;
      let lastChangedAt = prev ? prev.lastChangedAt || nowIso : nowIso;

      if (!prev) {
        // 首次发现该稿件
        changes.push({
          id: `${nowIso}_${raw.manuscriptNumber || titleHash}`,
          timestamp: nowIso,
          changeType: 'FIRST_TRACKED',
          manuscriptNumber: raw.manuscriptNumber,
          title: displayTitle,
          rawTitle: raw.title,
          oldStatus: '',
          newStatus: raw.currentStatus,
          oldStatusDate: '',
          newStatusDate: raw.statusDate,
          oldFolder: '',
          newFolder: raw.folder,
          initialDateSubmitted: raw.initialDateSubmitted,
          revisionDueDate: raw.revisionDueDate,
          finalDisposition: raw.finalDisposition,
          summary: `首次纳入监控：当前状态为「${raw.currentStatus}」(${raw.statusDate || '无日期'})`,
        });
      } else {
        // 1. 检查是否新分配了正式稿号
        if (!prev.manuscriptNumber && raw.manuscriptNumber) {
          statusChangeCount++;
          lastChangedAt = nowIso;
          changes.push({
            id: `${nowIso}_${raw.manuscriptNumber}_num`,
            timestamp: nowIso,
            changeType: 'NUMBER_ASSIGNED',
            manuscriptNumber: raw.manuscriptNumber,
            title: displayTitle,
            rawTitle: raw.title,
            oldStatus: prev.currentStatus,
            newStatus: raw.currentStatus,
            oldStatusDate: prev.statusDate,
            newStatusDate: raw.statusDate,
            oldFolder: prev.folder,
            newFolder: raw.folder,
            initialDateSubmitted: raw.initialDateSubmitted,
            revisionDueDate: raw.revisionDueDate,
            finalDisposition: raw.finalDisposition,
            summary: `编辑部已分配正式稿号：${raw.manuscriptNumber}（当前状态：${raw.currentStatus}）`,
          });
        }

        // 2. 检查核心审稿状态 (Current Status) 是否变化
        if ((prev.currentStatus || '') !== (raw.currentStatus || '')) {
          statusChangeCount++;
          lastChangedAt = nowIso;
          changes.push({
            id: `${nowIso}_${raw.manuscriptNumber || titleHash}_status`,
            timestamp: nowIso,
            changeType: 'STATUS_CHANGED',
            manuscriptNumber: raw.manuscriptNumber,
            title: displayTitle,
            rawTitle: raw.title,
            oldStatus: prev.currentStatus,
            newStatus: raw.currentStatus,
            oldStatusDate: prev.statusDate,
            newStatusDate: raw.statusDate,
            oldFolder: prev.folder,
            newFolder: raw.folder,
            initialDateSubmitted: raw.initialDateSubmitted,
            revisionDueDate: raw.revisionDueDate,
            finalDisposition: raw.finalDisposition,
            summary: `审稿状态更新：由「${prev.currentStatus || '未知'}」变为「${raw.currentStatus}」`,
          });
        } else if ((prev.statusDate || '') !== (raw.statusDate || '')) {
          // 3. 状态名称未变但 Status Date 更新（例如外审期间新审稿人接受邀请或审稿完成！）
          dateChangeCount++;
          lastChangedAt = nowIso;
          changes.push({
            id: `${nowIso}_${raw.manuscriptNumber || titleHash}_date`,
            timestamp: nowIso,
            changeType: 'DATE_CHANGED',
            manuscriptNumber: raw.manuscriptNumber,
            title: displayTitle,
            rawTitle: raw.title,
            oldStatus: prev.currentStatus,
            newStatus: raw.currentStatus,
            oldStatusDate: prev.statusDate,
            newStatusDate: raw.statusDate,
            oldFolder: prev.folder,
            newFolder: raw.folder,
            initialDateSubmitted: raw.initialDateSubmitted,
            revisionDueDate: raw.revisionDueDate,
            finalDisposition: raw.finalDisposition,
            summary: `状态日期跳动（${raw.currentStatus}）：由 ${prev.statusDate || '无'} 更新为 ${raw.statusDate}`,
          });
        } else if ((prev.folder || '') !== (raw.folder || '')) {
          // 4. 所在目录发生转移
          statusChangeCount++;
          lastChangedAt = nowIso;
          changes.push({
            id: `${nowIso}_${raw.manuscriptNumber || titleHash}_folder`,
            timestamp: nowIso,
            changeType: 'FOLDER_CHANGED',
            manuscriptNumber: raw.manuscriptNumber,
            title: displayTitle,
            rawTitle: raw.title,
            oldStatus: prev.currentStatus,
            newStatus: raw.currentStatus,
            oldStatusDate: prev.statusDate,
            newStatusDate: raw.statusDate,
            oldFolder: prev.folder,
            newFolder: raw.folder,
            initialDateSubmitted: raw.initialDateSubmitted,
            revisionDueDate: raw.revisionDueDate,
            finalDisposition: raw.finalDisposition,
            summary: `稿件目录转移：由「${prev.folder}」移至「${raw.folder}」`,
          });
        }
      }

      nextManuscripts.push({
        manuscriptNumber: raw.manuscriptNumber,
        title: displayTitle,
        titleHash,
        initialDateSubmitted: raw.initialDateSubmitted,
        statusDate: raw.statusDate,
        currentStatus: raw.currentStatus,
        finalDisposition: raw.finalDisposition,
        revisionDueDate: raw.revisionDueDate,
        folder: raw.folder,
        folderCn: raw.folderCn,
        stageIndex: statusMeta.stageIndex,
        stageLabel: statusMeta.stageLabel,
        badgeColor: statusMeta.badgeColor,
        cnTitle: statusMeta.cnTitle,
        explanation: statusMeta.explanation,
        statusChangeCount,
        dateChangeCount,
        firstTrackedAt: prev ? prev.firstTrackedAt || nowIso : nowIso,
        lastChangedAt,
      });
    }

    // 判断是否需要发送邮件
    const isAllFirstRun =
      changes.length > 0 && changes.every((c) => c.changeType === 'FIRST_TRACKED');
    const shouldSendEmail =
      forceEmail ||
      (changes.length > 0 && (!isAllFirstRun || config.notifyOnFirstRun));

    let emailSent = false;
    let emailError = null;

    if (shouldSendEmail && config.smtpUser && config.smtpPass && config.notifyTo) {
      try {
        await sendProgressEmail(config, changes, rawManuscripts, {
          isManualSummary: forceEmail && changes.length === 0,
        });
        emailSent = true;
        console.log(`✅ 通知邮件已成功发送至: ${config.notifyTo}`);
      } catch (mailErr) {
        emailError = mailErr.message;
        console.error(`⚠️ 抓取成功，但发送邮件失败: ${mailErr.message}`);
      }
    }

    // 整理历史时间轴（隐藏 rawTitle 以保护公开仓库隐私）
    const sanitizedNewHistory = changes.map(({ rawTitle, ...rest }) => rest);
    const mergedHistory = [...sanitizedNewHistory, ...(prevData.history || [])].slice(
      0,
      200
    );

    const logMsg =
      rawManuscripts.length === 0
        ? '登录成功，当前所有投稿目录中暂未发现稿件'
        : changes.length > 0
        ? `检测到 ${changes.length} 项进展动态${emailSent ? '，已推送邮件至 Gmail' : ''}`
        : `巡检正常（共 ${rawManuscripts.length} 篇稿件，状态暂无新变化）${emailSent ? '，已按要求发送汇总邮件' : ''}`;

    const mergedLogs = [
      {
        timestamp: nowIso,
        ok: true,
        changesCount: changes.length,
        emailSent,
        emailError,
        message: emailError ? `${logMsg}（邮件发送异常: ${emailError}）` : logMsg,
      },
      ...(prevData.checkLogs || []),
    ].slice(0, 50);

    const nextData = {
      journalName: config.journalName,
      emUrl: config.emUrl,
      lastCheckedAt: nowIso,
      lastSuccessAt: nowIso,
      lastCheckStatus: emailError
        ? 'WARNING'
        : changes.length > 0
        ? 'UPDATED'
        : 'OK',
      lastCheckMessage: emailError ? `${logMsg}（邮件异常: ${emailError}）` : logMsg,
      manuscripts: nextManuscripts,
      history: mergedHistory,
      checkLogs: mergedLogs,
    };

    writeStatusData(nextData);
    console.log(`🎉 巡检完成: ${logMsg}`);
    return { ok: true, changesCount: changes.length, emailSent, emailError, data: nextData };
  } catch (err) {
    console.error(`❌ 巡检出错: ${err.message}`);
    const failLogs = [
      {
        timestamp: nowIso,
        ok: false,
        changesCount: 0,
        emailSent: false,
        message: err.message,
      },
      ...(prevData.checkLogs || []),
    ].slice(0, 50);

    const updatedFailData = {
      ...prevData,
      journalName: config.journalName,
      emUrl: config.emUrl,
      lastCheckedAt: nowIso,
      lastCheckStatus: 'ERROR',
      lastCheckMessage: err.message,
      checkLogs: failLogs,
    };
    writeStatusData(updatedFailData);
    throw err;
  }
}

// 命令行直接调用入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const isTestEmail = args.includes('--test-email');
  const isHeaded = args.includes('--headed');
  const isForceEmail = args.includes('--force-email');

  (async () => {
    try {
      if (isTestEmail) {
        const cfg = loadConfig();
        console.log(
          `正在通过 ${cfg.smtpProvider} (${cfg.smtpHost}:${cfg.smtpPort}) 向 ${cfg.notifyTo} 发送测试邮件...`
        );
        await sendTestEmail(cfg);
        console.log('✅ 测试邮件已成功发出！请检查您的 Gmail 收件箱（或垃圾邮件箱）。');
        process.exit(0);
      }

      await runCheck({ headed: isHeaded, forceEmail: isForceEmail });
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  })();
}

module.exports = {
  runCheck,
  readPreviousData,
};
