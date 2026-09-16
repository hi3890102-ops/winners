// Build-owned configuration; never accept environment selection from requests.
const deployment = require('./manee-environment.json');
exports.blockExternalService = () => {
  if (deployment.environment === 'production' && deployment.externalServicesEnabled === true) return null;
  return {
    statusCode: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error:'테스트 환경에서는 이 기능의 연결을 준비하고 있어요.', code:'staging_external_service_disabled' }),
  };
};
