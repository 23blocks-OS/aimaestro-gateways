module.exports = {
  apps: [
    {
      name: 'slack-gateway',
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
    // To run multiple instances with different configs, add entries like:
    // {
    //   name: 'slack-gateway-secondary',
    //   script: './start-secondary.sh',  // sources a different .env file
    //   cwd: __dirname,
    //   interpreter: '/bin/bash',
    //   env: { NODE_ENV: 'production' },
    //   ...
    // },
  ],
};
