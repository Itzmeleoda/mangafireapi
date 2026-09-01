/**
 * Build-time shim for the `axios` package (Workers have no Node http).
 * Only the pieces the parsers use are provided. Actual HTTP goes through
 * src/utils/fetchClient.ts, which build.mjs aliases in place of axiosClient.
 */

export class AxiosError extends Error {
  code?: string;
  status?: number;
  response?: { status?: number; statusText?: string; data?: unknown; headers?: unknown };
  config?: unknown;
  isAxiosError = true;

  constructor(message?: string, code?: string, config?: unknown, request?: unknown, response?: AxiosError['response']) {
    super(message);
    this.name = 'AxiosError';
    this.code = code;
    this.config = config;
    if (response) {
      this.response = response;
      this.status = response.status;
    }
  }

  static isAxiosError(payload: unknown): payload is AxiosError {
    return payload instanceof AxiosError || (typeof payload === 'object' && payload !== null && (payload as AxiosError).isAxiosError === true);
  }
}

function notAvailable(): never {
  throw new AxiosError('axios is not available in the Workers build — HTTP goes through fetchClient', 'ERR_WORKERS_SHIM');
}

const axiosShim = {
  get: notAvailable,
  post: notAvailable,
  request: notAvailable,
  create: notAvailable,
  isAxiosError: AxiosError.isAxiosError,
  AxiosError,
};

export default axiosShim;
