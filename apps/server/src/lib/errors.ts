/**
 * An error whose message is safe to show to the user. Anything else that
 * reaches the error handler is logged and replaced with a generic message.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code?: string) => new AppError(400, message, code);
export const unauthorized = (message = 'Please log in to continue.') => new AppError(401, message, 'UNAUTHORIZED');
export const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Not found.') => new AppError(404, message, 'NOT_FOUND');
export const conflict = (message: string, code?: string) => new AppError(409, message, code);
