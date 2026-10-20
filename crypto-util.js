const crypto = require("crypto");
const os = require("os");

/**
 * 配置文件里的密码不落明文。
 * 用机器标识派生密钥做 AES-256-GCM，密文形如 ENC:<hex(iv+tag+data)>。
 * 注意：这是防止明文随手泄露，不是强对抗存储加密。
 */

const MAGIC = "chaoxing-flush-v1";

/**
 * 密钥来源优先级：
 *   1. ENC_KEY 环境变量（云端/Docker 必须用它，否则容器重建后 hostname 变了密码解不开）
 *   2. 机器标识（本机 exe 用，防止配置拷给别人）
 */
function machineKey() {
  const explicit = process.env.ENC_KEY;
  if (explicit && explicit.length >= 8) {
    return crypto.createHash("sha256").update(MAGIC + "|env|" + explicit).digest();
  }
  let user = "";
  try { user = os.userInfo().username; } catch (e) { user = "nobody"; }
  const seed = [MAGIC, os.hostname(), user, os.platform()].join("|");
  return crypto.createHash("sha256").update(seed).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", machineKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "ENC:" + Buffer.concat([iv, tag, data]).toString("hex");
}

function decrypt(payload) {
  const buf = Buffer.from(payload, "hex");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", machineKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
