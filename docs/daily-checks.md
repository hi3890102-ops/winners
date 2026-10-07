# 매니 정기 자동검사

설정일: 2026-10-07. 모든 시각은 한국시간(Asia/Seoul) 기준이다.

| 대상 | 워크플로 | 예약 시각 |
| --- | --- | --- |
| 사장님·직원 앱 | `hi3890102-ops/winners` / `.github/workflows/finalize-store-code.yml` | 매일 07:17 |
| 본사·프랜차이즈 관리자 웹 | `hi3890102-ops/manee-admin` / `.github/workflows/verify-admin.yml` | 매일 07:27 |

두 워크플로 모두 main을 대상으로 하는 PR, main 변경, 수동 실행에서도 작동한다. 기존 앱의 security-v2 push 검사도 유지한다. PR 검사 성공은 배포 전 검증이며 main push 검사는 반영 후 재확인이다. 이 변경은 브랜치 보호 규칙이나 Netlify 배포 차단 규칙을 새로 설정하지 않는다.

## 검사 범위

- 앱: 기존 기능·보안 회귀검사 전체, 실제 PostgreSQL의 매장코드·직원 승인·출퇴근 동시 요청 검사, 스테이징·운영 빌드.
- 관리자: 문의·답변·가맹 편입·계정 상태 변경의 중복 처리와 지연 응답, 재무 화면 검증, 스테이징 및 본사·프랜차이즈 운영 빌드.
- 운영 사이트: HTML 식별·인라인 JavaScript 구문·운영 인증 활성화, app-config의 운영 프로젝트·접속 설정·포털 구분, manifest·서비스워커 조회.
- 앱 보고서: 지출·월말보고서용 코드, PDF 라이브러리, 한글 폰트 및 기본 CSS 제공 여부.
- 운영 조회는 인증정보 없는 GET만 사용한다. 페이지 JavaScript를 실행하거나 업무 API를 호출하지 않는다. 오류 시 1회 재시도하며 계속 실패하면 해당 작업을 실패로 남긴다.
- 업무 입력 검사는 가상 데이터와 CI 내 폐기 가능한 PostgreSQL에서 수행한다. 실제 매장 기록 입력, 알림 발송, 운영 DB 변경은 없다.

운영 사이트 확인은 공개 배포 파일 검사이며 로그인 후 화면 조작·운영 DB 상태·실제 GPS·카메라·다운로드 성공을 보장하지 않는다. Android/iPhone 실기기 확인과 상시 오류·지연 감시는 별도 범위다. 외부 CDN 가용성과 관리자 PWA 설치 아이콘은 이 검사에 포함되지 않는다.

## 결과 및 실패 확인

- GitHub Actions의 각 실행에서 성공·실패, 실패한 검사와 로그를 확인한다.
- 운영 사이트 결과는 작업 요약과 `monitoring-results.json`에 남는다. 검사 로그와 결과 파일은 실행별 14일 보관한다.
- ChatGPT의 별도 정기 확인은 두 저장소의 최신 main 검사 결과와 예약 실행 누락을 읽고 문제가 있을 때 사용자에게 알리도록 설정한다. 계정 연결이 끊겨 확인하지 못한 경우를 정상으로 간주하지 않는다.
- 예약은 GitHub Actions에서 실행되므로 PC나 대화창을 켜둘 필요가 없다.
- GitHub 예약 실행은 정각 보장이 없고 지연·누락이 가능하다. 공개 저장소는 활동이 60일 없으면 예약이 비활성화될 수 있으므로, 결과 확인에서 마지막 실행 시각도 확인한다.

수동 재실행: GitHub 저장소 → Actions → 해당 워크플로 → Run workflow → main.

근거: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
