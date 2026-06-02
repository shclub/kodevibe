# Product Requirements Document — Zeude

## 1. Overview

Zeude는 AI 코딩 도구(Claude Code, Copilot, OpenCode, Codex) 사용을 측정하고, Best Practice를 배포하며, 실시간으로 가이드하는 **엔터프라이즈 관리 플랫폼**이다.

세 개의 레이어로 구성된다:
- **Sensing**: OTel 기반 사용 측정 및 분석
- **Delivery**: 스킬/훅/MCP 서버 중앙 관리 및 자동 배포
- **Guidance**: 컨텍스트 기반 실시간 스킬 제안

---

## 2. Personas

### P1. 팀 관리자 (Admin)
- **목표**: 팀의 AI 도구 채택률을 높이고, 성과를 경영진에게 보고
- **Pain Point**: 누가 어떻게 쓰는지 모른다. 설정을 개인별로 배포하기 어렵다.
- **사용 패턴**: 주 1~2회 대시보드 확인, 신규 스킬/훅 등록, 팀원 초대

### P2. 개발자 (Member)
- **목표**: AI 도구로 업무 생산성 향상, 내 사용 패턴 이해
- **Pain Point**: 어떤 스킬이 있는지 모른다. 지금 상황에 맞는 명령을 찾기 어렵다.
- **사용 패턴**: 매일 Claude Code 사용, 가끔 대시보드에서 세션/비용 확인

---

## 3. Feature Epics

---

### Epic 1. Sensing — 사용 측정 & 분석

#### F1.1 세션 추적
- Claude Code 세션을 OTel로 수집 (`claude_code_logs` ClickHouse 테이블)
- 세션 ID, 사용자 ID, 서비스 이름(claude/copilot/opencode/codex)으로 식별
- **AC**: 세션 시작부터 종료까지 이벤트 순서대로 기록, 5초 타임아웃 내 전송

#### F1.2 토큰/비용 분석
- 입력/출력/캐시 토큰 집계
- 모델별 단가 테이블(`pricing_model`)로 USD 비용 자동 계산
- **AC**: claude-sonnet, claude-opus, gpt-4.1 등 주요 모델 단가 최신화

#### F1.3 프롬프트 분석
- 모든 프롬프트를 `ai_prompts` 테이블에 저장
- 프롬프트 타입 자동 분류: `natural` / `skill` / `command` / `agent` / `mcp_tool`
- 프로젝트 경로(cwd) 기반 프로젝트별 집계
- **AC**: `/skill-name` 패턴 자동 감지, builtin 명령 분리

#### F1.4 Frustration 분석
- 좌절 패턴 키워드 감지 ("다시 해", "아니", "retry again" 등)
- 세션별 frustration score, density 계산
- **AC**: `frustration_analysis` MV에서 daily 집계, 고좌절 세션 식별

#### F1.5 멀티 소스 지원
- Claude Code, GitHub Copilot, OpenCode, Codex 통합 수집
- `ServiceName` 기반 소스 식별 및 필터링
- **AC**: 소스 선택 드롭다운으로 도구별 분리 조회 가능

---

### Epic 2. Delivery — 구성 관리 & 자동 배포

#### F2.1 스킬 관리
- 어드민이 Skill(재사용 가능한 프롬프트/워크플로우) 생성/편집/삭제
- 팀 단위 또는 전체 공개(`is_global`) 설정
- 파일 첨부 지원 (`files` JSONB: `{"SKILL.md": "...", "docs/ref.md": "..."}`)
- **AC**: 스킬 저장 시 `slug` 자동 생성, 중복 slug 방지

#### F2.2 훅 관리
- Claude Code Hook 이벤트 지원: `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop`
- Bash / Python / Node 스크립트 타입 지원
- 팀/전체 단위 배포
- **AC**: 스크립트 내용 저장, 팀 할당, 활성/비활성 상태 관리

#### F2.3 MCP 서버 관리
- MCP 서버 중앙 등록 (name, command, args, env, teams)
- 팀별 또는 전체 공개 설정
- **AC**: 등록된 MCP 서버가 `~/.claude/mcp_servers.json`에 자동 동기화

#### F2.4 자동 동기화 (Shim)
- `claude` 실행 시 zeude shim이 100ms 이내 캐시 기반 빠른 동기화
- 백그라운드 프로세스에서 전체 동기화 (네트워크 포함)
- `~/.claude/hooks/`, `~/.claude/skills/`, `~/.claude/skill-rules.json` 자동 갱신
- **AC**: 캐시 히트 시 추가 지연 없음, 네트워크 실패 시 캐시 fallback

#### F2.5 CLI 자동 업데이트
- 신규 버전 릴리즈 감지 및 자동 다운로드
- 백그라운드 업데이트로 사용자 세션 중단 없음
- **AC**: 버전 확인 후 다운로드, 서명 검증, 기존 바이너리 교체

---

### Epic 3. Guidance — 컨텍스트 기반 스킬 제안

#### F3.1 키워드 매칭 엔진
- 2-Tier 키워드 매칭:
  - Primary keyword: 단독으로 트리거
  - Secondary keyword: 2개 이상 일치 시 트리거
- `UserPromptSubmit` Hook에서 실행
- **AC**: 키워드 매칭 결과를 `skill_suggestions` 테이블에 기록

#### F3.2 스킬 자동 실행
- 매칭 신뢰도가 임계값 이상이면 스킬 자동 실행 (`auto_executed: true`)
- **AC**: auto-execute 여부, 선택된 스킬명 기록

#### F3.3 스킬 제안 통계
- 제안된 스킬별 클릭률, 자동 실행률 분석
- **AC**: 어드민 Analytics 화면에서 제안 효과 추적 가능

---

### Epic 4. 대시보드 — 인사이트 & 관리

#### F4.1 개인 대시보드
- 오늘/주간 토큰 사용량, 비용, 세션 수
- 최근 세션 목록 (시간, 비용, 소스 필터)
- 세션 상세: Turn별 대화 흐름, 모델 사용 내역, Tool 사용 현황
- **AC**: 세션 Turn 그루핑이 `prompt_id` 기반으로 정확히 표시

#### F4.2 프롬프트 히스토리
- 최근 프롬프트 목록 (키워드 검색, 소스 필터)
- 프롬프트 타입 분포 차트 (natural/skill/command)
- 프로젝트별 사용 통계
- **AC**: 30초 캐시, 키워드 ILIKE 검색 지원

#### F4.3 어드민 Analytics
- 팀별 활성 사용자, 토큰 트렌드
- Skill 채택률 (skill_users / total_users)
- Skill 사용 추이 (일별)
- Frustration 분석
- **AC**: 팀 선택 드롭다운, 날짜 범위 필터

#### F4.4 사용자 관리
- 사용자 초대 (이메일 기반 invite link)
- 팀 할당, 역할(admin/member) 변경
- 스킬 개별 비활성화 (`disabled_skills`)
- **AC**: invite 링크 만료 시간 설정, 사용 여부 추적

---

### Epic 5. 리더보드 & 코호트

#### F5.1 주간 리더보드
- 매주 월요일 08:00 KST 리셋
- 토큰 사용량 기준 개인/팀 랭킹
- 이전 주 대비 변동 표시
- **AC**: KST 기준 주간 윈도우 계산 정확도

#### F5.2 스킬 리더보드
- 주간 스킬 사용 Top 목록
- **AC**: skill 타입 프롬프트만 집계

#### F5.3 코호트 리더보드
- 어드민이 `cohortKey`로 특정 사용자 그룹 생성
- 코호트 등록 시점부터 누적 토큰 집계
- `/leaderboard?cohort=<key>` URL로 공유 가능
- **AC**: 코호트 멤버만 필터링, 시작 시점 기준 집계

---

## 4. Non-Functional Requirements

| 항목 | 요구사항 |
|------|---------|
| **성능** | Shim exec 지연 < 100ms (캐시 히트 기준) |
| **가용성** | 쉬폼 실패 시 Claude Code 동작에 영향 없음 (fail-open) |
| **보안** | Agent Key 기반 인증, SQL Injection 방지, API Key 환경변수 주입 차단 |
| **개인정보** | 프롬프트 본문 opt-in 수집 (`OTEL_LOG_USER_PROMPTS=1` 설정 필요) |
| **확장성** | ClickHouse 파티셔닝 (일별), TTL 180일 자동 삭제 |
| **플랫폼** | macOS (Intel/Apple Silicon), Linux (x86_64/arm64) |
| **멀티도구** | Claude Code, Copilot, OpenCode, Codex 동시 지원 |

---

## 5. 향후 고려 사항 (Backlog)

- `agent` / `mcp_tool` 타입 실시간 수집 (현재 스키마만 준비됨)
- ClickHouse JOIN 또는 MV 기반 agent 사용 감지 자동화
- Frustration 분석 기반 AI 코칭 제안
- Git / PR 연동으로 코드 품질과 AI 사용 상관관계 분석
- Bedrock 사용자 완전 지원 (이메일 없는 경우 user_id만으로 전체 기능 동작)
