# Zeude 새 PC 데이터 수집 설정 가이드

> Portal(대시보드)은 기존 서버를 그대로 사용하고,  
> 새 PC에서 데이터 수집(shim)만 설정하는 가이드입니다.

---

## 아키텍처

```
새 PC                            기존 서버
─────────────                   ──────────────────────────────────
claude (zeude shim)  ──OTEL──▶  OTel Collector :4318
copilot (zeude shim) ──OTEL──▶         │
opencode (zeude shim) ─OTEL──▶         ▼
                               ClickHouse (분석 DB)
                               Dashboard :3000 (웹 UI) ← 기존 유지
```

---

## Step 1. Agent Key 발급

기존 Portal에서 새 PC 사용자의 agent key를 발급합니다.

1. 브라우저에서 `http://<서버IP>:3000` 접속
2. **Admin → Users** → 새 유저 생성 → agent key 자동 발급
3. 또는 기존 본인 agent key 재사용 가능 (`~/.zeude/credentials` 확인)

---

## Step 2. Zeude Shim 설치

새 PC의 터미널에서 실행합니다.

```bash
# ⚠️ 아래 값을 실제 값으로 교체하세요
SERVER_IP="<서버IP>"          # 예: 192.168.1.100
AGENT_KEY="zd_your_key_here"  # 예: zd_804f85c69c16b9...

curl -fsSL "http://$SERVER_IP:3000/releases/install.sh" | \
  ZEUDE_AGENT_KEY="$AGENT_KEY" \
  ZEUDE_DASHBOARD_URL="http://$SERVER_IP:3000" \
  ZEUDE_ENDPOINT="http://$SERVER_IP:4318/" \
  bash
```

설치 완료 후 셸 재시작:

```bash
source ~/.zshrc   # zsh 사용 시
# 또는
source ~/.bashrc  # bash 사용 시
```

이 스크립트가 자동으로 처리하는 것:
- `~/.zeude/bin/claude` 설치 및 PATH 등록
- `~/.zeude/credentials` 에 agent key 저장
- `~/.zeude/config` 에 endpoint + dashboard URL 저장

---

## Step 3. copilot / opencode Shim 추가 (선택)

install.sh는 `claude`만 설치합니다.  
copilot이나 opencode도 추적하려면 추가로 다운로드합니다.

```bash
# 플랫폼 선택 (해당하는 것으로 변경)
# darwin-arm64  → Mac M1/M2/M3
# darwin-amd64  → Mac Intel
# linux-arm64   → Linux ARM
# linux-amd64   → Linux x86_64
PLATFORM="darwin-arm64"
SERVER="http://<서버IP>:3000"

# copilot shim 설치
curl -fsSL "$SERVER/releases/copilot-$PLATFORM" \
  -o ~/.zeude/bin/copilot && chmod +x ~/.zeude/bin/copilot

# opencode shim 설치
curl -fsSL "$SERVER/releases/opencode-$PLATFORM" \
  -o ~/.zeude/bin/opencode && chmod +x ~/.zeude/bin/opencode
```

---

## Step 4. 설치 확인

```bash
# shim이 PATH 앞에 등록되어 있는지 확인
which claude       # → /Users/<you>/.zeude/bin/claude 여야 함
which copilot      # → /Users/<you>/.zeude/bin/copilot 여야 함
which opencode     # → /Users/<you>/.zeude/bin/opencode 여야 함

# 진단 도구 실행
zeude --version

# claude 실행 시 배너 확인
claude
# → [zeude] Ready! Hi <name> (claude) 가 나오면 정상
```

---

## 설정 파일 정리

| 파일 | 용도 | 예시 |
|------|------|------|
| `~/.zeude/credentials` | Agent key 저장 | `agent_key=zd_xxxx` |
| `~/.zeude/config` | Endpoint / Dashboard URL | `endpoint=http://서버IP:4318/`<br>`dashboard_url=http://서버IP:3000` |

### 수동으로 설정하는 경우

```bash
# credentials 파일
echo "agent_key=zd_your_key_here" > ~/.zeude/credentials
chmod 600 ~/.zeude/credentials

# config 파일
cat > ~/.zeude/config << EOF
endpoint=http://<서버IP>:4318/
dashboard_url=http://<서버IP>:3000
EOF
```

---

## 환경변수로 설정 (옵션)

shim이 alias 등으로 우회되는 경우 Claude Code 자체 텔레메트리도 활성화합니다.

```bash
cat >> ~/.zshrc << 'EOF'

# Zeude telemetry
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://<서버IP>:4318/
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_TRACES_EXPORTER=otlp
EOF

source ~/.zshrc
```

---

## 데이터 수집 확인

새 PC에서 claude 등을 사용한 뒤 몇 초 후:

```bash
# OTel Collector 수신 로그 확인 (서버에서 실행)
docker logs -f zeude-otel-collector 2>&1 | grep -E "export|Logs"

# ClickHouse에 데이터가 쌓이는지 확인 (서버에서 실행)
curl -s "http://localhost:8123/?user=default&password=dev&query=SELECT+count(*)+FROM+claude_code_logs"
```

---

## 포트 요약

| 서비스 | 포트 | 용도 |
|--------|------|------|
| Dashboard | 3000 | 웹 UI / API |
| OTel Collector HTTP | 4318 | 텔레메트리 수신 |
| OTel Collector gRPC | 4317 | 텔레메트리 수신 (gRPC) |
| ClickHouse HTTP | 8123 | 분석 쿼리 (서버 내부) |
| PostgreSQL | 15432 | 메인 DB (서버 내부) |

> 새 PC → 서버 방향으로 **3000** (API), **4318** (OTel) 포트가 열려 있어야 합니다.

---

## 문제 해결

### 배너가 안 나올 때
```bash
# shim이 올바른 경로인지 확인
which claude

# PATH 순서 확인 (~/.zeude/bin 이 앞에 있어야 함)
echo $PATH | tr ':' '\n' | head -5
```

### 텔레메트리가 안 쌓일 때
```bash
# agent key 확인
cat ~/.zeude/credentials

# endpoint 확인
cat ~/.zeude/config

# 서버 연결 테스트
curl -v http://<서버IP>:4318/v1/logs
```
