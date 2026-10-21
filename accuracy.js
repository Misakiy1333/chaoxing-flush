/**
 * 正确率区间规划器
 *
 * 用户要的不是"越高越好"，而是"稳定落在某个区间"（默认 80%~90%）：
 *   - 知道的题故意错几道，把总分压进区间
 *   - 不知道的题本来就可能错，规划时按题型猜对概率折算进去
 *
 * 关键点：
 *   1) 目标分 = 区间内随机取一个（不是固定值，避免每次分数一模一样）
 *   2) 逐题枚举"答对几道已知题"，选最接近目标分的方案（能进区间就优先区间内）
 *   3) 故意错的那几道，从题库里挑已确认错误的选项，挑不出来就随机挑一个非正确项
 *   4) 随机数带种子 → 同样的题、同样的种子，结果完全可复现（便于测试）
 *   5) 区间不可达（比如 4 道题每题 25 分，只有 0/25/50/75/100）时就近取，
 *      优先落在区间下方（宁可低一点，也别出现 100 分这种一眼假的分）
 */

/** 乘法哈希随机数：种子相同 → 序列相同 */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 带种子的洗牌（Fisher-Yates） */
function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** 各题型的"瞎猜也能对"概率 */
const GUESS_PROB = { 0: 0.25, 1: 0.12, 2: 0.05, 3: 0.5 };

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** 把用户输入的区间修成合法值 */
function normalizeRange(min, max) {
  let lo = Number(min);
  let hi = Number(max);
  if (!isFinite(lo)) lo = 80;
  if (!isFinite(hi)) hi = 90;
  lo = clamp(lo, 0, 100);
  hi = clamp(hi, 0, 100);
  if (lo > hi) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  return { min: lo, max: hi };
}

/**
 * 规划一轮作答
 *
 * @param {Object} opts
 * @param {Array}  opts.questions [{ id, type, answer }]  answer 为已知答案，null 表示不知道
 * @param {number} opts.fullScore  满分（默认 100）
 * @param {number} opts.min        区间下限（百分比）
 * @param {number} opts.max        区间上限（百分比）
 * @param {number} [opts.seed]     随机种子
 * @returns {{
 *   target:number, targetScore:number, expected:number, min:number, max:number,
 *   knownCount:number, unknownCount:number, pointsPer:number,
 *   plan:Object<string,string>,  // id → 要提交的答案（含故意错）
 *   missed:string[],             // 故意答错的题 id
 *   reachable:boolean,           // 目标分是否真能落进区间
 *   note:string
 * }}
 */
function plan(opts) {
  const questions = (opts && opts.questions) || [];
  const fullScore = Number(opts && opts.fullScore) || 100;
  const range = normalizeRange(opts && opts.min, opts && opts.max);
  const seed = opts && opts.seed != null ? opts.seed : Date.now() % 0x7fffffff;
  const rng = mulberry32(seed);

  const n = questions.length;
  const out = {
    target: range.min,
    targetScore: 0,
    expected: 0,
    min: range.min,
    max: range.max,
    knownCount: 0,
    unknownCount: 0,
    pointsPer: n ? fullScore / n : 0,
    plan: {},
    missed: [],
    reachable: false,
    note: "",
    seed,
  };
  if (!n) {
    out.note = "没有题目";
    return out;
  }

  const pointsPer = fullScore / n;
  const known = [];
  const unknown = [];
  for (const q of questions) {
    // 置信度低的答案（大模型猜的、题库模糊匹配的）按"不确定"处理，不能当已掌握
    const conf = q && q.confidence == null ? 1 : Number(q.confidence);
    if (q && q.answer && conf >= 0.7) known.push(q);
    else unknown.push(q);
  }
  out.knownCount = known.length;
  out.unknownCount = unknown.length;

  // 目标分：区间内随机（区间退化时就是那个值）
  const targetPct = range.min === range.max ? range.min : range.min + rng() * (range.max - range.min);
  const targetScore = (fullScore * targetPct) / 100;
  out.target = Math.round(targetPct * 10) / 10;
  out.targetScore = targetScore;

  // 不知道的题：按猜对概率折算成期望得分（有大模型/题库给的答案就用它的置信度）
  let expectedUnknown = 0;
  for (const q of unknown) {
    const conf = Number(q.confidence);
    const p = conf > 0 && conf < 0.7 ? conf : GUESS_PROB[Number(q.type)];
    expectedUnknown += pointsPer * (p == null ? 0.2 : p);
  }

  // 枚举"已知题故意答错 m 道"，挑**落在区间内概率最大**的方案
  // 为什么不是按期望分挑：期望分落在区间里，实际可能一半概率满分、一半概率偏低。
  // 未知题是抛硬币（大模型也可能答错），所以要把这份随机性算进去。
  const loScore = (fullScore * range.min) / 100;
  const hiScore = (fullScore * range.max) / 100;
  const midScore = (loScore + hiScore) / 2;

  // 未知题答对的综合概率
  let pUnknown = 0;
  if (unknown.length) {
    let sum = 0;
    for (const q of unknown) {
      const conf = Number(q.confidence);
      const p = conf > 0 && conf < 0.7 ? conf : GUESS_PROB[Number(q.type)];
      sum += p == null ? 0.2 : p;
    }
    pUnknown = sum / unknown.length;
  }

  let bestM = 0;
  let bestProb = -1;
  let bestGap = Infinity;
  for (let m = 0; m <= known.length; m++) {
    const base = (known.length - m) * pointsPer;
    // 未知题答对 x 道时的总分概率
    let prob = 0;
    let gapSum = 0;
    for (let x = 0; x <= unknown.length; x++) {
      const w = binomPmf(unknown.length, x, pUnknown);
      const score = base + x * pointsPer;
      if (score >= loScore - 1e-9 && score <= hiScore + 1e-9) prob += w;
      gapSum += w * Math.abs(score - midScore);
    }
    if (prob > bestProb + 1e-9 || (Math.abs(prob - bestProb) <= 1e-9 && gapSum < bestGap - 1e-9)) {
      bestProb = prob;
      bestGap = gapSum;
      bestM = m;
    }
  }

  const missCount = bestM;
  out.probInRange = Math.max(0, bestProb);
  const shuffled = seededShuffle(known, rng);
  const missSet = new Set(shuffled.slice(0, missCount).map((q) => String(q.id)));

  for (const q of known) {
    const id = String(q.id);
    if (missSet.has(id)) {
      out.plan[id] = wrongAnswerFor(q, rng);
      out.missed.push(id);
    } else {
      out.plan[id] = q.answer;
    }
  }
  for (const q of unknown) {
    // 不知道的题：有答案（大模型/题库）就照它交，否则按题型猜
    out.plan[String(q.id)] = q.guess != null && q.guess !== ""
      ? q.guess
      : q.answer != null && q.answer !== ""
        ? q.answer
        : "";
  }

  out.expected = (known.length - missCount) * pointsPer + expectedUnknown;
  const lo2 = (fullScore * range.min) / 100;
  const hi2 = (fullScore * range.max) / 100;
  out.reachable = out.expected >= lo2 - 1e-9 && out.expected <= hi2 + 1e-9;
  if (out.reachable) {
    out.note = `预计 ${round1(out.expected)}/${fullScore} 分（落区间概率 ${Math.round(out.probInRange * 100)}%），落在 ${range.min}~${range.max}% 内`;
  } else if (out.expected > hi2) {
    out.note = `预计 ${round1(out.expected)}/${fullScore} 分，高于上限（${known.length} 道已知题、每题 ${round1(pointsPer)} 分，压不进区间）`;
  } else {
    out.note = `预计 ${round1(out.expected)}/${fullScore} 分，低于下限（已知题不够，多刷几章积累题库）`;
  }
  return out;
}

/** 二项分布概率质量：n 次里成功 k 次的概率 */
function binomPmf(n, k, p) {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  let c = 1; // C(n,k)
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * 给一道已知答案的题挑一个"错的选项"
 * 优先用题库确认过的错误项，其次随机
 */
function wrongAnswerFor(q, rng) {
  const options = q.options || {};
  const keys = Object.keys(options).sort();
  const right = String(q.answer || "").split("");
  const wrongs = (q.wrongOptions || []).filter((k) => keys.includes(k) && !right.includes(k));
  if (wrongs.length) return wrongs[Math.floor((rng || Math.random)() * wrongs.length)];
  const cand = keys.filter((k) => !right.includes(k));
  if (!cand.length) return q.answer; // 没得选只能照答
  return cand[Math.floor((rng || Math.random)() * cand.length)];
}

module.exports = {
  plan,
  mulberry32,
  seededShuffle,
  normalizeRange,
  wrongAnswerFor,
  GUESS_PROB,
  round1,
};