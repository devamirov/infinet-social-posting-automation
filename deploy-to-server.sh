#!/bin/bash
# Deploy InfiNet Automation to Contabo - ONLY touches /var/www/infinet.services/automation
set -e
KEY="$HOME/Desktop/contabo_key.txt"
SERVER="root@75.119.155.9"
REMOTE_DIR="/var/www/infinet.services/automation"
SOURCE="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$KEY" ]; then
  echo "Key not found: $KEY"
  exit 1
fi
chmod 600 "$KEY" 2>/dev/null || true

echo "=== 1. Creating remote directory ==="
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SERVER" "mkdir -p $REMOTE_DIR"

echo "=== 2. Uploading files (excluding node_modules, tmp, output, dist) ==="
rsync -avz --delete \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  --exclude 'node_modules' \
  --exclude 'tmp' \
  --exclude 'output' \
  --exclude 'dist' \
  --exclude '*.log' \
  --exclude '.env' \
  --exclude '.env.example' \
  "$SOURCE/" "$SERVER:$REMOTE_DIR/"

echo "=== 3. Skipping .env (server keeps its own; do not overwrite) ==="

echo "=== 4. On server: install FFmpeg, npm install, build, set BASE_URL, add nginx vhost, PM2 ==="
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SERVER" "bash -s" << 'REMOTE'
set -e
AUTOMATION_DIR="/var/www/infinet.services/automation"
cd "$AUTOMATION_DIR"

# FFmpeg (idempotent)
if ! command -v ffmpeg &>/dev/null; then
  echo "Installing FFmpeg..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq ffmpeg
else
  echo "FFmpeg already installed: $(ffmpeg -version | head -1)"
fi

# BASE_URL for production
sed -i 's|BASE_URL=.*|BASE_URL=https://automation.infinet.services|' .env 2>/dev/null || true

# Node (full install for build, then build)
npm install
npm run build

# Nginx: only ADD new file for automation.infinet.services (do not modify existing)
NGINX_AUTO="/etc/nginx/sites-available/automation.infinet.services"
if [ ! -f "$NGINX_AUTO" ]; then
  echo "Creating nginx config for automation.infinet.services..."
  cat > "$NGINX_AUTO" << 'NGX'
server {
    listen 80;
    server_name automation.infinet.services;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGX
  ln -sf "$NGINX_AUTO" /etc/nginx/sites-enabled/automation.infinet.services 2>/dev/null || true
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || echo "Nginx not active or not used - start it when ready."
else
  echo "Nginx config for automation.infinet.services already exists, skipping."
fi

# PM2: start or restart only this app
if command -v pm2 &>/dev/null; then
  pm2 delete infinet-automation 2>/dev/null || true
  cd "$AUTOMATION_DIR" && pm2 start dist/server.js --name infinet-automation
  pm2 save
else
  echo "PM2 not found. Installing globally..."
  npm install -g pm2
  cd "$AUTOMATION_DIR" && pm2 start dist/server.js --name infinet-automation
  pm2 startup systemd -u root --hp /root 2>/dev/null || true
  pm2 save
fi

echo "Done. App should be at https://automation.infinet.services (ensure SSL if needed)."
REMOTE

echo "=== Deploy finished ==="
