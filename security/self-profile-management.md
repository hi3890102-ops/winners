# 본인 관리 개인정보 (2026-09-20)

직원·매니저가 이름·연락처·은행·계좌번호·예금주를 본인이 관리하고, 연결된 승인 매장이 그 정보를 가져갑니다.

## 서버 (security/self-profile-management.sql, 추가 전용)
- `private.staff_self_profiles`: 본인 기본정보(모두 선택 입력) + 개정 번호. `private.profile_change_events`: 사장님 안내용(항목 이름·시각만, 값 없음). `private.profile_prior_values`: 매장 값이 본인 값으로 바뀌기 전의 원래 값(클라이언트 접근 불가, 복구용).
- RPC: `manee_my_profile_state(p_reveal)` (본인 멤버십으로 연결된 crew 행만; 기본은 계좌 마스킹, 수정 화면에서만 원본), `manee_save_my_profile(profile, expected_revision)` (본인만, 충돌은 SQLSTATE PT409 = HTTP 409; 40001은 게이트웨이가 재시도해 504가 되므로 사용 금지), `manee_owner_profile_changes(store_id)` (해당 매장 사장님만).
- 트리거 `manee_guard_self_managed_crew`: 본인 관리(self_service_profile=true) 직원의 이름·전화·계좌 문자열은 API(authenticated)로 매장이 바꿀 수 없음. 시급·근무조건·수습·입사일·공제·직급·권한·메모는 그대로 매장 관리. 플래그를 API로 되돌릴 수도 없음.
- 저장 시: 본인의 활성 멤버십 crew 행에만 반영, 비어 있는 항목은 매장 값을 지우지 않음. 승인(approve / approve_new) 시 본인 정보가 있으면 새 매장이 가져감(포털 래퍼 확장).
- 롤백(self-profile-management-rollback.sql): RPC 회수, 트리거 제거, 래퍼 원복. 표와 값은 삭제하지 않음.

## 화면
- 내 개인정보(조회, 계좌 마스킹, 미입력/조회 실패 구분) → 내 정보 수정(기존 매장 값 제안, 매장 간 충돌은 직접 선택, 나눌 수 없는 계좌 원문은 그대로 보여 주고 추측하지 않음) → 변경 내용·반영 매장 확인 → 저장 → 매장별 결과.
- 사장님 직원 관리: "직원이 직접 수정한 정보" 안내와 "본인 관리" 표시.
