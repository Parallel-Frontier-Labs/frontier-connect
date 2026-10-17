// jsdom ships no types and this repo does not add @types/jsdom; the bundle test only needs this much.
declare module 'jsdom' {
  export class VirtualConsole {
    on(event: string, cb: (...args: any[]) => void): this;
  }
  export class JSDOM {
    constructor(html: string, options?: Record<string, unknown>);
    window: any;
  }
}
