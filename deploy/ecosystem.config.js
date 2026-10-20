// PM2 进程管理配置（多用户云端服务）
// 用法： pm2 start deploy/ecosystem.config.js
//        pm2 logs chaoxing-multi
//        pm2 restart chaoxing-multi
module.exports = {
  apps: [
    {
      name: "chaoxing-multi",
      script: "server-multi.js",
      cwd: __dirname + "/..",
      instances: 1,              // 必须 1 个：任务状态在内存里，多实例会重复刷
      exec_mode: "fork",
      max_memory_restart: "1G",  // 超过 1G 自动重启（约可支撑 30~40 人）
      autorestart: true,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        PORT: 8080,
        ADMIN_PASSWORD: "改成你自己的管理密码",
        MAX_RUNNING: 30,
      },
      error_file: "logs/err.log",
      out_file: "logs/out.log",
      time: true,
      merge_logs: true,
    },
  ],
};
