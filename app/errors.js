/** Error with a machine-readable code. `code` doubles as the i18n key `error.<code>`. */
export class InstallError extends Error {
  constructor(code, params = {}, cause = undefined) {
    super(code);
    this.name = 'InstallError';
    this.code = code;
    this.params = params;
    if (cause !== undefined) this.cause = cause;
  }
}
