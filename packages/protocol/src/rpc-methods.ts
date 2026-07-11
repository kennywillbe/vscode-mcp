import { RequestType } from 'vscode-jsonrpc';

import { IPC_METHODS } from './constants.js';
import type { IpcTransportErrorData } from './ipc-schemas.js';

/** Runtime validation remains mandatory; `unknown` prevents trusting decoded frames. */
export const HelloRequestType = new RequestType<
  unknown,
  unknown,
  IpcTransportErrorData
>(IPC_METHODS.hello);

/** Runtime validation remains mandatory; `unknown` prevents trusting decoded frames. */
export const CallToolRequestType = new RequestType<
  unknown,
  unknown,
  IpcTransportErrorData
>(IPC_METHODS.callTool);

/** Runtime validation remains mandatory; only a strict empty object is accepted. */
export const CloseSessionRequestType = new RequestType<
  unknown,
  unknown,
  IpcTransportErrorData
>(IPC_METHODS.closeSession);
