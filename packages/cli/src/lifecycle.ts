export function shouldExitAfterMain(argv: string[] = process.argv): boolean {
  return !argv.includes("--mcp");
}
