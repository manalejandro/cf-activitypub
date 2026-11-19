/// <reference types="@webgpu/types" />

// WebGPU is not in TypeScript's `lib.dom` yet; the GPU layer of
// `components/FieldBackground.tsx` needs `navigator.gpu`, `GPUDevice` and the
// buffer/texture usage constants. The reference is scoped to the app tsconfig
// (`tsconfig.worker.json` does not include this file) because workerd has no
// WebGPU.
export {};
