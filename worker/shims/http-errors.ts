/**
 * Minimal http-errors replacement for the Workers build (the real package
 * pulls in Node's `util`). Same call shapes used by the codebase:
 *   createHttpError(503, 'message')
 *   createHttpError.ServiceUnavailable('message')
 */

export class HttpError extends Error {
  status: number;
  statusCode: number;
  expose: boolean;

  constructor(status: number, message?: string) {
    super(message ?? String(status));
    this.name = 'HttpError';
    this.status = status;
    this.statusCode = status;
    this.expose = status < 500;
  }
}

const STATUS_NAMES: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  408: 'RequestTimeout',
  409: 'Conflict',
  429: 'TooManyRequests',
  500: 'InternalServerError',
  502: 'BadGateway',
  503: 'ServiceUnavailable',
  504: 'GatewayTimeout',
};

type Factory = ((status: number, message?: string) => HttpError) &
  Record<string, (message?: string) => HttpError>;

const createHttpError = ((status: number, message?: string) => new HttpError(status, message)) as Factory;

for (const [code, name] of Object.entries(STATUS_NAMES)) {
  createHttpError[name] = (message?: string) => new HttpError(Number(code), message);
}

export default createHttpError;
