/**
 * 进度上报（2026 版 · 已实测打通）
 *
 * 实测确认的记账要件（缺一不可）：
 *  1. enc = MD5([clazzId][userid][jobid][objectId][playingTime*1000][d_yHJ!$pdA~5][duration*1000][clipTime])
 *  2. otherInfo 原样拼 URL（其内部 &courseId= 作为独立参数，编码则 403 code=6）
 *  3. 必带 attDuration / attDurationEnc / courseEngineInfo=false / videoFaceCaptureEnc
 *  4. 会话必须完整：走完 入口→章节→transfer→studentstudy→播放器iframe 页，
 *     并动态吸收 route/jrose/k8s 会话 cookie，否则 200 但不记账
 *  5. Referer 用播放器 iframe 页 URL
 *  6. isdrag 语义：0=初载 1=播放 3=起播(seek) 2=心跳 4=ended
 *  7. 每轮心跳前重新取 status 拿新 dtoken
 *  8. 心跳间隔 ≥60s、playingTime 步进与墙钟 1:1（倍速课除外）
 */
const crypto = require("crypto");

const MAGIC = "d_yHJ!$pdA~5";

class Reporter {
  constructor(session) {
    this.s = session;
  }

  encode(clazzId, userid, jobid, objectId, playingTime, duration) {
    const clip = "0_" + duration;
    const built =
      `[${clazzId}]` +
      `[${userid}]` +
      `[${jobid}]` +
      `[${objectId}]` +
      `[${playingTime * 1000}]` +
      `[${MAGIC}]` +
      `[${duration * 1000}]` +
      `[${clip}]`;
    return crypto.createHash("md5").update(built).digest("hex");
  }

  buildUrl(job, duration, dtoken, playingTime, isdrag) {
    const defaults = job.defaults || {};
    const clazzId = defaults.clazzId;
    const userid = defaults.userid;
    const cpi = defaults.cpi;
    const reportUrl = (
      defaults.reportUrl ||
      `https://mooc1-1.chaoxing.com/mooc-ans/multimedia/log/a/${cpi}`
    ).replace(/\/$/, "");

    const enc = this.encode(clazzId, userid, job.jobid, job.objectId, playingTime, duration);
    const face = job.videoFaceCaptureEnc || "";

    return (
      `${reportUrl}/${dtoken}` +
      `?clazzId=${clazzId}` +
      `&playingTime=${playingTime}` +
      `&duration=${duration}` +
      `&clipTime=0_${duration}` +
      `&objectId=${job.objectId}` +
      `&otherInfo=${job.otherInfo}` +
      `&jobid=${job.jobid}` +
      `&userid=${userid}` +
      `&isdrag=${isdrag}` +
      `&view=pc` +
      `&enc=${enc}` +
      `&rt=0.9` +
      `&videoFaceCaptureEnc=${face}` +
      `&dtype=Video` +
      `&_t=${Date.now()}` +
      `&attDuration=${job.attDuration || duration}` +
      `&attDurationEnc=${job.attDurationEnc || ""}` +
      `&courseEngineInfo=false`
    );
  }

  /** 发送一次上报（referer 必须是播放器页） */
  async send(course, job, status, playingTime, isdrag) {
    const url = this.buildUrl(job, status.duration, status.dtoken, playingTime, isdrag);
    const r = await this.s.get(url, course.playerUrl);
    let json = null;
    try {
      json = JSON.parse(r.text);
    } catch (e) {}
    return {
      status: r.status,
      ok: r.status === 200,
      isPassed: !!(json && json.isPassed),
      raw: r.text,
    };
  }
}

Reporter.MAGIC = MAGIC;
module.exports = Reporter;
