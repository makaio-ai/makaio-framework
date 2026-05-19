declare module 'bun:test' {
  interface Matchers<_T> {
    toHaveBeenCalledOnce(): void;
  }
}
