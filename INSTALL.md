# Zeude Installation Guide

Self-hosted installation guide for Zeude — Claude Code observability platform.

## Architecture

```
Developer PC                    Server
─────────────                   ──────────────────────────────────
claude (zeude shim)  ──OTEL──▶  OTel Collector :4318
                                       │
                                       ▼
                               ClickHouse :8123 (analytics)
                               PostgreSQL :5432  (config/users)
                               Dashboard  :3000  (web UI)
```

---

## Server Setup

### Prerequisites

- Docker & Docker Compose
- Git
- `openssl`, `python3`, `curl`

### 1. Clone & Start

```bash
git clone https://github.com/shclub/zeude.git
cd zeude

# Start all services (PostgreSQL, ClickHouse, OTel Collector, Dashboard)
docker compose -f docker-compose.mac.yaml up -d

# Verify all containers are healthy
docker ps --filter "name=zeude"
```

Expected output:
```
zeude-dashboard        Up (healthy)    0.0.0.0:3000->3000/tcp
zeude-clickhouse       Up (healthy)    0.0.0.0:8123->8123/tcp
zeude-postgres         Up (healthy)    0.0.0.0:15432->5432/tcp
zeude-otel-collector   Up              0.0.0.0:4317-4318->4317-4318/tcp
```

### 2. Initialize ClickHouse Schema

```bash
# Create zeude database
curl -s "http://localhost:8123/?user=default&password=dev" \
  --data "CREATE DATABASE IF NOT EXISTS zeude"

# Apply schema
python3 << 'EOF'
import re, subprocess

with open('zeude/dashboard/clickhouse/init.sql') as f:
    sql = f.read()

lines = [l for l in sql.split('\n') if not l.strip().startswith('--')]
stmts = [s.strip() for s in re.split(r';\s*\n', '\n'.join(lines)) if s.strip()]

ok = err = 0
for stmt in stmts:
    result = subprocess.run(
        ['curl', '-s', 'http://localhost:8123/?user=default&password=dev&database=zeude',
         '--data', stmt],
        capture_output=True, text=True
    )
    if 'Exception' in (result.stdout + result.stderr):
        print(f"ERROR: {result.stdout[:120]}")
        err += 1
    else:
        ok += 1
print(f"Done: {ok} OK, {err} errors")
EOF
```

### 3. Create First Admin User

```bash
# Generate agent key
AGENT_KEY="zd_$(openssl rand -hex 32)"
echo "Save this agent key: $AGENT_KEY"

# Insert admin user into PostgreSQL
docker exec zeude-postgres psql -U zeude -d zeude -c "
INSERT INTO zeude_users (email, name, role, status, team, agent_key)
VALUES ('your@email.com', 'Your Name', 'admin', 'active', 'default', '$AGENT_KEY')
ON CONFLICT (email) DO UPDATE SET role='admin', agent_key=EXCLUDED.agent_key
RETURNING id, email, agent_key;
"
```

### 4. Build & Serve CLI Binaries

The dashboard serves install scripts and CLI binaries from `/releases/`. Build them before restarting:

```bash
cd zeude

# Build binaries for all platforms
for OS in darwin linux; do
  for ARCH in amd64 arm64; do
    echo -n "claude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/claude-$OS-$ARCH ./cmd/claude && echo "OK"
    echo -n "zeude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/zeude-$OS-$ARCH ./cmd/zeude && echo "OK"
  done
done

# Copy install.sh with your server URL
SERVER_URL=http://<YOUR_SERVER_IP>:3000
sed "s|https://your-dashboard-url|$SERVER_URL|g; s|https://your-otel-collector-url/|http://<YOUR_SERVER_IP>:4318/|g" \
  releases/install.sh > dashboard/public/releases/install.sh

# Rebuild dashboard image to include the binaries
cd ..
docker compose -f docker-compose.mac.yaml build dashboard
docker compose -f docker-compose.mac.yaml up -d dashboard
```

### 5. Log In to Dashboard

```bash
SERVER_URL=http://<YOUR_SERVER_IP>:3000

# Get one-time login token (valid 60 seconds)
OTT=$(curl -s -X POST "$SERVER_URL/api/auth/ott" \
  -H "Content-Type: application/json" \
  -d "{\"agentKey\": \"$AGENT_KEY\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Open in browser: $SERVER_URL/api/auth/callback?ott=$OTT"
```

Open the URL in your browser to log in.

---

## Developer PC Setup

### Install zeude Plugin (per developer)

```bash
# Replace with your server IP and agent key
curl -fsSL http://<SERVER_IP>:3000/releases/install.sh | \
  ZEUDE_AGENT_KEY=zd_your_agent_key \
  ZEUDE_DASHBOARD_URL=http://<SERVER_IP>:3000 \
  ZEUDE_ENDPOINT=http://<SERVER_IP>:4318/ \
  bash

# Apply PATH changes
source ~/.zshrc

# Verify installation
which claude     # should show: ~/.zeude/bin/claude
zeude --version  # should print version
```

### Enable Telemetry (if shim is bypassed by alias)

```bash
cat >> ~/.zshrc << 'EOF'
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://<SERVER_IP>:4318/
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
EOF
source ~/.zshrc
```

### Open Dashboard from Claude Code

In any Claude Code session:
```
/zeude
```
This automatically opens the dashboard with a one-time login token.

---

## Verify Data Collection

After running Claude Code for a few minutes:

```bash
# Check if logs are arriving in ClickHouse
curl -s "http://localhost:8123/?user=default&password=dev&query=SELECT+count(*)+FROM+zeude.claude_code_logs"

# Watch OTel collector for incoming data
docker logs -f zeude-otel-collector 2>&1 | grep -E "export|LogsExported"
```

---

## Port Reference

| Service | Port | Purpose |
|---------|------|---------|
| Dashboard | 3000 | Web UI & API |
| OTel Collector HTTP | 4318 | Telemetry ingestion from Claude Code |
| OTel Collector gRPC | 4317 | Telemetry ingestion (gRPC) |
| ClickHouse HTTP | 8123 | Analytics queries |
| PostgreSQL | 15432 | Main database (host-exposed) |

---

## Manage Users

Additional users can be added via the dashboard's Admin → Users page, or by generating invite links from Admin → Invites.

Each developer needs their own `agent_key`. Keys are generated automatically when a user is created through the dashboard.
