import { Geolocation } from '@capacitor/geolocation';

// Keep the existing callback-based screens; request access only on user action.
window.MANEE_GEOLOCATION = {
  getCurrentPosition(success, failure, options = {}) {
    Geolocation.getCurrentPosition(options).then(success, error => {
      const code = String(error.code || '');
      failure?.({
        code: code === 'OS-PLUG-GLOC-0003' ? 1 : code === 'OS-PLUG-GLOC-0010' ? 3 : 2,
        message: error.message || '위치를 확인하지 못했습니다.',
      });
    });
  },
};
