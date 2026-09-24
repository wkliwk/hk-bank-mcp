/**
 * Server identity. Kept separate from index.ts so tests can assert on it
 * without spawning a transport.
 */
export const SERVER_NAME = 'hkma-mcp' as const;
export const SERVER_VERSION = '0.1.0' as const;

export const SERVER_INSTRUCTIONS = `Hong Kong banking data from official public sources.

Use this server for questions about Hong Kong banks: where to find an ATM or
branch, current HIBOR and HKD interest rates, whether a bank or website is a
legitimate HKMA-authorised institution or a published scam, and which bank
hotline to call for a given purpose.

Every figure carries an "as_of" date. Report it to the user rather than
implying a value is current — some HKMA series lag by weeks. This server never
has access to a user's bank account, credentials, or balances; it reads only
published data and files the user supplies.`;
