# Zeude 포털 신규 서버 설치 가이드

> 새 서버에 포털(Dashboard + ClickHouse + PostgreSQL + OTel Collector)을 처음부터 설치합니다.

---

## 아키텍처

```
개발자 PC                         신규 서버
─────────────                    ──────────────────────────────────────
claude (shim)  ──── OTEL ─────▶  OTel Collector  :4318  (수집)
copilot (shim) ──── OTEL ─────▶         │
opencode (shim) ─── OTEL ─────▶         ▼
                                 ClickHouse       :8123  (분석 DB)
                                 PostgreSQL       :5432  (유저/설정)
                                 Dashboard        :3000  (웹 UI)
```

---

## 사전 준비

### 신규 서버 요구사항

| 항목 | 최소 | 권장 |
|------|------|------|
| OS | Ubuntu 22.04 / macOS 13+ | Ubuntu 22.04 LTS |
| CPU | 2 core | 4 core |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB+ |
| 포트 | 3000, 4317, 4318 오픈 | - |

### 필수 소프트웨어

```bash
# Docker & Docker Compose
curl -fsSL https://get.docker.com | bash
sudo usermod -aG docker $USER
newgrp docker

# Go 1.21+ (바이너리 빌드용)
# macOS
brew install go

# Linux
wget https://go.dev/dl/go1.21.13.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.21.13.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# 확인
docker --version    # Docker version 24+
go version          # go1.21+
```

---

## Step 1. 코드 클론

```bash
git clone https://github.com/shclub/zeude.git
cd zeude
```

---

## Step 2. 환경 설정

외부 접속을 허용하려면 **`.env` 파일이 필수**입니다.  
설정하지 않으면 초대 링크가 `localhost`로 생성되고, 외부 shim의 API 호출이 CORS로 차단될 수 있습니다.

```bash
# 서버 공개 IP 또는 도메인으로 교체
cat > .env << EOF
NEXT_PUBLIC_APP_URL=http://<서버IP>:3000
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4
EOF
```

> **도메인 사용 시**: `NEXT_PUBLIC_APP_URL=https://zeude.example.com`

### 외부 접속을 위한 포트 오픈

docker-compose는 이미 `0.0.0.0`으로 바인딩되어 있습니다.  
서버 방화벽에서 아래 두 포트만 열면 됩니다.

```bash
# Ubuntu (ufw)
sudo ufw allow 3000/tcp   # Dashboard 웹 UI
sudo ufw allow 4318/tcp   # OTel Collector (텔레메트리 수신)
sudo ufw reload

# 또는 iptables
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 4318 -j ACCEPT
```

> gRPC(:4317)는 HTTP(:4318)로 대체 가능하므로 선택 사항입니다.

---

## Step 3. 컨테이너 실행

```bash
# 전체 서비스 시작 (PostgreSQL, ClickHouse, OTel Collector, Dashboard)
docker compose -f docker-compose.mac.yaml up -d

# 상태 확인 (모두 healthy 가 될 때까지 대기, 약 1-2분)
docker ps --filter "name=zeude"
```

정상 출력:
```
zeude-dashboard        Up (healthy)    0.0.0.0:3000->3000/tcp
zeude-clickhouse       Up (healthy)    0.0.0.0:8123->8123/tcp
zeude-postgres         Up (healthy)    0.0.0.0:15432->5432/tcp
zeude-otel-collector   Up              0.0.0.0:4317-4318->4317-4318/tcp
```

> ⚠️ `dashboard` 컨테이너가 `healthy` 되려면 60초 정도 걸립니다.

---

## Step 4. ClickHouse 스키마 초기화

> ClickHouse가 처음 기동될 때 `init.sql`이 자동으로 실행됩니다.  
> 자동 실행을 기다리거나, 아래 명령으로 수동 적용합니다.

```bash
# ClickHouse healthy 확인
curl -s "http://localhost:8123/ping"   # 출력: Ok.

# 스키마 수동 적용 (이미 자동 실행됐다면 생략 가능)
python3 << 'EOF'
import re, subprocess

with open('zeude/dashboard/clickhouse/init.sql') as f:
    sql = f.read()

lines = [l for l in sql.split('\n') if not l.strip().startswith('--')]
stmts = [s.strip() for s in re.split(r';\s*\n', '\n'.join(lines)) if s.strip()]

ok = err = 0
for stmt in stmts:
    result = subprocess.run(
        ['curl', '-s', 'http://localhost:8123/?user=default&password=dev',
         '--data', stmt],
        capture_output=True, text=True
    )
    if 'Exception' in (result.stdout + result.stderr):
        print(f"ERROR: {result.stdout[:200]}")
        err += 1
    else:
        ok += 1
print(f"완료: {ok} 성공, {err} 실패")
EOF
```

테이블 생성 확인:
```bash
curl -s "http://localhost:8123/?user=default&password=dev&query=SHOW+TABLES"
# claude_code_logs, token_usage_hourly, tool_invocations_daily 등이 보여야 함
```

---

## Step 5. 첫 번째 관리자 계정 생성

```bash
# 관리자 agent key 생성
AGENT_KEY="zd_$(openssl rand -hex 32)"
echo "==================================="
echo "Agent Key: $AGENT_KEY"
echo "==================================="
echo "⚠️  이 키를 반드시 저장해두세요!"

# PostgreSQL에 관리자 유저 추가
docker exec zeude-postgres psql -U zeude -d zeude -c "
INSERT INTO zeude_users (email, name, role, status, team, agent_key)
VALUES ('admin@example.com', 'Admin', 'admin', 'active', 'default', '$AGENT_KEY')
ON CONFLICT (email) DO UPDATE SET role='admin', agent_key=EXCLUDED.agent_key
RETURNING id, email, agent_key;
"
```

> `admin@example.com` 과 `Admin` 을 실제 이메일/이름으로 교체하세요.

---

## Step 6. CLI 바이너리 빌드

dashboard가 `/releases/` 경로로 설치 스크립트와 shim 바이너리를 제공합니다.

```bash
cd zeude   # 레포 내 zeude/ 서브디렉토리

SERVER_IP="<서버IP>"   # 실제 IP 또는 도메인

# 전체 플랫폼 바이너리 빌드
for OS in darwin linux; do
  for ARCH in amd64 arm64; do
    echo -n "claude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/claude-$OS-$ARCH ./cmd/claude && echo "OK"

    echo -n "copilot-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/copilot-$OS-$ARCH ./cmd/copilot && echo "OK"

    echo -n "opencode-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/opencode-$OS-$ARCH ./cmd/opencode && echo "OK"

    echo -n "zeude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/zeude-$OS-$ARCH ./cmd/zeude && echo "OK"
  done
done

# 설치 스크립트 서버 URL로 교체
sed \
  "s|https://your-dashboard-url|http://$SERVER_IP:3000|g; \
   s|https://your-otel-collector-url/|http://$SERVER_IP:4318/|g" \
  releases/install.sh > dashboard/public/releases/install.sh

echo "바이너리 목록:"
ls -lh dashboard/public/releases/
```

---

## Step 7. Dashboard 이미지 재빌드

바이너리가 포함된 이미지로 재빌드합니다.

```bash
cd ..   # zeude 레포 루트로 이동

docker compose -f docker-compose.mac.yaml build dashboard
docker compose -f docker-compose.mac.yaml up -d dashboard

# 빌드 & 재시작 완료 확인 (약 1분 소요)
docker ps --filter "name=zeude-dashboard"
```

---

## Step 8. 대시보드 로그인 확인

```bash
SERVER_IP="<서버IP>"

# 일회용 로그인 토큰 발급 (60초 유효)
OTT=$(curl -s -X POST "http://$SERVER_IP:3000/api/auth/ott" \
  -H "Content-Type: application/json" \
  -d "{\"agentKey\": \"$AGENT_KEY\"}" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "브라우저에서 열기:"
echo "http://$SERVER_IP:3000/auth?ott=$OTT"
```

출력된 URL을 브라우저에서 열면 자동 로그인됩니다.

---

## Step 9. 개발자 PC에 shim 설치

새 포털을 가리키도록 install.sh를 실행합니다.

```bash
# 각 개발자 PC에서 실행 (서버 IP와 개인 agent key로 교체)
curl -fsSL "http://<서버IP>:3000/releases/install.sh" | \
  ZEUDE_AGENT_KEY="zd_your_agent_key" \
  ZEUDE_DASHBOARD_URL="http://<서버IP>:3000" \
  ZEUDE_ENDPOINT="http://<서버IP>:4318/" \
  bash

source ~/.zshrc
which claude   # → ~/.zeude/bin/claude 여야 함
```

---

## 포트 요약

| 서비스 | 포트 | 외부 오픈 여부 | 용도 |
|--------|------|--------------|------|
| Dashboard | 3000 | ✅ 필요 | 웹 UI / API / 바이너리 서빙 |
| OTel Collector HTTP | 4318 | ✅ 필요 | 텔레메트리 수신 |
| OTel Collector gRPC | 4317 | 선택 | 텔레메트리 수신 (gRPC) |
| ClickHouse HTTP | 8123 | ❌ 불필요 | 내부 분석 (컨테이너 내부) |
| PostgreSQL | 15432 | ❌ 불필요 | 내부 DB (컨테이너 내부) |

> 방화벽에서 **3000**, **4318** 포트만 개발자 PC에서 접근 가능하면 됩니다.

---

## 유저 추가

### 방법 1: Admin UI (권장)
Dashboard → **Admin → Users** → 새 유저 생성 → agent key 자동 발급

### 방법 2: 초대 링크
Dashboard → **Admin → Invites** → 초대 링크 생성 → 개발자에게 전달  
개발자가 링크에서 가입하면 agent key 자동 발급

### 방법 3: 직접 삽입 (스크립트/배치)
```bash
NEW_KEY="zd_$(openssl rand -hex 32)"
docker exec zeude-postgres psql -U zeude -d zeude -c "
INSERT INTO zeude_users (email, name, role, status, team, agent_key)
VALUES ('dev@example.com', '개발자이름', 'member', 'active', 'default', '$NEW_KEY');
"
echo "Agent Key: $NEW_KEY"
```

---

## 업데이트

코드 변경 후 재배포:

```bash
git pull

# Go 바이너리 재빌드
cd zeude
for OS in darwin linux; do
  for ARCH in amd64 arm64; do
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/claude-$OS-$ARCH ./cmd/claude
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/copilot-$OS-$ARCH ./cmd/copilot
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/opencode-$OS-$ARCH ./cmd/opencode
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/zeude-$OS-$ARCH ./cmd/zeude
  done
done
cd ..

# Dashboard 재빌드 & 재시작
docker compose -f docker-compose.mac.yaml build dashboard
docker compose -f docker-compose.mac.yaml up -d dashboard
```

---

## 문제 해결

### ClickHouse가 뜨지 않을 때
```bash
docker logs zeude-clickhouse | tail -30
```

### Dashboard가 healthy 안 될 때
```bash
docker logs zeude-dashboard | tail -50
# DB 연결 에러 → postgres healthy 먼저 확인
docker ps --filter "name=zeude-postgres"
```

### 텔레메트리가 수집 안 될 때
```bash
# OTel Collector 로그 확인
docker logs -f zeude-otel-collector 2>&1 | grep -E "error|Logs|export"

# ClickHouse에 데이터 확인
curl -s "http://localhost:8123/?user=default&password=dev&query=SELECT+count(*)+FROM+claude_code_logs"
```

### 포트 확인 (방화벽)
```bash
# 서버에서
ss -tlnp | grep -E "3000|4317|4318"

# 개발자 PC에서 서버 연결 테스트
curl -v http://<서버IP>:4318/v1/logs
curl -v http://<서버IP>:3000/api/health
```

### 전체 재시작
```bash
docker compose -f docker-compose.mac.yaml down
docker compose -f docker-compose.mac.yaml up -d
```

> ⚠️ `down` 해도 `postgres_data`, `clickhouse_data` 볼륨은 유지되므로 데이터는 보존됩니다.
