import BoxConnection from "../box/BoxConnection.ts";
import {
  bytes2NumberSigned,
  bytes2NumberUnsigned,
  concat,
  delay,
  isZero,
  JSONValue,
  log,
  readBytes,
} from "../../util.ts";

import { RequestHandler } from "./types.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export enum RpcBodyType {
  binary = 0b00,
  utf8 = 0b01,
  json = 0b10,
}

export type Header = {
  partOfStream: boolean;
  endOrError: boolean;
  bodyType: RpcBodyType;
  bodyLength: number;
  requestNumber: number;
};

export class EndOfStream extends Error {
  constructor() {
    super("Stream ended");
  }
}

function parseHeader(
  header: Uint8Array,
): Header {
  const flags = header[0];
  const partOfStream = !!(flags & 0b1000);
  const endOrError = !!(flags & 0b100);
  const bodyType: RpcBodyType = flags & 0b11;
  const bodyLength = bytes2NumberUnsigned(header.subarray(1, 5));
  const requestNumber = bytes2NumberSigned(header.subarray(5));
  return { partOfStream, endOrError, bodyType, bodyLength, requestNumber };
}

/** parses a message according to bodyType */
const parse = (message: Uint8Array, bodyType: RpcBodyType) =>
  (bodyType === RpcBodyType.json
    ? JSON.parse(textDecoder.decode(message))
    : bodyType === RpcBodyType.utf8
    ? textDecoder.decode(message)
    : message) as JSONValue | Uint8Array;

let lastAnswer = Date.now();
let lastActivity = Date.now();

export default class RpcConnection {
  constructor(
    public boxConnection: BoxConnection,
    public requestHandler: RequestHandler,
    {
      answerTimeout = 300,
      activityTimeout = 60,
    }: {
      answerTimeout?: number;
      activityTimeout?: number;
    } = {},
  ) {
    this.requestCounter = 0;
    const monitorConnection = async () => {
      try {
        while (!this.boxConnection.closed) {
          const headerBytes = await readBytes(boxConnection, 9);
          lastActivity = Date.now();
          if (isZero(headerBytes)) {
            log.debug("They said godbye.");
            break;
          }
          const header = parseHeader(headerBytes);
          if (header.bodyLength === 0) {
            throw new Error("Got RPC message with lentgh 0.");
          }
          const body = await readBytes(boxConnection, header.bodyLength);
          lastActivity = Date.now();
          if (header.requestNumber < 0) {
            const listener = this.responseStreamListeners.get(
              -header.requestNumber,
            );
            if (!listener) {
              throw new Error(
                `Got request with unexpected number ${header.requestNumber}`,
              );
            }
            lastAnswer = Date.now();
            listener(body, header);
          } else {
            const parse = () => {
              const decoded = textDecoder.decode(body);
              try {
                return JSON.parse(decoded);
              } catch (error) {
                log.error(
                  `Parsing ${decoded} in request ${JSON.stringify(header)}`,
                );
                throw error;
              }
            };
            const request = parse();
            if (this.requestHandler) {
              if (request.type === "source") {
                const responseIterable = this.requestHandler
                  .handleSourceRequest(request.name, request.args);
                (async () => {
                  try {
                    for await (
                      const value of responseIterable
                    ) {
                      log.debug(() => `Sending back ${JSON.stringify(value)}`);
                      try {
                        await this.sendRpcMessage(value, {
                          isStream: true,
                          inReplyTo: header.requestNumber,
                        });
                      } catch (error) {
                        log.error(
                          `Error sending back response to request ${
                            JSON.stringify(request)
                          } by
                          ${this.boxConnection.peer}: ${error}`,
                        );
                      }
                    }
                    /*log.debug(
                      `Closing response stream to their request ${header.requestNumber}`,
                    );*/
                    await this.sendRpcMessage("true", {
                      isStream: true,
                      endOrError: true,
                      bodyType: RpcBodyType.json,
                      inReplyTo: header.requestNumber,
                    });
                  } catch (error) {
                    log.error(
                      `Error iterating on respone on ${request.name} (${
                        JSON.stringify(request.args)
                      }) request by ${this.boxConnection.peer}: ${error.stack}`,
                    );
                    return;
                  }
                })();
              } else {
                if (
                  header.endOrError && (textDecoder.decode(body) === "true")
                ) {
                  /*log.debug(
                    `Remote confirms closing of our response stream ${header.requestNumber}.`,
                  );*/
                } else {
                  log.info(
                    `Request type ${request.type} not yet supported. Ignoring request number ${header.requestNumber}: ${
                      textDecoder.decode(body)
                    }`,
                  );
                }
              }
            } else {
              log.info(
                `No handler to handle request number ${header.requestNumber}: ${
                  textDecoder.decode(body)
                }`,
              );
            }
          }
        }
      } catch (e) {
        if (boxConnection.closed) {
          log.info("Connection closed");
        } else {
          if ((e.name === "Interrupted") || (e.name === "ConnectionReset")) {
            // ignore
            log.info(`RPCConnection ${e.name}`);
          } else {
            throw e;
          }
        }
      }
    };
    (async () => {
      try {
        await monitorConnection();
      } catch (error) {
        log.warning(`Caught error monitoring RPC connection: ${error}`);
      }
    })();
    const checkTimeout = async () => {
      while (!this.boxConnection.closed) {
        await delay(500);
        const timeSinceRead = Date.now() - lastAnswer;
        if (timeSinceRead > answerTimeout * 1000) {
          log.info(
            `RPCConnection readTimeout: ${
              timeSinceRead /
              1000
            } seconds since last response was received.`,
          );
          this.boxConnection.close();
          break;
        }
        const timeSinceActivity = Date.now() - lastActivity;
        if (timeSinceActivity > activityTimeout * 1000) {
          log.info(
            `RPCConnection activityTimeout: ${
              timeSinceActivity /
              1000
            } seconds since last data was read.`,
          );
          this.boxConnection.close();
          break;
        }
      }
    };
    checkTimeout();
  }
  private responseStreamListeners: Map<
    number,
    ((message: Uint8Array, header: Header) => void)
  > = new Map();
  sendSourceRequest = async (request: {
    name: string[];
    args: unknown;
  }) => {
    const requestNumber = await this.sendRpcMessage({
      name: request.name,
      args: request.args,
      "type": "source",
    } as { [x: string]: JSONValue }, {
      bodyType: RpcBodyType.json,
      isStream: true,
    });
    const buffer: [Uint8Array, Header][] = [];
    const bufferer = (message: Uint8Array, header: Header) => {
      buffer.push([message, header]);
    };
    this.responseStreamListeners.set(requestNumber, bufferer);
    log.debug(
      `Ready to get response messages for ${request.name} nr ${requestNumber}`,
    );
    const responseStreamListeners = this.responseStreamListeners;
    const boxConnection = this.boxConnection;
    const generate = async function* () {
      try {
        while (true) {
          while (buffer.length > 0) {
            const [message, header] = buffer.shift() as [Uint8Array, Header];
            if (!header.endOrError) {
              yield parse(message, header.bodyType);
            } else {
              const endMessage = textDecoder.decode(message);
              if (endMessage === "true") {
                return;
              } else {
                throw new Error(endMessage);
              }
            }
          }
          yield await new Promise<
            JSONValue | Uint8Array
          >(
            (resolve, reject) => {
              responseStreamListeners.set(
                requestNumber,
                (message: Uint8Array, header: Header) => {
                  if (!header.endOrError) {
                    responseStreamListeners.set(requestNumber, bufferer);
                    resolve(parse(message, header.bodyType));
                  } else {
                    const endMessage = textDecoder.decode(message);
                    if (endMessage === "true") {
                      log.debug(
                        `Got end-message on response on ${request.name} by ${boxConnection.peer}`,
                      );
                      reject(new EndOfStream());
                    } else {
                      reject(
                        new Error(
                          `On connection with ${boxConnection.peer}: ${endMessage}`,
                        ),
                      );
                    }
                  }
                },
              );
            },
          );
        }
      } catch (error) {
        if (error instanceof EndOfStream) {
          return;
        } else {
          throw error;
        }
      }
    };
    return generate();
  };
  sendAsyncRequest = async (request: {
    name: string[];
    args: unknown;
  }) => {
    const requestNumber = await this.sendRpcMessage({
      name: request.name,
      args: request.args,
      "type": "async",
    } as { [x: string]: JSONValue }, {
      bodyType: RpcBodyType.json,
      isStream: false,
    });
    return new Promise((resolve, reject) => {
      this.responseStreamListeners.set(
        requestNumber,
        (message: Uint8Array, header: Header) => {
          this.responseStreamListeners.delete(requestNumber);
          if (!header.endOrError) {
            resolve(parse(message, header.bodyType));
          } else {
            reject(new Error(textDecoder.decode(message)));
          }
        },
      );
    });
  };
  private requestCounter;
  private sendRpcMessage = async (
    body: JSONValue | Uint8Array,
    options: {
      isStream?: boolean;
      endOrError?: boolean;
      bodyType?: RpcBodyType;
      inReplyTo?: number;
    } = {},
  ) => {
    function isUint8Array(
      v: JSONValue | Uint8Array,
    ): v is Uint8Array {
      return v?.constructor.prototype === Uint8Array.prototype;
    }
    function isString(
      v: JSONValue | Uint8Array,
    ): v is string {
      return v?.constructor.prototype === String.prototype;
    }
    const getPayload = () => {
      if (isUint8Array(body)) {
        if (!options.bodyType) options.bodyType = RpcBodyType.binary;
        return body;
      }
      if (isString(body)) {
        if (!options.bodyType) options.bodyType = RpcBodyType.utf8;
        return textEncoder.encode(body);
      }
      if (!options.bodyType) options.bodyType = RpcBodyType.json;
      return textEncoder.encode(JSON.stringify(body));
    };
    const payload: Uint8Array = getPayload();
    const flags = (options.isStream ? 0b1000 : 0) | (options.endOrError
      ? 0b100
      : 0) |
      options.bodyType!;
    const requestNumber = options.inReplyTo
      ? options.inReplyTo * -1
      : ++this.requestCounter;
    //log.debug(`Sending RPC Message ${requestNumber}`);
    const header = new Uint8Array(9);
    header[0] = flags;
    header.set(
      new Uint8Array(new Uint32Array([payload.length]).buffer).reverse(),
      1,
    );
    header.set(
      new Uint8Array(new Uint32Array([requestNumber]).buffer).reverse(),
      5,
    );
    //writing in one go, to ensure correct order
    const message = concat(header, payload);
    try {
      await this.boxConnection.write(message);
    } catch (error) {
      throw new Error(
        `Failed writing to boxConnection with ${this.boxConnection.peer}: ${error}.`,
      );
    }
    return requestNumber;
  };
}
