/**
 * Minimal type declarations for qrcode-terminal, which ships none.
 *
 * Without this the module can only be pulled in via require(), which the
 * lint rule @typescript-eslint/no-require-imports forbids.
 */
declare module 'qrcode-terminal' {
  export interface GenerateOptions {
    small?: boolean;
  }

  export function generate(
    text: string,
    options?: GenerateOptions,
    callback?: (qrcode: string) => void
  ): void;

  export function setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;

  const qrcode: {
    generate: typeof generate;
    setErrorLevel: typeof setErrorLevel;
  };

  export default qrcode;
}
