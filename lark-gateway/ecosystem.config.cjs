module.exports = {
  apps: [{
    name: 'lark-gateway',
    script: 'node',
    args: 'dist/server.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    autorestart: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
