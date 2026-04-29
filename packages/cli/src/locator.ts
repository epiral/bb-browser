export function parseLocatorInput(locator: string): string {
  if (locator.startsWith("@@")) {
    return locator;
  }
  if (locator.startsWith("@")) {
    return locator.slice(1);
  }
  return locator;
}

export function formatLocatorOutput(locator: string): string {
  if (locator.startsWith("@@")) {
    return locator;
  }
  if (locator.startsWith("@")) {
    return locator;
  }
  return `@${locator}`;
}
