// mongodb://user:password@host or mongodb+srv://user:password@host
const URI_CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi;

/** Removes credentials embedded in MongoDB connection strings. */
export function redact(text: string): string {
  return text.replace(URI_CREDENTIALS, '$1***:***@');
}

/** Logs an error (name, message, stack) with connection-string credentials removed. */
export function logError(context: string, error: unknown): void {
  const detail =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  console.error(`${context}: ${redact(detail)}`);
}
