# Zeude 설치 가이드

Claude Code 옵저버빌리티 플랫폼 Zeude 자체 호스팅 설치 가이드입니다.

## 아키텍처

```
개발자 PC                        서버
─────────────                   ──────────────────────────────────
claude (zeude shim)  ──OTEL──▶  OTel Collector :4318
                                       │
                                       ▼
                               ClickHouse :8123 (분석 DB)
                               PostgreSQL :5432  (설정/유저)
                               Dashboard  :3000  (웹 UI)
```

---

## 서버 설정

### 사전 준비

- Docker & Docker Compose
- Git
- `openssl`, `python3`, `curl`

### 1. 클론 & 실행

```bash
git clone https://github.com/shclub/zeude.git
cd zeude

# 전체 서비스 실행 (PostgreSQL, ClickHouse, OTel Collector, Dashboard)
docker compose -f docker-compose.mac.yaml up -d

# 컨테이너 상태 확인
docker ps --filter "name=zeude"
```

정상 실행 시 출력:
```
zeude-dashboard        Up (healthy)    0.0.0.0:3000->3000/tcp
zeude-clickhouse       Up (healthy)    0.0.0.0:8123->8123/tcp
zeude-postgres         Up (healthy)    0.0.0.0:15432->5432/tcp
zeude-otel-collector   Up              0.0.0.0:4317-4318->4317-4318/tcp
```

### 2. ClickHouse 스키마 초기화

```bash
# zeude DB 생성
curl -s "http://localhost:8123/?user=default&password=dev" \
  --data "CREATE DATABASE IF NOT EXISTS zeude"

# 스키마 적용
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
print(f"완료: {ok} 성공, {err} 실패")
EOF
```

### 3. 첫 번째 관리자 계정 생성

```bash
# agent key 생성
AGENT_KEY="zd_$(openssl rand -hex 32)"
echo "Agent Key: $AGENT_KEY"  # 반드시 저장해두세요

# PostgreSQL에 관리자 유저 추가
docker exec zeude-postgres psql -U zeude -d zeude -c "
INSERT INTO zeude_users (email, name, role, status, team, agent_key)
VALUES ('your@email.com', 'Your Name', 'admin', 'active', 'default', '$AGENT_KEY')
ON CONFLICT (email) DO UPDATE SET role='admin', agent_key=EXCLUDED.agent_key
RETURNING id, email, agent_key;
"
```

### 4. CLI 바이너리 빌드 & 서빙

대시보드가 `/releases/` 경로로 설치 스크립트와 바이너리를 제공합니다. Go 빌드 환경이 필요합니다.

```bash
cd zeude

# 전체 플랫폼 바이너리 빌드
for OS in darwin linux; do
  for ARCH in amd64 arm64; do
    echo -n "claude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/claude-$OS-$ARCH ./cmd/claude && echo "OK"
    echo -n "zeude-$OS-$ARCH... "
    GOOS=$OS GOARCH=$ARCH go build -o dashboard/public/releases/zeude-$OS-$ARCH ./cmd/zeude && echo "OK"
  done
done

# 설치 스크립트를 서버 URL로 교체
SERVER_URL=http://<서버IP>:3000
sed "s|https://your-dashboard-url|$SERVER_URL|g; s|https://your-otel-collector-url/|http://<서버IP>:4318/|g" \
  releases/install.sh > dashboard/public/releases/install.sh

# 대시보드 이미지 재빌드 (바이너리 포함)
cd ..
docker compose -f docker-compose.mac.yaml build dashboard
docker compose -f docker-compose.mac.yaml up -d dashboard
```

### 5. 대시보드 로그인

```bash
SERVER_URL=http://<서버IP>:3000

# 일회용 로그인 토큰 발급 (60초 유효)
OTT=$(curl -s -X POST "$SERVER_URL/api/auth/ott" \
  -H "Content-Type: application/json" \
  -d "{\"agentKey\": \"$AGENT_KEY\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "브라우저에서 열기: $SERVER_URL/api/auth/callback?ott=$OTT"
```

출력된 URL을 브라우저에서 열면 자동 로그인됩니다.

---

## 개발자 PC 설정

### zeude 플러그인 설치 (개발자별 1회)

```bash
# 서버 IP와 본인 agent key로 교체
curl -fsSL http://<서버IP>:3000/releases/install.sh | \
  ZEUDE_AGENT_KEY=zd_your_agent_key \
  ZEUDE_DASHBOARD_URL=http://<서버IP>:3000 \
  ZEUDE_ENDPOINT=http://<서버IP>:4318/ \
  bash

# 셸 재시작
source ~/.zshrc

# 설치 확인
which claude     # → ~/.zeude/bin/claude 이어야 함
zeude --version  # → 버전 출력
```

### telemetry 환경변수 설정 (shim이 alias로 우회되는 경우)

```bash
cat >> ~/.zshrc << 'EOF'
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://<서버IP>:4318/
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
EOF
source ~/.zshrc
```

### Claude Code에서 대시보드 열기

Claude Code 세션에서:
```
/zeude
```
자동으로 로그인 토큰을 발급받아 브라우저에서 대시보드가 열립니다.

---

## 데이터 수집 확인

Claude Code로 작업 후 몇 초 뒤에 확인:

```bash
# ClickHouse에 로그가 수집되는지 확인
curl -s "http://localhost:8123/?user=default&password=dev&query=SELECT+count(*)+FROM+zeude.claude_code_logs"

# OTel collector 실시간 수신 확인
docker logs -f zeude-otel-collector 2>&1 | grep -E "export|LogsExported"
```

---

## 포트 요약

| 서비스 | 포트 | 용도 |
|--------|------|------|
| Dashboard | 3000 | 웹 UI / API |
| OTel Collector HTTP | 4318 | Claude Code → 텔레메트리 수집 |
| OTel Collector gRPC | 4317 | 텔레메트리 수집 (gRPC) |
| ClickHouse HTTP | 8123 | 분석 쿼리 |
| PostgreSQL | 15432 | 메인 DB (호스트 노출) |

---

## 유저 관리

추가 유저는 대시보드의 **Admin → Users** 페이지에서 등록하거나, **Admin → Invites**에서 초대 링크를 생성해 전달할 수 있습니다.

각 개발자는 고유한 `agent_key`가 필요하며, 대시보드에서 유저 생성 시 자동으로 발급됩니다.
