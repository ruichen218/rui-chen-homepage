// Workerd treats named exports as Worker entrypoints. Keep test helpers in the
// implementation module and expose only the actual handler from this entry.
export { default } from './index.js';
