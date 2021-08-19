module.exports = {
  apps : [{
    name: 'Valve Uni Routing',
    script: './dist/index.js',
    node_args: "--max-old-space-size=2048 -r esm",
    args: 'socketServer',
    // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
    // node_args: "--max-old-space-size=6144 -r esm",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
  }]
}
