declare module 'pino-roll' {
  import type { DestinationStream } from 'pino';

  interface PinoRollOptions {
    file: string | (() => string);
    size?: string | number;
    frequency?: 'daily' | 'hourly' | number;
    extension?: string;
    dateFormat?: string;
    mkdir?: boolean;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<DestinationStream & { end(): void }>;
}
