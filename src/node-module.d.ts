declare module "node:module" {
  export function createRequire(
    filename: string,
  ): (specifier: string) => unknown;
}
