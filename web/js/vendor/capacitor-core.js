// Stand-in for '@capacitor/core' when the app runs in a plain browser (preview / tests). The real package is
// bundled into the Android build, where it talks to the native side.
export const Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => 'web',
  convertFileSrc: (url) => url,
};

export function registerPlugin(name) {
  return new Proxy({}, {
    get(_, method) {
      if (method === 'then') return undefined;  // never mistaken for a promise
      return async () => { throw new Error(`${name}.${String(method)}: 브라우저에서는 쓸 수 없습니다.`); };
    },
  });
}

export const CapacitorHttp = {
  request: async () => { throw new Error('CapacitorHttp: 브라우저에서는 쓸 수 없습니다.'); },
};
