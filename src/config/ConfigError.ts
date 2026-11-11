export interface ConfigIssue {
  /** Environment variable name, e.g. FRONTEND_URL. Never its value. */
  field: string;
  message: string;
}

/** Thrown by loadEnv() when environment variables are missing or invalid. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  ${issue.field}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
