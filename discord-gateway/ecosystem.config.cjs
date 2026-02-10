module.exports = {
  apps: [
    {
      name: 'discord-gateway',
      script: './start.sh',
      cwd: __dirname,
      interpreter: '/bin/bash',
      env: { NODE_ENV: 'production' },
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
