declare module 'luxon' {
  export class DateTime {
    static fromFormat(s: string, fmt: string, opts: { zone: string }): DateTime;
    isValid: boolean;
    toUTC(): DateTime;
    toISO(): string | undefined;
  }
}
