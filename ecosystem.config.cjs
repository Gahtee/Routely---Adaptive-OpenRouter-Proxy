module.exports = {
  apps: [
    {
      name: 'routely',
      script: 'src/index.js',
      cwd: '/home/gahtee/openrouter-dynamic-router',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
  ],
};
