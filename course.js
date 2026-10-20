/**
 * 课程 / 章节 / 任务点 数据层（2026 版协议）
 *
 * 完整链路：
 *   1) POST /mooc-ans/visit/courselistdata  (courseType=1 我学的课)
 *        → 课程卡片，含 courseid / clazzid / cpi / 标题
 *   2) GET  /mooc-ans/visit/stucoursemiddle → 302 → mooc2-ans 页面
 *        → Location 里带 enc（mooc2 入口凭证）
 *   3) GET  mooc2-ans/mycourse/studentcourse?courseid&clazzid&cpi&enc
 *        → 章节 HTML：id="cur<knowledgeId>"，内嵌 study enc
 *   4) GET  /mycourse/transfer?moocId&clazzid&linkTime&ut=s&refer=<studentstudy>
 *        → 302 → /mycourse/studentstudy（建立学习会话）
 *   5) GET  /mooc-ans/knowledge/cards?clazzid&courseid&knowledgeid&num=N&ut=s&cpi...
 *        → 页面内 mArg JSON，attachments 里是任务点
 *   6) GET  /ananas/status/<objectId>?k=<fid>&flag=normal&ro=0
 *        → duration / dtoken
 *   7) GET  /mooc-ans/multimedia/log/a/<cpi>/<dtoken>?...  (见 logger.js)
 */
const cheerio = require("cheerio");

class CourseData {
  constructor(session, info) {
    this.s = session;
    this.cid = info.courseId;
    this.cz = info.clazzId;
    this.cpi = info.cpi;
    this.title = info.title;
    this.fid = info.fid || session.fid;
    this.enc = null;
    this.playerUrl = "https://mooc1-1.chaoxing.com/ananas/modules/video/index.html?v=2026-0920-1154";

    // 运行期缓存
    this.studyEnc = null;
    this.chapters = [];
  }

  /** ① 课程列表 */
  static async list(session, opts) {
    opts = opts || {};
    const courseType = opts.courseType == null ? "1" : String(opts.courseType);
    const url = "https://mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata";
    const r = await session.postForm(
      url,
      {
        courseType,
        courseFolderId: "0",
        baseEducation: "0",
        superstarClass: "",
        courseFolderSize: "0",
      },
      "https://mooc1-1.chaoxing.com/visit/interaction"
    );

    const $ = cheerio.load(r.text || "");
    const seen = new Set();
    const out = [];

    $("a[href*='stucoursemiddle']").each((i, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/courseid=(\d+).*?clazzid=(\d+).*?cpi=(\d+)/i);
      if (!m) return;
      const key = m[1] + "_" + m[2];
      if (seen.has(key)) return;
      seen.add(key);

      // 标题优先取同卡片里的 .course-name
      let title = "";
      const card = $(el).closest("li, .course, .course-item");
      if (card && card.length) {
        title = (card.find(".course-name").first().attr("title") || card.find(".course-name").first().text() || "").trim();
      }
      if (!title) {
        const span = $(el).find(".course-name").first();
        title = ((span.attr("title") || span.text()) || $(el).text() || "").trim();
      }
      title = title.replace(/\s+/g, " ");

      out.push({
        courseId: m[1],
        clazzId: m[2],
        cpi: m[3],
        title: title || `课程${m[1]}`,
      });
    });

    return out;
  }

  /** ②+③ 进入课程并抓章节 */
  async open() {
    const entry =
      `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle` +
      `?courseid=${this.cid}&clazzid=${this.cz}&vc=1&cpi=${this.cpi}&ismooc2=1&v=2`;

    const r1 = await this.s.get(entry);
    let mooc2Url = r1.location;
    if (!mooc2Url) throw new Error("课程入口未返回跳转，可能无权限或课程已结束");

    const m = mooc2Url.match(/enc=([^&]+)/);
    this.enc = m ? m[1] : "";
    if (!this.enc) throw new Error("未能从入口跳转中取得 enc");

    // 跟随到 mooc2 学习页
    const page = await this.s.follow(mooc2Url, entry);
    this.mooc2Html = page.text;

    return this;
  }

  /** 签署在线学习诚信承诺书（部分课程首次进入会拦截章节） */
  async agreePledge() {
    const url =
      `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/update-person-status` +
      `?courseid=${this.cid}&clazzid=${this.cz}&personid=${this.cpi}&type=1&_dc=${Date.now()}`;
    const r = await this.s.get(
      url,
      `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${this.cid}&clazzid=${this.cz}`
    );
    return (r.text || "").indexOf('"status":true') !== -1;
  }

  /** ③ 章节列表 */
  async getChapters() {
    if (!this.enc) await this.open();

    const url =
      `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse` +
      `?courseid=${this.cid}&clazzid=${this.cz}&cpi=${this.cpi}&enc=${this.enc}`;

    let r = await this.s.get(url, this.mooc2Url || undefined);
    let html = r.text || "";

    // 承诺书拦截：章节区为空且出现 agreeButton → 签署后重拉
    if ((html.match(/id="cur(\d+)"/g) || []).length === 0 && html.indexOf("agreeButton") !== -1) {
      await this.agreePledge();
      r = await this.s.get(url, this.mooc2Url || undefined);
      html = r.text || "";
    }
    this.chapterRaw = html;

    // study enc（用于 transfer / studentstudy）
    const m = html.match(/var\s+enc\s*=\s*["']([^"']+)["']/);
    this.studyEnc = m ? m[1] : this.enc;
    this.chapterHtml = html;

    const $ = cheerio.load(html);
    const list = [];
    const seen = new Set();

    $(".chapter_item").each((i, el) => {
      const id = $(el).attr("id") || "";
      const km = id.match(/^cur(\d+)$/);
      if (!km) return; // 章（非叶子）
      const kid = km[1];
      if (seen.has(kid)) return;
      seen.add(kid);

      // 任务点数预筛：0 任务点的章节不必进 cards 探测
      const jn = $(el).find("input.knowledgeJobCount").attr("value");
      const title = ($(el).attr("title") || $(el).find(".catalog_name").text() || "").replace(/\s+/g, " ").trim();

      // 章节完成状态：页面用 <div class="catalog_state icon_yiwanc"> 表示"已完成"，
      // 没有这个标记（icon_weiwanc 或无标记）一律当作未完成，宁可多试也不要漏刷。
      const stateCls = $(el).find(".catalog_state").first().attr("class") || "";
      const finished = /\bicon_yiwanc\b/.test(stateCls);

      list.push({ kid, title, jobCount: jn == null ? null : parseInt(jn, 10), finished });
    });

    this.chapters = list;
    return list;
  }

  /** ④ 建立学习会话（transfer → studentstudy）+ 播放器页预热 */
  async studyChapter(kid) {
    const refer =
      `https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=${kid}` +
      `&courseId=${this.cid}&clazzid=${this.cz}&cpi=${this.cpi}&enc=${this.studyEnc}` +
      `&mooc2=1&hidetype=0&fanyaVersion=0`;

    const transfer =
      `https://mooc1-1.chaoxing.com/mycourse/transfer?moocId=${this.cid}` +
      `&clazzid=${this.cz}&linkTime=${Date.now()}&ut=s&refer=${encodeURIComponent(refer)}`;

    const r = await this.s.get(transfer, this.mooc2Url || undefined);
    const next = r.location
      ? r.location.startsWith("http")
        ? r.location
        : new URL(r.location, transfer).href
      : refer;

    const study = await this.s.follow(next, transfer);
    this.studyUrl = study.url;
    this.studyHtml = study.text;

    // 播放器 iframe 页预热：领取 videojs 会话上下文（进度记账的前提）
    await this.s.get(this.playerUrl, this.studyUrl).catch(() => {});
    return study;
  }

  /** ⑤ 读取一个知识点的所有卡片任务点 */
  async getCards(kid, num) {
    const url =
      `https://mooc1-1.chaoxing.com/mooc-ans/knowledge/cards` +
      `?clazzid=${this.cz}&courseid=${this.cid}&knowledgeid=${kid}&num=${num}` +
      `&ut=s&cpi=${this.cpi}&v=2025-0424-1038-4&mooc2=1` +
      `&isMicroCourse=false&editorPreview=0&crossId=0`;

    const r = await this.s.get(url, this.studyUrl || this.mooc2Url || undefined);
    return parseMarg(r.text || "");
  }

  /** ⑤ 遍历所有 num，收集视频任务点 */
  async getVideoJobs(kid) {
    const jobs = [];
    for (let num = 0; num < 60; num++) {
      let m;
      try {
        m = await this.getCards(kid, num);
      } catch (e) {
        break;
      }
      if (!m || !m.attachments || !m.attachments.length) break;

      for (const a of m.attachments) {
        if (a.type !== "video") continue;
        jobs.push({
          jobid: a.jobid,
          objectId: (a.property && a.property.objectid) || a.objectId,
          otherInfo: a.otherInfo,
          name: (a.property && a.property.name) || "视频",
          mid: a.mid || (a.property && a.property.mid) || "",
          doublespeed: (a.property && a.property.doublespeed) || a.doublespeed || 0,
          attDuration: a.attDuration,
          attDurationEnc: a.attDurationEnc,
          videoFaceCaptureEnc: a.videoFaceCaptureEnc || "",
          playTime: a.playTime || 0,
          isPassed: !!a.isPassed, // 服务端已完成标记（之前漏了这一项，导致刷完的视频不跳过）
          jobCount: a.jobCount,
          defaults: m.defaults || {},
          kid,
        });
      }

      // 只有一页也继续探测，直到解析失败
      if (num > 0 && m.attachments.length === 0) break;
    }
    return jobs;
  }

  /** 拉视频内插题（InteractiveQuiz） */
  async getQuizData(mid) {
    if (!mid) return [];
    const url =
      `https://mooc1-1.chaoxing.com/mooc-ans/richvideo/initdatawithviewerV2` +
      `?mid=${mid}&cpi=${this.cpi}&classid=${this.cz}&courseid=${this.cid}&_dc=${Date.now()}`;
    const r = await this.s.get(url, this.playerUrl);
    try {
      const arr = JSON.parse(r.text);
      const out = [];
      (Array.isArray(arr) ? arr : []).forEach((blk) => {
        if (blk.style !== "InteractiveQuiz") return;
        (blk.datas || []).forEach((d) => {
          if (!d.options || !d.options.length) return;
          out.push({
            resourceId: d.resourceId,
            memberinfo: d.memberinfo,
            description: d.description || "",
            questionType: d.questionType || "",
            options: d.options,
            startTime: d.startTime,
            answered: !!d.answered,
          });
        });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  /** ⑥ 视频状态 */
  async getStatus(objectId) {
    const url = `https://mooc1-1.chaoxing.com/ananas/status/${objectId}?k=${this.fid}&flag=normal&ro=0&_dc=${Date.now()}`;
    const r = await this.s.get(url, this.playerUrl);
    try {
      return JSON.parse(r.text);
    } catch (e) {
      throw new Error("视频状态解析失败: " + String(r.text).slice(0, 120));
    }
  }

  /** 回读服务端记录的播放位置与完成态 */
  async readProgress(kid) {
    const m = await this.getCards(kid, 0);
    if (!m) return null;
    const a = (m.attachments || []).find((x) => x.type === "video");
    if (!a) return null;
    return {
      isPassed: !!a.isPassed,
      playTime: Math.round((a.playTime || 0) / 1000),
      attDuration: a.attDuration,
      objectId: (a.property && a.property.objectid) || a.objectId,
      jobid: a.jobid,
      otherInfo: a.otherInfo,
      videoFaceCaptureEnc: a.videoFaceCaptureEnc || "",
      attDurationEnc: a.attDurationEnc,
      defaults: m.defaults || {},
    };
  }
}

/** 从 cards 页面提取 mArg 对象 */
function parseMarg(html) {
  // 页面形如: mArg = ""; try{ mArg = {...} }catch(e){}
  // 必须直接定位 "mArg = {"，否则会命中 try{ 的括号
  let start = html.indexOf("mArg = {");
  if (start === -1) start = html.indexOf("mArg={");
  if (start === -1) return null;
  start = html.indexOf("{", start);
  if (start === -1) return null;
  let depth = 0,
    end = -1;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = p + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch (e) {
    return null;
  }
}

/**
 * 判断一个视频任务点是否已经完成。
 * 只要满足任一条件就算完成：
 *   - 服务端给了 isPassed
 *   - 记录播放位置已经到达时长（留 2 秒容差）
 * playTime 单位不统一（cards 里是毫秒，readProgress 里已转秒），这里自动识别。
 */
function isVideoDone(o) {
  if (!o) return false;
  if (o.isPassed) return true;
  const dur = Number(o.attDuration) || 0;
  if (dur <= 0) return false;
  let played = Number(o.playTime) || 0;
  if (played <= 0) return false;
  if (played > dur * 100) played = played / 1000; // 毫秒 → 秒
  return played >= dur - 2;
}

module.exports = CourseData;
module.exports.parseMarg = parseMarg;
module.exports.isVideoDone = isVideoDone;
