# Project Brief — Zeude

## Problem Statement

조직이 Claude Code 같은 AI 코딩 도구에 투자해도 실제 채택률은 낮다. 이유는 세 가지다:

1. **Intention-Action Gap**: 무엇을 할 수 있는지 모른다 — 스킬, 훅, MCP 도구 등 고급 기능이 있어도 개발자는 기본 사용에 머문다.
2. **지식 사일로**: 파워 유저의 노하우가 팀 전체로 확산되지 않는다.
3. **가시성 부재**: 관리자 입장에서 누가 얼마나, 어떻게 쓰는지 측정할 수단이 없다.

> "Even with great AI tools, there's a huge **Intention-Action Gap** due to high learning curves."

---

## Vision

**"Measurement brings visibility, sharing drives adoption."**

측정 → 공유 → 채택의 선순환 구조를 만들어, 조직 전체를 AI Native로 전환한다.

---

## Target Users

### Primary: 개발팀 관리자 / AI 챔피언
- AI 도구 도입 성과를 수치로 보고해야 한다
- 팀 전체에 Best Practice를 배포하고 싶다
- 누가 AI를 잘 쓰는지, 어디서 막히는지 파악하고 싶다

### Secondary: 일반 개발자 (팀원)
- 지금 하는 일에 맞는 스킬/명령을 즉시 알고 싶다
- 별도 설정 없이 팀 표준 도구를 자동으로 받고 싶다
- 내 AI 사용 패턴과 비용을 대시보드에서 확인하고 싶다

---

## Key Objectives

| # | 목표 | 측정 지표 |
|---|------|----------|
| 1 | AI 도구 채택률 증가 | 주간 active user 비율 |
| 2 | 스킬/훅 배포 자동화 | 수동 설정 없이 동기화 성공률 |
| 3 | 실시간 컨텍스트 가이던스 | 스킬 제안 클릭률 |
| 4 | 사용 패턴 가시성 확보 | 세션/토큰/비용 추적 정확도 |
| 5 | 팀 간 Best Practice 공유 | 리더보드 참여율 |

---

## Success Metrics (실측 기준)

- AI Tool Adoption: **6% → 18% (3배)** — 강제 없이 데이터 기반 접근으로 달성
- 스킬 제안이 실행으로 이어진 비율 (auto-execute / suggestion ratio)
- 팀별 토큰 사용량, 비용, 세션 품질 추적

---

## Scope (In)

- Claude Code, GitHub Copilot, OpenCode, Codex 등 AI 코딩 도구 텔레메트리 수집
- 중앙화된 스킬 / 훅 / MCP 서버 관리 및 자동 배포
- 개인 / 팀 / 조직 단위 사용 분석 대시보드
- 리더보드 및 코호트 기반 그룹 경쟁
- 컨텍스트 기반 실시간 스킬 제안

## Scope (Out)

- Claude Code 자체 기능 수정
- 코드 생성 품질 자동 평가
- 외부 Git / CI 시스템과의 통합 (현재 없음)
- AI 코딩 도구 직접 과금 / 라이선스 관리

---

## Constraints

- **개인정보**: 프롬프트 본문은 opt-in 방식 — Claude Code는 기본적으로 `<REDACTED>` 처리
- **Zero-Friction 원칙**: 쉬폼은 claude 실행 경로에 100ms 이내 처리 후 exec
- **Multi-tool 지원**: Claude Code 외에도 Copilot, OpenCode, Codex를 단일 플랫폼에서 관리
- **Self-hosted 가능**: Supabase + ClickHouse + Docker 조합으로 온프레미스 배포 가능

---

## Stakeholders

| 역할 | 이름/조직 |
|------|----------|
| 개발사 | ZEP Co., Ltd. |
| 주요 연락 | jaegyu.lee@zep.us |
| 오픈소스 라이선스 | Apache 2.0 |
